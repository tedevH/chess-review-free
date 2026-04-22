function setStatus(message, isError = false) {
  const status = document.getElementById("popup-status");
  status.textContent = message;
  status.dataset.state = isError ? "error" : "idle";
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
  setStatus("Opening analyzer...");
  await tabsCreate({ url: chrome.runtime.getURL("analyzer.html") });
  window.close();
}

document.getElementById("open-analyzer").addEventListener("click", () => {
  void openAnalyzerPage().catch((error) => {
    setStatus(error.message || "Could not open analyzer.", true);
  });
});
