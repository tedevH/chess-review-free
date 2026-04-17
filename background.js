const STORAGE_KEY = "crf_saved_games_v1";
const MAX_GAMES = 100;
const HABIT_WINDOW = 20;

function normalizeEntry(entry) {
  return {
    gameId: String(entry.gameId || ""),
    result: entry.result === "win" ? "win" : entry.result === "loss" ? "loss" : "draw",
    blunders: Number(entry.blunders || 0),
    mistakes: Number(entry.mistakes || 0),
    moveCount: Number(entry.moveCount || 0),
    reasonTag: String(entry.reasonTag || ""),
    mistakeTags: Array.isArray(entry.mistakeTags) ? entry.mistakeTags.map(String) : [],
    goodTags: Array.isArray(entry.goodTags) ? entry.goodTags.map(String) : [],
    createdAt: Number(entry.createdAt || Date.now())
  };
}

async function readGames() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeGames(games) {
  await chrome.storage.local.set({ [STORAGE_KEY]: games.slice(0, MAX_GAMES) });
}

function incrementCounts(target, tags) {
  for (const tag of tags) {
    target[tag] = (target[tag] || 0) + 1;
  }
}

function topCountEntry(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || null;
}

function buildPatternSummary(games) {
  const recentGames = games.slice(0, HABIT_WINDOW);
  const mistakeCounts = {};
  const goodCounts = {};

  for (const game of recentGames) {
    incrementCounts(mistakeCounts, game.mistakeTags || []);
    incrementCounts(goodCounts, game.goodTags || []);
  }

  const topMistake = topCountEntry(mistakeCounts);
  const topGood = topCountEntry(goodCounts);

  let dominant = null;
  if (topMistake && (!topGood || topMistake[1] >= topGood[1])) {
    dominant = {
      type: "weakness",
      tag: topMistake[0],
      count: topMistake[1],
      window: recentGames.length
    };
  } else if (topGood) {
    dominant = {
      type: "strength",
      tag: topGood[0],
      count: topGood[1],
      window: recentGames.length
    };
  }

  return {
    recentGames: recentGames.length,
    mistakeCounts,
    goodCounts,
    dominant
  };
}

async function saveReview(entry) {
  const normalized = normalizeEntry(entry);
  const games = await readGames();
  const withoutDuplicate = games.filter((game) => game.gameId !== normalized.gameId);
  const nextGames = [normalized, ...withoutDuplicate].slice(0, MAX_GAMES);
  await writeGames(nextGames);
  return buildPatternSummary(nextGames);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "crf:save-review") {
    saveReview(message.payload)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "crf:get-patterns") {
    readGames()
      .then((games) => sendResponse({ ok: true, summary: buildPatternSummary(games) }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});
