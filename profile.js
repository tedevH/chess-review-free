function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  } catch {
    return "Recent game";
  }
}

function computeRecentTrend(games, phaseStats) {
  if (games.length === 0) {
    return "No trend yet";
  }

  if (games.length === 1) {
    return "First read";
  }

  if (games.length < 8) {
    return "Early signal";
  }

  const recent = games.slice(0, Math.ceil(games.length / 2));
  const older = games.slice(Math.ceil(games.length / 2));
  const recentStats = CRFStats.computePhaseStats(recent);
  const olderStats = CRFStats.computePhaseStats(older);
  const weakest = phaseStats.weakestPhase || "middlegame";
  const recentRate = recentStats[weakest]?.rate ?? 0;
  const olderRate = olderStats[weakest]?.rate ?? 0;

  if (recentRate + 0.05 < olderRate) {
    return `Improving in the ${weakest}`;
  }
  if (recentRate > olderRate + 0.05) {
    return `Slipping in the ${weakest}`;
  }
  return "Holding steady";
}

function renderInsightList(element, items, profile, kind, emptyText) {
  if (!element) {
    return;
  }

  if (!items.length) {
    element.innerHTML = `<div class="teaching-row muted">${emptyText}</div>`;
    return;
  }

  element.innerHTML = items
    .map(([tag, count]) => {
      const insight = CRFStats.explainTag(tag, count, profile, kind);
      return `
        <div class="teaching-row">
          <strong>${insight.label}</strong>
          <p>${insight.body}</p>
        </div>
      `;
    })
    .join("");
}

function renderBulletList(element, items, emptyText) {
  if (!element) {
    return;
  }

  if (!items.length) {
    element.innerHTML = `<div class="bullet-item muted">${emptyText}</div>`;
    return;
  }

  element.innerHTML = items
    .map((item) => `<div class="bullet-item">${item}</div>`)
    .join("");
}

