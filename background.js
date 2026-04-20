const STORAGE_KEY = "crfImportedGame";
const ANALYZER_PATH = "analyzer.html";

function isSupportedChessTab(tab) {
  const url = String(tab?.url || "");
  return Boolean(tab?.id && /https:\/\/www\.chess\.com\/(game|analysis\/game)\/live\//.test(url));
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files
      },
      (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(result);
      }
    );
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

async function openAnalyzerPage() {
  await tabsCreate({ url: chrome.runtime.getURL(ANALYZER_PATH) });
}

async function getFinishedGamePayload(tab) {
  if (!isSupportedChessTab(tab)) {
    return null;
  }

  try {
    const response = await tabsSendMessage(tab.id, { type: "crf:get-finished-game" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not import the current game.");
    }
    return response.payload;
  } catch (error) {
    if (!/Receiving end does not exist/i.test(String(error?.message || error))) {
      throw error;
    }

    await executeScript(tab.id, ["content.js"]);
    const response = await tabsSendMessage(tab.id, { type: "crf:get-finished-game" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not import the current game.");
    }
    return response.payload;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const payload = await getFinishedGamePayload(tab);
    if (payload) {
      await storageSet({ [STORAGE_KEY]: payload });
    }
  } catch (error) {
    console.error("Chess Move Coach import failed", error);
  }

  await openAnalyzerPage();
});
