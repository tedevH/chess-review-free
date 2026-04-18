(function initStorageHelpers(global) {
  const GAMES_KEY = "games";
  const USER_PLAN_KEY = "userPlan";
  const OWNER_BYPASS_KEY = "ownerBypass";
  const STRIPE_PAYMENT_LINK_KEY = "stripePaymentLink";
  const BILLING_BASE_URL_KEY = "billingBaseUrl";
  const BILLING_IDENTITY_KEY = "billingIdentity";
  const DEFAULT_STRIPE_PAYMENT_LINK = "https://buy.stripe.com/test_9B6dR8eksabMekIa9Q8EM00";
  const MAX_GAMES = 50;
  const PHASES = ["opening", "middlegame", "endgame"];

  function normalizeCount(value) {
    const count = Number(value || 0);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  }

  function normalizeTagList(tags) {
    return Array.isArray(tags) ? [...new Set(tags.map(String).filter(Boolean))] : [];
  }

  function normalizePhaseBreakdown(phaseBreakdown) {
    const base = {
      opening: { mistakes: 0, blunders: 0, moves: 0 },
      middlegame: { mistakes: 0, blunders: 0, moves: 0 },
      endgame: { mistakes: 0, blunders: 0, moves: 0 }
    };

    for (const phase of PHASES) {
      base[phase] = {
        mistakes: normalizeCount(phaseBreakdown?.[phase]?.mistakes),
        blunders: normalizeCount(phaseBreakdown?.[phase]?.blunders),
        moves: normalizeCount(phaseBreakdown?.[phase]?.moves)
      };
    }

    return base;
  }

  function normalizeSummary(summary) {
    return {
      headline: String(summary?.headline || ""),
      lesson: String(summary?.lesson || ""),
      advice: String(summary?.advice || "")
    };
  }

  function normalizeGameSummary(summary) {
    return {
      gameId: String(summary?.gameId || ""),
      date: normalizeCount(summary?.date || Date.now()),
      result: summary?.result === "win" ? "win" : summary?.result === "loss" ? "loss" : "draw",
      color: summary?.color === "black" ? "black" : "white",
      opening: summary?.opening ? String(summary.opening) : null,
      blunders: normalizeCount(summary?.blunders),
      mistakes: normalizeCount(summary?.mistakes),
      inaccuracies: normalizeCount(summary?.inaccuracies),
      phaseBreakdown: normalizePhaseBreakdown(summary?.phaseBreakdown),
      mistakeTags: normalizeTagList(summary?.mistakeTags),
      goodTags: normalizeTagList(summary?.goodTags),
      primaryReason: String(summary?.primaryReason || ""),
      summary: normalizeSummary(summary?.summary)
    };
  }

  function isDevelopmentBuild() {
    try {
      return !chrome.runtime?.getManifest?.()?.update_url;
    } catch {
      return false;
    }
  }

  function getDefaultBillingBaseUrl() {
    return isDevelopmentBuild() ? "http://localhost:3000" : "";
  }

  function normalizeBaseUrl(value) {
    return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  }

  function generateBillingIdentity() {
    if (global.crypto?.randomUUID) {
      return global.crypto.randomUUID();
    }
    return `crf_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  }

  async function getBillingIdentity() {
    const data = await chrome.storage.local.get(BILLING_IDENTITY_KEY);
    if (typeof data?.billingIdentity === "string" && data.billingIdentity.trim()) {
      return data.billingIdentity.trim();
    }

    const billingIdentity = generateBillingIdentity();
    await chrome.storage.local.set({ [BILLING_IDENTITY_KEY]: billingIdentity });
    console.log("[CRF billing] generated billing identity", billingIdentity);
    return billingIdentity;
  }

  async function getBillingConfig() {
    const data = await chrome.storage.local.get(BILLING_BASE_URL_KEY);
    const billingBaseUrl = normalizeBaseUrl(data?.billingBaseUrl || getDefaultBillingBaseUrl());
    const billingIdentity = await getBillingIdentity();
    return {
      billingBaseUrl,
      billingIdentity
    };
  }

  async function syncBillingStatus() {
    const { billingBaseUrl, billingIdentity } = await getBillingConfig();
    if (!billingBaseUrl) {
      return { ok: false, skipped: true, reason: "no_billing_base_url" };
    }

    const endpoint = `${billingBaseUrl}/api/stripe/access?identity=${encodeURIComponent(billingIdentity)}`;
    console.log("[CRF billing] syncing access", { endpoint, billingIdentity });

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`billing access request failed with ${response.status}`);
      }

      const payload = await response.json();
      const userPlan = payload?.active ? "pro" : "free";
      await chrome.storage.local.set({ [USER_PLAN_KEY]: userPlan });

      console.log("[CRF billing] sync result", {
        billingIdentity,
        userPlan,
        active: Boolean(payload?.active),
        subscriptionStatus: payload?.subscriptionStatus || null,
        premiumUnlockLogicRan: true
      });

      return {
        ok: true,
        active: Boolean(payload?.active),
        userPlan,
        billingIdentity,
        subscriptionStatus: payload?.subscriptionStatus || null,
        payload
      };
    } catch (error) {
      console.warn("[CRF billing] sync failed", {
        billingIdentity,
        endpoint,
        error: error?.message || String(error)
      });
      return {
        ok: false,
        billingIdentity,
        error: error?.message || String(error)
      };
    }
  }

  async function getAccessState() {
    const data = await chrome.storage.local.get([
      USER_PLAN_KEY,
      OWNER_BYPASS_KEY,
      STRIPE_PAYMENT_LINK_KEY,
      BILLING_BASE_URL_KEY,
      BILLING_IDENTITY_KEY
    ]);
    const userPlan = data?.userPlan === "pro" ? "pro" : "free";
    const ownerBypass = isDevelopmentBuild() && data?.ownerBypass !== false;
    const hasProAccess = userPlan === "pro" || ownerBypass;
    const upgradeUrl =
      typeof data?.stripePaymentLink === "string" && data.stripePaymentLink.trim()
        ? data.stripePaymentLink.trim()
        : DEFAULT_STRIPE_PAYMENT_LINK;
    const billingBaseUrl = normalizeBaseUrl(data?.billingBaseUrl || getDefaultBillingBaseUrl());
    const billingIdentity =
      typeof data?.billingIdentity === "string" && data.billingIdentity.trim()
        ? data.billingIdentity.trim()
        : null;

    return {
      userPlan,
      ownerBypass,
      hasProAccess,
      upgradeUrl,
      billingBaseUrl,
      billingIdentity,
      isDevelopmentBuild: isDevelopmentBuild()
    };
  }

  async function getUserPlan() {
    const access = await getAccessState();
    return access.hasProAccess ? "pro" : "free";
  }

  async function openUpgradeCheckout() {
    const access = await getAccessState();
    const billingIdentity = access.billingIdentity || (await getBillingIdentity());
    let localCheckoutUrl = null;
    if (access.billingBaseUrl) {
      try {
        const configResponse = await fetch(`${access.billingBaseUrl}/api/stripe/config`, {
          method: "GET",
          cache: "no-store"
        });
        if (configResponse.ok) {
          localCheckoutUrl = `${access.billingBaseUrl}/api/stripe/checkout?identity=${encodeURIComponent(billingIdentity)}&source=extension`;
        }
      } catch (error) {
        console.warn("[CRF billing] local Stripe server unavailable, using fallback link", {
          billingBaseUrl: access.billingBaseUrl,
          error: error?.message || String(error)
        });
      }
    }
    const targetUrl = localCheckoutUrl || access.upgradeUrl;

    console.log("[CRF billing] opening checkout", {
      targetUrl,
      billingIdentity,
      usingLocalServer: Boolean(localCheckoutUrl)
    });

    if (!targetUrl) {
      return false;
    }

    if (chrome.tabs?.create) {
      await chrome.tabs.create({ url: targetUrl });
      return true;
    }

    if (typeof global.open === "function") {
      global.open(targetUrl, "_blank", "noopener,noreferrer");
      return true;
    }

    return false;
  }

  async function getStoredGames() {
    try {
      const data = await chrome.storage.local.get(GAMES_KEY);
      const games = Array.isArray(data?.games) ? data.games.map(normalizeGameSummary) : [];
      console.log("[CRF storage] loaded games", games.length);
      return games;
    } catch (error) {
      console.error("[CRF storage] failed to load games", error);
      return [];
    }
  }

  async function getGameById(gameId) {
    const games = await getStoredGames();
    return games.find((game) => game.gameId === String(gameId)) || null;
  }

  async function removeDuplicateGames(games) {
    const seen = new Set();
    return games.filter((game) => {
      const key = String(game?.gameId || "");
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async function trimGamesToLimit(games, limit = MAX_GAMES) {
    return [...games]
      .sort((a, b) => b.date - a.date)
      .slice(0, limit);
  }

  async function deleteOldGamesIfNeeded(games) {
    return trimGamesToLimit(games, MAX_GAMES);
  }

  async function saveGameSummary(summary) {
    try {
      const userPlan = await getUserPlan();
      console.log("[CRF storage] saveGameSummary called", {
        userPlan,
        gameId: summary?.gameId
      });

      if (userPlan !== "pro") {
        console.log("[CRF storage] skipping save on free plan");
        return false;
      }

      const normalized = normalizeGameSummary(summary);
      if (!normalized.gameId) {
        console.warn("[CRF storage] missing gameId, skipping save");
        return false;
      }

      const existingGames = await getStoredGames();
      const withoutDuplicate = existingGames.filter((game) => game.gameId !== normalized.gameId);
      const deduped = await removeDuplicateGames([normalized, ...withoutDuplicate]);
      const trimmed = await trimGamesToLimit(deduped, MAX_GAMES);

      await chrome.storage.local.set({ [GAMES_KEY]: trimmed });

      const verify = await chrome.storage.local.get(GAMES_KEY);
      const storedGames = Array.isArray(verify?.games) ? verify.games : [];
      console.log("[CRF storage] saved game", {
        gameId: normalized.gameId,
        totalGames: storedGames.length,
        newestGameId: storedGames[0]?.gameId || null
      });

      return true;
    } catch (error) {
      console.error("[CRF storage] save failed", error);
      return false;
    }
  }

  global.CRFStorage = {
    GAMES_KEY,
    USER_PLAN_KEY,
    OWNER_BYPASS_KEY,
    STRIPE_PAYMENT_LINK_KEY,
    BILLING_BASE_URL_KEY,
    BILLING_IDENTITY_KEY,
    DEFAULT_STRIPE_PAYMENT_LINK,
    MAX_GAMES,
    getAccessState,
    getUserPlan,
    getBillingIdentity,
    getBillingConfig,
    syncBillingStatus,
    getStoredGames,
    getGameById,
    openUpgradeCheckout,
    saveGameSummary,
    removeDuplicateGames,
    trimGamesToLimit,
    deleteOldGamesIfNeeded,
    normalizeGameSummary
  };
})(self);
