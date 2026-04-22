const PENDING_IMPORT_STORAGE_KEY = "casPendingImport";

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

function executeImportProbe(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: async () => {
          function detectBoardOrientation() {
            const board = document.querySelector("chess-board");
            if (!board) {
              return "white";
            }

            const orientation =
              board.orientation ||
              board.getAttribute?.("orientation") ||
              (board.classList.contains("flipped") ? "black" : "white");

            return orientation === "black" || orientation === "b" ? "black" : "white";
          }

          function headersToPgn(headers = {}) {
            return Object.entries(headers)
              .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
              .map(([key, value]) => `[${key} "${String(value).replaceAll('"', '\\"')}"]`)
              .join("\n");
          }

          function buildPgnFromMoves(headers, moves) {
            const moveText = String(moves || "").trim();
            if (!moveText) {
              return "";
            }

            const headerBlock = headersToPgn(headers);
            return `${headerBlock}\n\n${moveText}`.trim();
          }

          async function tryFetchText(url, init = {}) {
            try {
              const response = await fetch(url, init);
              if (!response.ok) {
                return null;
              }

              const text = await response.text();
              return text && (text.includes("[Event ") || /\b1\./.test(text)) ? text.trim() : null;
            } catch {
              return null;
            }
          }

          async function importChessCom() {
            const match = window.location.pathname.match(/\/(?:analysis\/)?game\/live\/(\d+)/);
            if (!match) {
              return null;
            }

            const gameId = match[1];
            const response = await fetch(`https://www.chess.com/callback/live/game/${gameId}`, {
              credentials: "include"
            });

            if (!response.ok) {
              throw new Error("The current Chess.com game could not be read.");
            }

            const gameData = await response.json();
            const result = String(gameData?.game?.pgnHeaders?.Result || "");

            if (!result || result === "*") {
              throw new Error("Only completed games can be imported from the current tab.");
            }

            return {
              provider: "chesscom",
              format: "siteData",
              gameId,
              viewerColor: detectBoardOrientation() === "black" ? "b" : "w",
              gameData
            };
          }

          async function importLichess() {
            const match = window.location.pathname.match(/^\/([a-zA-Z0-9]{8})(?:\/|$)/);
            if (!match) {
              return null;
            }

            const gameId = match[1];
            const candidates = [
              `https://lichess.org/game/export/${gameId}`,
              `https://lichess.org/game/export/${gameId}.pgn`,
              `https://lichess.org/api/game/export/${gameId}`,
              `https://lichess.org/api/game/export/${gameId}.pgn`
            ];

            for (const url of candidates) {
              const pgnText = await tryFetchText(url, {
                headers: {
                  Accept: "application/x-chess-pgn, text/plain;q=0.9, */*;q=0.1"
                },
                credentials: "omit"
              });

              if (pgnText) {
                return {
                  provider: "lichess",
                  format: "pgn",
                  gameId,
                  viewerColor: detectBoardOrientation() === "black" ? "b" : "w",
                  pgnText
                };
              }
            }

            throw new Error("The current Lichess game could not be exported from this tab.");
          }

          function importPgnFromPageText() {
            const selectors = [
              "textarea",
              "pre",
              "[data-pgn]",
              "[data-clipboard-text]"
            ];

            for (const selector of selectors) {
              for (const element of document.querySelectorAll(selector)) {
                const text =
                  element.getAttribute?.("data-pgn") ||
                  element.getAttribute?.("data-clipboard-text") ||
                  element.value ||
                  element.textContent ||
                  "";

                const trimmed = String(text).trim();
                if (trimmed.includes("[Event ") || /\b1\./.test(trimmed)) {
                  return trimmed;
                }
              }
            }

            return "";
          }

          const hostname = window.location.hostname.replace(/^www\./, "");

          if (hostname === "chess.com") {
            const chessCom = await importChessCom();
            if (chessCom) {
              return chessCom;
            }
          }

          if (hostname === "lichess.org") {
            const lichess = await importLichess();
            if (lichess) {
              return lichess;
            }
          }

          const pagePgn = importPgnFromPageText();
          if (pagePgn) {
            return {
              provider: hostname || "page",
              format: "pgn",
              gameId: `page-${Date.now()}`,
              viewerColor: detectBoardOrientation() === "black" ? "b" : "w",
              pgnText: pagePgn
            };
          }

          return null;
        }
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(results?.[0]?.result ?? null);
      }
    );
  });
}

async function openAnalyzerPage() {
  await tabsCreate({ url: chrome.runtime.getURL("analyzer.html") });
  window.close();
}

async function analyzeCurrentGame() {
  setStatus("Checking the current tab...");
  const [tab] = await tabsQuery({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  const payload = await executeImportProbe(tab.id);

  if (!payload) {
    setStatus("No supported current-game import was available. Opening the analyzer...");
    await openAnalyzerPage();
    return;
  }

  await storageSet({
    [PENDING_IMPORT_STORAGE_KEY]: {
      ...payload,
      sourceUrl: tab.url || "",
      importedAt: Date.now()
    }
  });

  setStatus("Game data imported. Opening analyzer...");
  await openAnalyzerPage();
}

document.getElementById("analyze-current-game").addEventListener("click", () => {
  void analyzeCurrentGame().catch((error) => {
    setStatus(error.message || "Could not import the current game.", true);
  });
});

document.getElementById("open-analyzer").addEventListener("click", () => {
  void openAnalyzerPage().catch((error) => {
    setStatus(error.message || "Could not open analyzer.", true);
  });
});
