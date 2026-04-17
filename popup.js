document.addEventListener("DOMContentLoaded", async () => {
  const habitEl = document.getElementById("popup-habit");
  if (!habitEl) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "crf:get-patterns" });
    const dominant = response?.ok ? response.summary?.dominant : null;
    if (!dominant) {
      habitEl.textContent = "Play a few reviewed games to unlock your habit tracker.";
      return;
    }

    const label = dominant.type === "strength" ? "Current strength" : "Current habit";
    const text = dominant.tag.replaceAll("_", " ");
    habitEl.textContent = `${label}: ${text} (${dominant.count}/${dominant.window})`;
  } catch {
    habitEl.textContent = "Open a finished Chess.com game and click Game Review.";
  }
});
