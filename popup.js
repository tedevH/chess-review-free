const STORAGE_KEY = "crfImportedGame";
let autoImportAttempted = false;

function setStatus(message, isError = false) {
  const status = document.getElementById("popup-status");
  status.textContent = message;
  status.dataset.state = isError ? "error" : "idle";
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tabs);
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

async function openAnalyzerPage() {
  await tabsCreate({ url: chrome.runtime.getURL("analyzer.html") });
}

async function getActiveTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  return tab || null;
}

function isSupportedChessTab(tab) {
  const url = String(tab?.url || "");
  return Boolean(tab?.id && /https:\/\/www\.chess\.com\/(game|analysis\/game)\/live\//.test(url));
}

async function importCurrentGame() {
  setStatus("Checking the active tab...");
  const tab = await getActiveTab();

  if (!isSupportedChessTab(tab)) {
    throw new Error("Open a finished Chess.com live game first, then try import again.");
  }

  setStatus("Loading the current finished game...");
  let response;

  try {
    response = await tabsSendMessage(tab.id, { type: "crf:get-finished-game" });
  } catch (error) {
    if (!/Receiving end does not exist/i.test(String(error?.message || error))) {
      throw error;
    }

    setStatus("Connecting to the current page...");
    await executeScript(tab.id, ["content.js"]);
    response = await tabsSendMessage(tab.id, { type: "crf:get-finished-game" });
  }

  if (!response?.ok) {
    throw new Error(response?.error || "Could not import the current game.");
  }

  await storageSet({ [STORAGE_KEY]: response.payload });
  setStatus("Imported. Opening analyzer...");
  await openAnalyzerPage();
  window.close();
}

async function updateInitialState() {
  const tab = await getActiveTab();

  if (isSupportedChessTab(tab)) {
    setStatus("Finished Chess.com game detected. Opening the analyzer...");

    if (!autoImportAttempted) {
      autoImportAttempted = true;
      await importCurrentGame();
    }
    return;
  }

  setStatus("No finished Chess.com game detected in the current tab.");
}

document.getElementById("open-analyzer").addEventListener("click", () => {
  void openAnalyzerPage();
});

document.getElementById("import-current-game").addEventListener("click", () => {
  void importCurrentGame().catch((error) => {
    setStatus(error.message || "Import failed.", true);
  });
});

void updateInitialState().catch((error) => {
  setStatus(error.message || "Could not inspect the current tab.", true);
});
