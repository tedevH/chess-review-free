function showLockedProfileModal() {
  const locked = document.getElementById("locked-profile");
  if (locked) {
    locked.classList.add("visible");
  }
}

async function openProfileOverlayFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return false;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "crf:open-profile-overlay" }).catch(() => null);
  return Boolean(response?.ok);
}

document.addEventListener("DOMContentLoaded", async () => {
  const habitEl = document.getElementById("popup-habit");
  const viewProfileBtn = document.getElementById("view-profile-btn");
  const upgradeBtn = document.getElementById("upgrade-dna-btn");
  const accessNote = document.getElementById("profile-access-note");

  try {
    await chrome.runtime.sendMessage({ type: "crf:sync-billing" });
  } catch {}

  if (habitEl) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "crf:get-patterns" });
      const dominant = response?.ok ? response.summary?.dominant : null;

      if (dominant) {
        const label = dominant.type === "strength" ? "Current strength" : "Current habit";
        const text = dominant.tag.replaceAll("_", " ");
        habitEl.textContent = `${label}: ${text} (${dominant.count}/${dominant.window})`;
      } else {
        habitEl.textContent = "Play a few reviewed games to unlock your habit tracker.";
      }
    } catch {
      habitEl.textContent = "Open a finished Chess.com game and click Game Review.";
    }
  }

  if (!viewProfileBtn) {
    return;
  }

  try {
    const access = await CRFStorage.getAccessState();
    if (access.ownerBypass && accessNote) {
      accessNote.hidden = false;
      accessNote.textContent = "Owner bypass is active on this local dev build.";
    } else if (access.billingBaseUrl && accessNote) {
      accessNote.hidden = false;
      accessNote.textContent = `Stripe test mode is ready at ${access.billingBaseUrl}.`;
    }
  } catch {}

  viewProfileBtn.addEventListener("click", async () => {
    const access = await CRFStorage.getAccessState();

    if (access.hasProAccess) {
      const opened = await openProfileOverlayFromActiveTab();
      if (!opened) {
        if (accessNote) {
          accessNote.hidden = false;
          accessNote.textContent = "Open a Chess.com game page first, then try Chess DNA again.";
        }
        return;
      }
      window.close();
      return;
    }

    showLockedProfileModal();
  });

  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", async () => {
      await CRFStorage.openUpgradeCheckout();
    });
  }
});