document.addEventListener("DOMContentLoaded", async () => {
  const isEmbedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  const revealEl = document.getElementById("profile-reveal");
  const summaryEl = document.getElementById("profile-summary");
  const archetypeTitleEl = document.getElementById("archetype-title");
  const archetypeCopyEl = document.getElementById("archetype-copy");
  const mainFocusTitleEl = document.getElementById("main-focus-title");
  const mainFocusCopyEl = document.getElementById("main-focus-copy");
  const fixFirstTitleEl = document.getElementById("fix-first-title");
  const fixFirstCopyEl = document.getElementById("fix-first-copy");
  const improvementTitleEl = document.getElementById("improvement-title");
  const improvementCopyEl = document.getElementById("improvement-copy");
  const warningTitleEl = document.getElementById("warning-title");
  const warningCopyEl = document.getElementById("warning-copy");
  const progressTitleEl = document.getElementById("progress-title");
  const progressCopyEl = document.getElementById("progress-copy");
  const improvementActionsEl = document.getElementById("improvement-actions");
  const trainingPlanEl = document.getElementById("training-plan");
  const resourceTypesEl = document.getElementById("resource-types");
  const weakestPhaseEl = document.getElementById("weakest-phase");
  const stablePhaseEl = document.getElementById("stable-phase");
  const trendEl = document.getElementById("trend-text");
  const mistakeListEl = document.getElementById("mistake-list");
  const strengthListEl = document.getElementById("strength-list");
  const gameLibraryEl = document.getElementById("game-library");
  const upgradeBtn = document.getElementById("profile-upgrade-btn");
  const backBtn = document.getElementById("profile-back-btn");

  try {
    await chrome.runtime.sendMessage({ type: "crf:sync-billing" });
  } catch {}

  if (backBtn) {
    backBtn.textContent = isEmbedded ? "Close" : "Back to Chess.com";
    backBtn.addEventListener("click", () => {
      if (isEmbedded && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "crf:close-profile-overlay" }, chrome.runtime.getURL("").slice(0, -1));
        return;
      }
      window.close();
    });
  }

  const access = await CRFStorage.getAccessState();
  if (!access.hasProAccess) {
    revealEl.textContent = "Unlock your Chess DNA.";
    summaryEl.textContent = "See your recurring strengths, weaknesses, weakest phase, and saved game library with the premium profile.";
    archetypeTitleEl.textContent = "Premium feature";
    archetypeCopyEl.textContent = "This page turns your results into a coach-style diagnosis instead of a flat stats list.";
    mainFocusTitleEl.textContent = "What’s holding you back";
    mainFocusCopyEl.textContent = "Locked until you upgrade.";
    fixFirstTitleEl.textContent = "What to fix first";
    fixFirstCopyEl.textContent = "Locked until you upgrade.";
    improvementTitleEl.textContent = "What to work on next";
    improvementCopyEl.textContent = "Locked until you upgrade.";
    warningTitleEl.textContent = "Watch for this";
    warningCopyEl.textContent = "Locked until you upgrade.";
    progressTitleEl.textContent = "Progress marker";
    progressCopyEl.textContent = "Locked until you upgrade.";
    weakestPhaseEl.textContent = "Locked";
    stablePhaseEl.textContent = "Locked";
    trendEl.textContent = "$8/month";
    if (upgradeBtn) {
      upgradeBtn.hidden = false;
      upgradeBtn.addEventListener("click", async () => {
        await CRFStorage.openUpgradeCheckout();
      });
    }
    renderInsightList(mistakeListEl, [], { sampleSize: 0 }, "mistake", "Recurring mistake patterns are part of Pro.");
    renderInsightList(strengthListEl, [], { sampleSize: 0 }, "strength", "Recurring strength patterns are part of Pro.");
    renderBulletList(improvementActionsEl, [], "Concrete improvement actions are part of Pro.");
    renderBulletList(trainingPlanEl, [], "Training plans are part of Pro.");
    renderBulletList(resourceTypesEl, [], "Resource suggestions are part of Pro.");
    if (gameLibraryEl) {
      gameLibraryEl.innerHTML = `<div class="game-row locked">Game library is locked on the free plan.</div>`;
    }
    return;
  }

  const games = await CRFStorage.getStoredGames();
  const profile = CRFStats.computeChessProfile(games);
  const phaseStats = CRFStats.computePhaseStats(games);
  const ownerSuffix = access.ownerBypass ? " Owner bypass is active on this local dev build." : "";

  revealEl.textContent = profile.revealHeadline;
  summaryEl.textContent = `${profile.summaryText}${ownerSuffix}`;
  archetypeTitleEl.textContent = profile.archetype.title;
  archetypeCopyEl.textContent = profile.archetype.description;
  mainFocusTitleEl.textContent = profile.mainCoachingFocus.title;
  mainFocusCopyEl.textContent = profile.mainCoachingFocus.description;
  fixFirstTitleEl.textContent = profile.fixFirst.title;
  fixFirstCopyEl.textContent = profile.fixFirst.description;
  improvementTitleEl.textContent = profile.improvementFocus.title;
  improvementCopyEl.textContent = profile.improvementFocus.description;
  warningTitleEl.textContent = profile.warning.title;
  warningCopyEl.textContent = profile.warning.description;
  progressTitleEl.textContent = "What good progress would look like";
  progressCopyEl.textContent = profile.progressMarker;
  weakestPhaseEl.textContent = profile.weakestPhase ? CRFStats.capitalize(profile.weakestPhase) : "Still forming";
  stablePhaseEl.textContent = profile.mostStablePhase ? CRFStats.capitalize(profile.mostStablePhase) : "Still forming";
  trendEl.textContent = computeRecentTrend(games, phaseStats);
  renderBulletList(
    improvementActionsEl,
    profile.improvementActions,
    games.length ? "No practical actions yet." : "No saved games yet."
  );
  renderBulletList(
    trainingPlanEl,
    profile.trainingPlan,
    games.length ? "No training plan yet." : "No saved games yet."
  );
  renderBulletList(
    resourceTypesEl,
    profile.resourceTypes,
    games.length ? "No study resources yet." : "No saved games yet."
  );

  renderInsightList(
    mistakeListEl,
    profile.commonMistakes,
    profile,
    "mistake",
    games.length ? "No clear recurring mistakes yet." : "No saved games yet."
  );
  renderInsightList(
    strengthListEl,
    profile.commonStrengths,
    profile,
    "strength",
    games.length ? "No clear recurring strengths yet." : "No saved games yet."
  );

  if (!games.length) {
    gameLibraryEl.innerHTML = `<div class="game-row muted">No saved games yet. Analyze a game to start your library.</div>`;
    return;
  }

  gameLibraryEl.innerHTML = games.slice(0, 50).map((game) => `
    <div class="game-row">
      <div class="game-top">
        <span>${game.result.toUpperCase()}</span>
        <span>${formatDate(game.date)}</span>
      </div>
      <div><strong>${game.opening || CRFStats.humanizeTag(game.primaryReason || "Recent Game")}</strong></div>
      <div class="muted">${game.summary?.headline || "Saved analyzed game"}</div>
    </div>
  `).join("");
});
