importScripts("storage.js", "stats.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "crf:sync-billing") {
    (async () => {
      const sync = await CRFStorage.syncBillingStatus();
      const access = await CRFStorage.getAccessState();
      sendResponse({ ok: true, sync, access });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  if (message?.type === "crf:save-review") {
    (async () => {
      await CRFStorage.syncBillingStatus();
      const access = await CRFStorage.getAccessState();
      const normalized = CRFStorage.normalizeGameSummary(message.payload);
      console.log("[CRF background] analysis complete", {
        userPlan: access.userPlan,
        hasProAccess: access.hasProAccess,
        ownerBypass: access.ownerBypass,
        gameId: normalized.gameId
      });

      if (access.hasProAccess) {
        await CRFStorage.saveGameSummary(normalized);
        const games = await CRFStorage.getStoredGames();
        console.log("[CRF background] stored games after save", games.length);
        sendResponse({
          ok: true,
          summary: CRFStats.buildPatternSummary(games)
        });
        return;
      }

      sendResponse({
        ok: true,
        summary: CRFStats.buildPatternSummary([normalized])
      });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  if (message?.type === "crf:get-patterns") {
    (async () => {
      await CRFStorage.syncBillingStatus();
      const access = await CRFStorage.getAccessState();
      if (!access.hasProAccess) {
        sendResponse({ ok: true, summary: null });
        return;
      }

      const games = await CRFStorage.getStoredGames();
      sendResponse({
        ok: true,
        summary: CRFStats.buildPatternSummary(games)
      });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  if (message?.type === "crf:get-access") {
    (async () => {
      const sync = await CRFStorage.syncBillingStatus();
      const access = await CRFStorage.getAccessState();
      console.log("[CRF background] access requested", {
        userPlan: access.userPlan,
        hasProAccess: access.hasProAccess,
        billingIdentity: access.billingIdentity || null,
        premiumUnlockLogicRan: true
      });
      sendResponse({ ok: true, access, sync });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  if (message?.type === "crf:open-upgrade") {
    (async () => {
      const opened = await CRFStorage.openUpgradeCheckout();
      sendResponse({ ok: opened });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  if (message?.type === "crf:open-profile") {
    (async () => {
      const access = await CRFStorage.getAccessState();
      if (!access.hasProAccess) {
        sendResponse({ ok: false, locked: true });
        return;
      }

      await chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  }

  return false;
});
