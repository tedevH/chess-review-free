(async () => {
  if (window.top !== window.self) {
    return;
  }

  const { Chess } = await import(chrome.runtime.getURL("vendor-chess.js"));

  const PANEL_ID = "crf-root";
  const LAUNCHER_ID = "crf-launcher";
  const RETRY_DELAY_MS = 1200;

  const state = {
    root: null,
    launcher: null,
    status: null,
    progressBar: null,
    summary: null,
    moves: null,
    chart: null,
    analyzeButton: null,
    board: null,
    boardCaption: null,
    boardHelper: null,
    prevMoveButton: null,
    nextMoveButton: null,
    engineMoveButton: null,
    resetLineButton: null,
    dragPointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    stockfish: null,
    currentMoves: [],
    currentResults: [],
    currentPlyIndex: 0,
    boardOrientation: "white",
    viewerColor: "w",
    analysisActive: false,
    analysisFen: null,
    analysisOriginFen: null,
    analysisMoves: [],
    analysisByFen: {},
    analysisSelectedSquare: null,
    analysisLegalTargets: [],
    analysisResult: null,
    analysisPending: false,
    analysisQueue: Promise.resolve(),
    analysisToken: 0,
    deepEvalToken: 0,
    destroyed: false
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function createChessFromFen(fen) {
    return fen ? new Chess(fen) : new Chess();
  }

  function tryNormalizeFen(fen) {
    if (!fen || typeof fen !== "string") {
      return null;
    }

    try {
      return new Chess(fen.trim()).fen();
    } catch {
      return null;
    }
  }

  function tryReadChessComBoardFen() {
    const el = document.querySelector("chess-board");
    if (!el) {
      return null;
    }

    const candidates = [
      () => (typeof el.fen === "string" ? el.fen : null),
      () => (typeof el.position === "string" ? el.position : null),
      () => (typeof el.getFen === "function" ? el.getFen() : null),
      () => el.getAttribute?.("fen"),
      () => el.game?.fen?.(),
      () => el.game?.getFen?.(),
      () => el._game?.fen?.(),
      () => el.chessboard?.getFen?.()
    ];

    for (const get of candidates) {
      try {
        const value = get();
        if (typeof value === "string" && value.includes("/")) {
          return value.trim();
        }
      } catch {
        /* ignore */
      }
    }

    return null;
  }

  function inferPlyIndexFromGameLine(fen) {
    const normalized = tryNormalizeFen(fen);
    if (!normalized || !state.currentMoves.length) {
      return null;
    }

    const start = new Chess().fen();
    if (normalized === start) {
      return 0;
    }

    for (let i = 0; i < state.currentMoves.length; i += 1) {
      const after = tryNormalizeFen(state.currentMoves[i].afterFen);
      if (after && after === normalized) {
        return i + 1;
      }
    }

    return null;
  }

  function moveSwingText(cpl) {
    if (cpl <= 20) {
      return "Tiny";
    }

    if (cpl <= 60) {
      return "Small";
    }

    if (cpl <= 120) {
      return "Medium";
    }

    if (cpl <= 220) {
      return "Large";
    }

    return "Huge";
  }

  function currentBoardFen() {
    return state.analysisActive ? state.analysisFen : fenForPly(state.currentPlyIndex);
  }

  function clearAnalysisSelection() {
    state.analysisSelectedSquare = null;
    state.analysisLegalTargets = [];
  }

  function resetAnalysisBoard() {
    state.analysisActive = false;
    state.analysisFen = null;
    state.analysisOriginFen = null;
    state.analysisMoves = [];
    state.analysisByFen = {};
    state.analysisResult = null;
    state.analysisPending = false;
    state.analysisQueue = Promise.resolve();
    clearAnalysisSelection();
  }

  function ensureAnalysisBoard(preferredSquare = null) {
    if (state.analysisActive) {
      return preferredSquare;
    }

    // Sync with Chess.com's main board: our currentPlyIndex only changes via this
    // panel's controls, so stepping on Chess.com left us on ply 0 with a different
    // visible position. Infer ply from FEN, or use the live FEN when it does not
    // match our game line (still lets you sandbox from what you see).
    const liveFen = tryReadChessComBoardFen();
    const normalizedLive = liveFen ? tryNormalizeFen(liveFen) : null;
    let inferredFromLive = null;

    if (normalizedLive && state.currentMoves.length) {
      inferredFromLive = inferPlyIndexFromGameLine(liveFen);
      if (inferredFromLive !== null) {
        state.currentPlyIndex = inferredFromLive;
        renderBoardAtPly(state.currentPlyIndex);
      }
    }

    let branchFen = fenForPly(state.currentPlyIndex);
    if (inferredFromLive === null && normalizedLive) {
      branchFen = normalizedLive;
    }

    state.analysisActive = true;
    state.analysisFen = branchFen;
    state.analysisOriginFen = branchFen;
    state.analysisMoves = [];
    state.analysisByFen = {};
    state.analysisResult = null;
    state.analysisPending = false;
    state.analysisQueue = Promise.resolve();
    clearAnalysisSelection();

    return preferredSquare;
  }

  function parseGameId() {
    const patterns = [
      /\/game\/live\/(\d+)/,
      /\/analysis\/game\/live\/(\d+)/
    ];

    for (const pattern of patterns) {
      const match = window.location.pathname.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function getAnalysisProfile(moveCount) {
    if (moveCount >= 50) {
      return {
        bestDepth: 14,
        finalDepth: 14,
        deepEvalDepth: 16
      };
    }

    if (moveCount >= 35) {
      return {
        bestDepth: 15,
        finalDepth: 15,
        deepEvalDepth: 17
      };
    }

    return {
      bestDepth: 16,
      finalDepth: 16,
      deepEvalDepth: 18
    };
  }

  function viewerColorToBoardOrientation(viewerColor) {
    return viewerColor === "b" ? "black" : "white";
  }

  function detectBoardOrientation() {
    const boardElement = document.querySelector("chess-board");
    if (!boardElement) {
      return "white";
    }

    const o = boardElement.orientation;
    if (o === "black" || o === "b") {
      return "black";
    }
    if (o === "white" || o === "w") {
      return "white";
    }

    const attr = boardElement.getAttribute?.("orientation");
    if (attr === "black" || attr === "b") {
      return "black";
    }
    if (attr === "white" || attr === "w") {
      return "white";
    }

    if (boardElement.classList.contains("flipped")) {
      return "black";
    }

    return "white";
  }

  function normalizeHeaderName(name) {
    if (!name) {
      return "";
    }
    return String(name)
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim()
      .toLowerCase();
  }

  /**
   * Content scripts cannot read page `window.user` (isolated world). Run a tiny
   * script in the page context and stash username/id on <html> for us to read.
   */
  function syncPageContextViewerIdentity() {
    const marker = "data-crf-viewer-sync";
    if (document.documentElement.getAttribute(marker) === "1") {
      return;
    }

    const script = document.createElement("script");
    script.textContent = `(function(){
      try {
        var u = (window.user && window.user.username) ||
          (window.chesscom && window.chesscom.user && window.chesscom.user.username) || "";
        var uid = (window.user && (window.user.id || window.user.userId || window.user.uuid));
        document.documentElement.setAttribute("data-crf-viewer-username", u || "");
        document.documentElement.setAttribute("data-crf-viewer-id", uid != null ? String(uid) : "");
        document.documentElement.setAttribute("${marker}", "1");
      } catch (e) {}
    })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  function scrapeUsernameFromChessDom() {
    const hrefSelectors = [
      "a.user-usernameComponent",
      "a[class*='usernameComponent']",
      "[data-testid='user-username'] a",
      "nav a[href^='/member/']",
      "#header a[href^='/member/']",
      "a[href^='/member/']",
      "a[href*='chess.com/member/']"
    ];

    for (const sel of hrefSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const href = el.getAttribute("href") || "";
        const m = href.match(/\/member\/([^/?#]+)/i);
        if (m) {
          try {
            return decodeURIComponent(m[1]).trim().toLowerCase();
          } catch {
            return m[1].trim().toLowerCase();
          }
        }
      }
    }

    return "";
  }

  function getViewerUsernameFromPage() {
    syncPageContextViewerIdentity();
    const fromAttr = document.documentElement.getAttribute("data-crf-viewer-username");
    if (fromAttr && fromAttr.trim()) {
      return fromAttr.trim().toLowerCase();
    }
    return scrapeUsernameFromChessDom();
  }

  function getViewerIdFromPage() {
    syncPageContextViewerIdentity();
    const id = document.documentElement.getAttribute("data-crf-viewer-id");
    return id && id.length ? id : null;
  }

  function usernameMatchesHeader(username, headerNormalized) {
    if (!username || !headerNormalized) {
      return false;
    }
    if (username === headerNormalized) {
      return true;
    }
    const parts = headerNormalized.split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last === username) {
      return true;
    }
    if (headerNormalized.includes(username)) {
      return true;
    }
    return false;
  }

  function parseViewerColorFromGameData(gameData) {
    const game = gameData?.game;
    if (!game) {
      return null;
    }

    const me = getViewerUsernameFromPage();

    const headers = game.pgnHeaders || {};
    const whiteHeader = normalizeHeaderName(headers.White);
    const blackHeader = normalizeHeaderName(headers.Black);

    if (me && usernameMatchesHeader(me, whiteHeader)) {
      return "w";
    }
    if (me && usernameMatchesHeader(me, blackHeader)) {
      return "b";
    }

    const whiteFromApi = normalizeHeaderName(
      String(
        game.whiteUsername ||
          game.whiteMember?.username ||
          game.whitePlayer?.username ||
          (typeof game.white === "string" ? game.white : game.white?.username || "")
      )
    );
    const blackFromApi = normalizeHeaderName(
      String(
        game.blackUsername ||
          game.blackMember?.username ||
          game.blackPlayer?.username ||
          (typeof game.black === "string" ? game.black : game.black?.username || "")
      )
    );
    if (me && whiteFromApi && usernameMatchesHeader(me, whiteFromApi)) {
      return "w";
    }
    if (me && blackFromApi && usernameMatchesHeader(me, blackFromApi)) {
      return "b";
    }

    const pc = game.playerColor ?? game.myColor ?? game.side ?? game.userColor;
    if (pc === "white" || pc === 1 || pc === "1") {
      return "w";
    }
    if (pc === "black" || pc === 2 || pc === "2") {
      return "b";
    }

    const myId = getViewerIdFromPage();
    const players = game.players;
    if (players && myId != null) {
      const sid = String(myId);
      const matchSlot = (slot) =>
        slot &&
        (String(slot.userId) === sid ||
          String(slot.uuid) === sid ||
          String(slot.id) === sid ||
          String(slot.username || "")
            .trim()
            .toLowerCase() === me);

      if (matchSlot(players.top)) {
        const c = players.top.color ?? players.top.pieceColor;
        if (c === "white" || c === 1 || c === "1") {
          return "w";
        }
        if (c === "black" || c === 2 || c === "2") {
          return "b";
        }
      }
      if (matchSlot(players.bottom)) {
        const c = players.bottom.color ?? players.bottom.pieceColor;
        if (c === "white" || c === 1 || c === "1") {
          return "w";
        }
        if (c === "black" || c === 2 || c === "2") {
          return "b";
        }
      }
    }

    if (Array.isArray(players)) {
      for (const slot of players) {
        if (!slot) {
          continue;
        }
        const un = normalizeHeaderName(String(slot.username || slot.name || slot.handle || ""));
        if (me && un && usernameMatchesHeader(me, un)) {
          const c = slot.color ?? slot.pieceColor ?? slot.side;
          if (c === "white" || c === 1 || c === "1") {
            return "w";
          }
          if (c === "black" || c === 2 || c === "2") {
            return "b";
          }
        }
      }
    }

    return null;
  }

  function resolveViewerColor(gameData) {
    const parsed = parseViewerColorFromGameData(gameData);
    if (parsed) {
      return parsed;
    }
    return detectBoardOrientation() === "black" ? "b" : "w";
  }

  function ensureUi() {
    if (state.root && state.launcher) {
      return;
    }

    const launcher = document.createElement("button");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.textContent = "Analyze Free";
    launcher.addEventListener("click", () => {
      state.root.classList.remove("crf-hidden");
      launcher.classList.add("crf-hidden");
    });

    const root = document.createElement("aside");
    root.id = PANEL_ID;
    root.className = "crf-hidden";
    root.innerHTML = `
      <div class="crf-header" id="crf-drag-handle">
        <div>
          <h2 class="crf-title">Chess Review Free</h2>
          <p class="crf-subtitle">Post-game analysis on Chess.com with local Stockfish in your browser.</p>
        </div>
        <button class="crf-close" id="crf-close" type="button" aria-label="Close review panel">&times;</button>
      </div>
      <div class="crf-scroll">
        <section class="crf-card">
          <div class="crf-row">
            <div>
              <strong>Post-game only</strong>
              <div class="crf-muted">Use this after a finished live game. The extension does not analyze active games.</div>
            </div>
          </div>
          <button class="crf-cta" id="crf-analyze" type="button">Run Analysis</button>
          <div class="crf-progress">
            <div class="crf-progress-bar" id="crf-progress-bar"></div>
          </div>
          <p class="crf-muted" id="crf-status">Waiting for a finished Chess.com live game.</p>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Review Board</strong>
            <span class="crf-muted">Step through the analyzed game</span>
          </div>
          <div class="crf-board-shell">
            <div class="crf-board-wrap">
              <div class="crf-eval-bar-shell">
                <div class="crf-eval-label crf-eval-label-top" id="crf-eval-top">+0.0</div>
                <div class="crf-eval-bar" id="crf-eval-bar">
                  <div class="crf-eval-fill" id="crf-eval-fill"></div>
                </div>
                <div class="crf-eval-label crf-eval-label-bottom" id="crf-eval-bottom">+0.0</div>
              </div>
              <div id="crf-board" class="crf-board"></div>
            </div>
          </div>
          <div class="crf-board-controls">
            <button class="crf-nav" id="crf-prev-move" type="button">Previous</button>
            <div id="crf-board-caption" class="crf-muted">Start position</div>
            <button class="crf-nav" id="crf-next-move" type="button">Next</button>
          </div>
          <div class="crf-board-actions">
            <button class="crf-nav" id="crf-engine-move" type="button">Play Engine Move</button>
            <button class="crf-nav" id="crf-reset-line" type="button">Return to Game</button>
          </div>
          <p id="crf-board-helper" class="crf-muted crf-board-helper">Click a piece on the board to test a different move from the position you are viewing.</p>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Summary</strong>
            <span class="crf-muted">Estimated accuracy and engine-backed move grades</span>
          </div>
          <div id="crf-summary" class="crf-summary-grid"></div>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Eval Chart</strong>
            <span class="crf-muted">After each move</span>
          </div>
          <canvas id="crf-chart" class="crf-chart" width="400" height="120"></canvas>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Move Review</strong>
            <span class="crf-muted">Best line and centipawn loss</span>
          </div>
          <div id="crf-moves" class="crf-moves"></div>
        </section>
      </div>
    `;

    document.documentElement.append(root, launcher);

    root.querySelector("#crf-close").addEventListener("click", () => {
      root.classList.add("crf-hidden");
      launcher.classList.remove("crf-hidden");
    });

    enableDragging(root);

    state.root = root;
    state.launcher = launcher;
    state.status = root.querySelector("#crf-status");
    state.progressBar = root.querySelector("#crf-progress-bar");
    state.summary = root.querySelector("#crf-summary");
    state.moves = root.querySelector("#crf-moves");
    state.chart = root.querySelector("#crf-chart");
    state.board = root.querySelector("#crf-board");
    state.boardCaption = root.querySelector("#crf-board-caption");
    state.boardHelper = root.querySelector("#crf-board-helper");
    state.prevMoveButton = root.querySelector("#crf-prev-move");
    state.nextMoveButton = root.querySelector("#crf-next-move");
    state.engineMoveButton = root.querySelector("#crf-engine-move");
    state.resetLineButton = root.querySelector("#crf-reset-line");
    state.evalFill = root.querySelector("#crf-eval-fill");
    state.evalTop = root.querySelector("#crf-eval-top");
    state.evalBottom = root.querySelector("#crf-eval-bottom");
    state.analyzeButton = root.querySelector("#crf-analyze");
    state.analyzeButton.addEventListener("click", runAnalysis);
    state.prevMoveButton.addEventListener("click", () => stepBoard(-1));
    state.nextMoveButton.addEventListener("click", () => stepBoard(1));
    state.engineMoveButton.addEventListener("click", () => {
      void playEngineMove();
    });
    state.resetLineButton.addEventListener("click", () => {
      resetAnalysisBoard();
      renderBoardAtPly(state.currentPlyIndex);
    });
    state.board.addEventListener("click", (event) => {
      void handleBoardClick(event);
    });
    window.addEventListener("keydown", handleKeyNavigation);
    renderBoardAtPly(0);
  }

  function enableDragging(root) {
    const handle = root.querySelector("#crf-drag-handle");

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) {
        return;
      }

      const rect = root.getBoundingClientRect();
      state.dragPointerId = event.pointerId;
      state.dragOffsetX = event.clientX - rect.left;
      state.dragOffsetY = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (state.dragPointerId !== event.pointerId) {
        return;
      }

      const maxLeft = window.innerWidth - root.offsetWidth - 8;
      const maxTop = window.innerHeight - root.offsetHeight - 8;
      const left = clamp(event.clientX - state.dragOffsetX, 8, maxLeft);
      const top = clamp(event.clientY - state.dragOffsetY, 8, maxTop);

      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });

    handle.addEventListener("pointerup", (event) => {
      if (state.dragPointerId !== event.pointerId) {
        return;
      }

      state.dragPointerId = null;
      handle.releasePointerCapture(event.pointerId);
    });
  }

  function setStatus(message) {
    if (state.status) {
      state.status.textContent = message;
    }
  }

  function setProgress(current, total) {
    if (!state.progressBar) {
      return;
    }

    const ratio = total > 0 ? current / total : 0;
    state.progressBar.style.width = `${Math.round(ratio * 100)}%`;
  }

  function colorBadgeClass(label) {
    if (label === "Best" || label === "Excellent") {
      return "crf-best";
    }

    if (label === "Good") {
      return "crf-good-badge";
    }

    if (label === "Inaccuracy") {
      return "crf-warn-badge";
    }

    return "crf-bad-badge";
  }

  function accuracyFromCpl(cpl) {
    if (cpl <= 0) {
      return 100;
    }

    return Math.round(clamp(100 * Math.exp(-Math.pow(cpl / 110, 0.82)), 0, 100));
  }

  function gameAccuracyFromMoves(moves) {
    if (!moves.length) {
      return 0;
    }

    const averageAccuracy =
      moves.reduce((sum, move) => sum + move.accuracy, 0) / moves.length;
    const penalty =
      moves.filter((move) => move.label === "Blunder").length * 9 +
      moves.filter((move) => move.label === "Mistake").length * 5 +
      moves.filter((move) => move.label === "Inaccuracy").length * 2;

    return Math.round(clamp(averageAccuracy - penalty / Math.max(moves.length / 7, 1), 0, 100));
  }

  function stickerForLabel(label) {
    if (label === "Best") {
      return { text: "★", className: "crf-sticker-best", title: "Best move" };
    }

    if (label === "Excellent") {
      return { text: "✓", className: "crf-sticker-excellent", title: "Excellent move" };
    }

    if (label === "Inaccuracy") {
      return { text: "?!", className: "crf-sticker-inaccuracy", title: "Inaccuracy" };
    }

    if (label === "Mistake") {
      return { text: "?", className: "crf-sticker-mistake", title: "Mistake" };
    }

    if (label === "Blunder") {
      return { text: "??", className: "crf-sticker-blunder", title: "Blunder" };
    }

    return null;
  }

  function classifyMove(cpl, playedUci, bestUci) {
    if (playedUci === bestUci) {
      return "Best";
    }

    if (cpl <= 20) {
      return "Excellent";
    }

    if (cpl <= 60) {
      return "Good";
    }

    if (cpl <= 120) {
      return "Inaccuracy";
    }

    if (cpl <= 220) {
      return "Mistake";
    }

    return "Blunder";
  }

  function scoreToCp(score) {
    if (!score) {
      return 0;
    }

    if (score.unit === "mate") {
      const sign = Math.sign(score.value) || 1;
      return sign * (100000 - Math.min(Math.abs(score.value), 50) * 1000);
    }

    return score.value;
  }

  function normalizeScoreForFen(score, fen) {
    if (!score) {
      return { unit: "cp", value: 0 };
    }

    // Stockfish UCI always reports scores from the perspective of the SIDE TO MOVE,
    // not from White's perspective. We store scores White-centric throughout (positive
    // = White is better), so we must flip whenever it is Black's turn.
    let sideToMove = "w";
    try {
      if (fen) {
        sideToMove = new Chess(fen).turn();
      }
    } catch {
      // default to white
    }

    const flip = sideToMove === "b" ? -1 : 1;
    return {
      unit: score.unit,
      value: score.value * flip
    };
  }

  function perspectiveScoreForColor(score, color) {
    if (!score) {
      return { unit: "cp", value: 0 };
    }

    return {
      unit: score.unit,
      value: score.value * (color === "w" ? 1 : -1)
    };
  }

  function humanScore(score) {
    if (!score) {
      return "0.0";
    }

    if (score.unit === "mate") {
      return `#${score.value}`;
    }

    return (score.value / 100).toFixed(1);
  }

  function formatEngineEvalText(score) {
    if (!score) {
      return "0.0";
    }
    if (score.unit === "mate") {
      return `#${score.value}`;
    }
    return `${score.value >= 0 ? "+" : ""}${humanScore(score)}`;
  }

  function selectedScoreForPly(plyIndex) {
    if (state.analysisActive) {
      return state.analysisByFen[state.analysisFen]?.afterScore || state.analysisResult?.afterScore || { unit: "cp", value: 0 };
    }

    if (!state.currentResults.length || plyIndex <= 0) {
      return { unit: "cp", value: 0 };
    }

    const move = state.currentResults[Math.min(plyIndex - 1, state.currentResults.length - 1)];
    return move.afterScore || { unit: "cp", value: 0 };
  }

  /** Engine / stored scores are always White-centric (+ = White better). */
  function displayScoreForPly(plyIndex) {
    return selectedScoreForPly(plyIndex);
  }

  function evalFractionFromScore(score) {
    const cp = scoreToCp(score);
    const normalized = clamp(cp / 400, -1, 1);
    return (normalized + 1) / 2;
  }

  /**
   * Map White-centric eval to bar fill: high = White advantage. When the viewer is
   * Black, invert so a tall bar reads as Black advantage (avoids "+ looks like White"
   * after negating the number for "player perspective").
   */
  function evalBarFillFraction(score, viewerColor) {
    const f = evalFractionFromScore(score);
    return f;
  }

  function updateEvalBar(plyIndex) {
    if (!state.evalFill || !state.evalTop || !state.evalBottom) {
      return;
    }

    const score = displayScoreForPly(plyIndex);
    const fraction = evalBarFillFraction(score, state.viewerColor);
    const text = formatEngineEvalText(score);

    state.evalFill.style.height = `${Math.round(fraction * 100)}%`;

    if (state.boardOrientation === "black") {
      state.evalFill.style.top = "0";
      state.evalFill.style.bottom = "auto";
      state.evalTop.textContent = text;
      state.evalBottom.textContent = "";
    } else {
      state.evalFill.style.top = "auto";
      state.evalFill.style.bottom = "0";
      state.evalTop.textContent = "";
      state.evalBottom.textContent = text;
    }
  }

  function updateAnalysisActionButtons() {
    if (state.engineMoveButton) {
      state.engineMoveButton.disabled = state.analysisPending;
      state.engineMoveButton.textContent = state.analysisPending ? "Analyzing..." : "Play Engine Move";
    }

    if (state.resetLineButton) {
      state.resetLineButton.disabled = !state.analysisActive && !state.analysisMoves.length;
    }

    if (state.boardHelper) {
      if (state.analysisPending) {
        state.boardHelper.textContent = "Stockfish is analyzing your new move...";
      } else if (state.analysisActive) {
        const turnLabel = createChessFromFen(state.analysisFen).turn() === "w" ? "White" : "Black";
        state.boardHelper.textContent = `Edit mode is live on the current position. ${turnLabel} to move. Click one of that side's pieces to see legal moves, click it again to unselect, or use Return to Game.`;
      } else {
        state.boardHelper.textContent = "Click a piece on the board to test a different move from the position you are viewing.";
      }
    }
  }

  async function refineSelectedEval(plyIndex) {
    if (plyIndex <= 0 || !state.currentResults.length) {
      return;
    }

    const resultIndex = Math.min(plyIndex - 1, state.currentResults.length - 1);
    const move = state.currentResults[resultIndex];

    if (!move?.afterFen) {
      return;
    }

    const token = ++state.deepEvalToken;

    try {
      const stockfish = await getStockfish();
      const profile = getAnalysisProfile(state.currentMoves.length);
      const deep = await stockfish.analyzeFen(move.afterFen, { depth: profile.deepEvalDepth });

      if (token !== state.deepEvalToken) {
        return;
      }

      move.afterScore = normalizeScoreForFen(deep.score, move.afterFen);

      if (state.currentPlyIndex === plyIndex) {
        updateEvalBar(plyIndex);
      }
    } catch (error) {
      console.error("Deep eval refinement failed", error);
    }
  }

  function renderSummary(results) {
    const white = results.filter((move) => move.color === "w");
    const black = results.filter((move) => move.color === "b");
    const biggestMiss = results.reduce((worst, move) => (move.cpl > (worst?.cpl || -1) ? move : worst), null);

    const summaryCards = [
      { label: "White Accuracy", value: `${gameAccuracyFromMoves(white)}%` },
      { label: "Black Accuracy", value: `${gameAccuracyFromMoves(black)}%` },
      { label: "Moves Reviewed", value: String(results.length) },
      {
        label: "Toughest Moment",
        value: biggestMiss ? `${biggestMiss.color === "w" ? `${biggestMiss.moveNumber}.` : `${biggestMiss.moveNumber}...`} ${biggestMiss.san}` : "None"
      }
    ];

    state.summary.innerHTML = summaryCards
      .map(
        (card) => `
          <div class="crf-stat">
            <span class="crf-stat-label">${escapeHtml(card.label)}</span>
            <span class="crf-stat-value">${escapeHtml(card.value)}</span>
          </div>
        `
      )
      .join("");
  }

  function renderMoves(results) {
    state.moves.innerHTML = results
      .map((move, index) => {
        const moveNumber = move.color === "w" ? `${move.moveNumber}.` : `${move.moveNumber}...`;
        return `
          <article class="crf-move" data-ply-index="${index + 1}">
            <div class="crf-move-top">
              <strong>${escapeHtml(moveNumber)} ${escapeHtml(move.san)}</strong>
              <div class="crf-move-top-right">
                ${renderStickerMarkup(move.label)}
                <span class="crf-badge ${colorBadgeClass(move.label)}">${escapeHtml(move.label)}</span>
              </div>
            </div>
            <div class="crf-move-meta">
              <span class="crf-kbd">Accuracy ${move.accuracy}%</span>
              <span class="crf-kbd">Swing ${moveSwingText(move.cpl)}</span>
              <span class="crf-kbd">Eval ${escapeHtml(formatEngineEvalText(move.afterScore || { unit: "cp", value: 0 }))}</span>
            </div>
            <p class="crf-muted">Best move: <strong>${escapeHtml(move.bestSan || move.bestUci || "N/A")}</strong> · Played: <strong>${escapeHtml(move.san)}</strong></p>
            <p class="crf-muted">Engine line: ${escapeHtml(move.pvSan || move.bestUci || "N/A")}</p>
          </article>
        `;
      })
      .join("");

    state.moves.querySelectorAll("[data-ply-index]").forEach((element) => {
      element.addEventListener("click", () => {
        if (state.analysisActive) {
          setStatus("Edit mode is active. Use Return to Game to leave the analysis board.");
          return;
        }
        const plyIndex = Number(element.getAttribute("data-ply-index"));
        renderBoardAtPly(plyIndex);
      });
    });
  }

  function renderChart(results) {
    const canvas = state.chart;
    const context = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(148, 163, 184, 0.35)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();

    if (!results.length) {
      return;
    }

    const points = results.map((move, index) => {
      let normalized = clamp(scoreToCp(move.afterScore) / 100, -8, 8);
      if (state.viewerColor === "b") {
        normalized = -normalized;
      }
      const x = (index / Math.max(results.length - 1, 1)) * width;
      const y = height / 2 - (normalized / 8) * (height / 2 - 8);
      return { x, y };
    });

    context.strokeStyle = "#38bdf8";
    context.lineWidth = 2;
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.stroke();

    context.fillStyle = "#7dd3fc";
    points.forEach((point) => {
      context.beginPath();
      context.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
      context.fill();
    });
  }

  function renderStickerMarkup(label) {
    const sticker = stickerForLabel(label);

    if (!sticker) {
      return "";
    }

    return `<span class="crf-inline-sticker ${sticker.className}" title="${escapeHtml(sticker.title)}">${escapeHtml(sticker.text)}</span>`;
  }

  function pieceGlyph(piece) {
    const glyphs = {
      p: { w: "♙", b: "♟" },
      n: { w: "♘", b: "♞" },
      b: { w: "♗", b: "♝" },
      r: { w: "♖", b: "♜" },
      q: { w: "♕", b: "♛" },
      k: { w: "♔", b: "♚" }
    };

    return glyphs[piece.type]?.[piece.color] || "";
  }

  function fenForPly(plyIndex) {
    if (!state.currentMoves.length || plyIndex < 0) {
      return null;
    }

    if (plyIndex === 0) {
      return new Chess().fen();
    }

    return state.currentMoves[Math.min(plyIndex - 1, state.currentMoves.length - 1)].afterFen;
  }

  function captionForPly(plyIndex) {
    if (state.analysisActive) {
      const currentAnalysis = state.analysisByFen[state.analysisFen] || state.analysisResult;
      if (!currentAnalysis) {
        return state.analysisMoves.length
          ? `Edit mode · ${state.analysisMoves.join(" ")}`
          : "Edit mode · Choose a move from this exact position";
      }

      const line = state.analysisMoves.length ? ` · Line ${state.analysisMoves.join(" ")}` : "";
      return `Edit mode · ${currentAnalysis.moveSan} · ${currentAnalysis.label} · Accuracy ${currentAnalysis.accuracy}%${line}`;
    }

    if (!state.currentResults.length || plyIndex <= 0) {
      return "Start position";
    }

    const move = state.currentResults[Math.min(plyIndex - 1, state.currentResults.length - 1)];
    const moveNumber = move.color === "w" ? `${move.moveNumber}.` : `${move.moveNumber}...`;
    return `${moveNumber} ${move.san} · ${move.label} · Accuracy ${move.accuracy}%`;
  }

  function renderBoardAtPly(plyIndex) {
    if (!state.board || !state.boardCaption || !state.prevMoveButton || !state.nextMoveButton) {
      return;
    }

    state.currentPlyIndex = clamp(plyIndex, 0, state.currentMoves.length);
    const fen = currentBoardFen();
    const chess = createChessFromFen(fen);
    const files =
      state.boardOrientation === "black"
        ? ["h", "g", "f", "e", "d", "c", "b", "a"]
        : ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ranks =
      state.boardOrientation === "black"
        ? [1, 2, 3, 4, 5, 6, 7, 8]
        : [8, 7, 6, 5, 4, 3, 2, 1];
    const selectedMove =
      !state.analysisActive && state.currentPlyIndex > 0
        ? state.currentResults[Math.min(state.currentPlyIndex - 1, state.currentResults.length - 1)] ||
          state.currentMoves[Math.min(state.currentPlyIndex - 1, state.currentMoves.length - 1)]
        : null;
    const sticker = selectedMove ? stickerForLabel(selectedMove.label) : null;

    state.board.innerHTML = ranks
      .map((rank) =>
        files
          .map((file) => {
            const square = `${file}${rank}`;
            const piece = chess.get(square);
            const isLight = ("abcdefgh".indexOf(file) + (rank - 1)) % 2 === 0;
            const squareClass = isLight ? "crf-square-light" : "crf-square-dark";
            const stickerMarkup =
              sticker && selectedMove?.to === square
                ? `<span class="crf-square-sticker ${sticker.className}" title="${escapeHtml(sticker.title)}">${escapeHtml(sticker.text)}</span>`
                : "";
            const isSelected = state.analysisSelectedSquare === square;
            const isTarget = state.analysisLegalTargets.includes(square);

            return `
              <div class="crf-square ${squareClass}${isSelected ? " crf-square-selected" : ""}${isTarget ? " crf-square-target" : ""}" data-square="${square}">
                ${stickerMarkup}
                <span class="crf-piece">${escapeHtml(piece ? pieceGlyph(piece) : "")}</span>
              </div>
            `;
          })
          .join("")
      )
      .join("");

    state.boardCaption.textContent = captionForPly(state.currentPlyIndex);
    state.prevMoveButton.disabled = state.analysisActive || state.currentPlyIndex <= 0;
    state.nextMoveButton.disabled = state.analysisActive || state.currentPlyIndex >= state.currentMoves.length;
    updateAnalysisActionButtons();
    updateEvalBar(state.currentPlyIndex);
    if (!state.analysisActive) {
      void refineSelectedEval(state.currentPlyIndex);
    }

    state.moves.querySelectorAll("[data-ply-index]").forEach((element) => {
      const isActive = Number(element.getAttribute("data-ply-index")) === state.currentPlyIndex;
      element.classList.toggle("crf-move-active", isActive);
    });
  }

  function stepBoard(direction) {
    if (state.analysisActive) {
      setStatus("Edit mode is active. Use Return to Game to leave the analysis board.");
      return;
    }
    renderBoardAtPly(state.currentPlyIndex + direction);
  }

  function handleKeyNavigation(event) {
    if (!state.root || state.root.classList.contains("crf-hidden")) {
      return;
    }

    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : "";

    if (tagName === "input" || tagName === "textarea" || target?.isContentEditable) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepBoard(-1);
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepBoard(1);
    }
  }

  async function applyAnalysisMove(moveInput, precomputedBest = null) {
    ensureAnalysisBoard();

    const chess = createChessFromFen(state.analysisFen);
    const beforeFen = chess.fen();
    const played = chess.move(moveInput);

    if (!played) {
      state.analysisPending = false;
      updateAnalysisActionButtons();
      return;
    }

    const afterFen = chess.fen();
    const token = ++state.analysisToken;
    clearAnalysisSelection();
    state.analysisFen = afterFen;
    state.analysisMoves = [...state.analysisMoves, played.san];
    state.analysisResult = null;
    state.analysisPending = true;
    setStatus(`Edit mode: played ${played.san}. Stockfish is analyzing this move in the background...`);
    updateAnalysisActionButtons();
    renderBoardAtPly(state.currentPlyIndex);
    const uci = `${played.from}${played.to}${played.promotion || ""}`;
    state.analysisQueue = state.analysisQueue
      .catch(() => {})
      .then(async () => {
        try {
          const stockfish = await getStockfish();
          const profile = getAnalysisProfile(state.currentMoves.length + state.analysisMoves.length + 1);
          const best = precomputedBest || (await stockfish.analyzeFen(beforeFen, { depth: Math.min(profile.bestDepth, 10) }));
          const after = await stockfish.analyzeFen(afterFen, { depth: Math.min(profile.finalDepth, 10) });

          const moverColor = played.color;
          const bestScore = normalizeScoreForFen(best.score, beforeFen);
          const afterScore = normalizeScoreForFen(after.score, afterFen);
          const bestMoverScore = perspectiveScoreForColor(bestScore, moverColor);
          const playedMoverScore = perspectiveScoreForColor(afterScore, moverColor);
          const cpl = Math.max(0, Math.round(scoreToCp(bestMoverScore) - scoreToCp(playedMoverScore)));
          const accuracy = accuracyFromCpl(cpl);
          const label = classifyMove(cpl, uci, best.bestmove);
          const result = {
            moveSan: played.san,
            moveUci: uci,
            accuracy,
            cpl,
            label,
            bestUci: best.bestmove,
            bestSan: uciToSan(beforeFen, best.bestmove),
            afterScore,
            bestScore,
            pvSan: pvToSan(beforeFen, best.pv)
          };

          state.analysisByFen[afterFen] = result;

          if (state.analysisFen === afterFen || token === state.analysisToken) {
            state.analysisResult = result;
            setStatus(`Analysis board: ${played.san} is marked ${label.toLowerCase()} (${accuracy}% accuracy).`);
            updateEvalBar(state.currentPlyIndex);
          }
        } catch (error) {
          console.error("Analysis board move failed", error);
          setStatus("Could not analyze that move.");
        } finally {
          if (token === state.analysisToken) {
            state.analysisPending = false;
            updateAnalysisActionButtons();
            renderBoardAtPly(state.currentPlyIndex);
          }
        }
      });
  }

  async function playEngineMove() {
    ensureAnalysisBoard();

    const beforeFen = createChessFromFen(state.analysisFen).fen();
    const stockfish = await getStockfish();
    const profile = getAnalysisProfile(state.currentMoves.length + state.analysisMoves.length + 1);
    clearAnalysisSelection();

    try {
      const best = await stockfish.analyzeFen(beforeFen, { depth: Math.min(profile.bestDepth, 10) });
      if (!best?.bestmove || best.bestmove === "(none)") {
        throw new Error("No engine move available.");
      }
      await applyAnalysisMove(
        {
          from: best.bestmove?.slice(0, 2),
          to: best.bestmove?.slice(2, 4),
          promotion: best.bestmove?.slice(4) || undefined
        },
        best
      );
    } catch (error) {
      console.error("Engine move failed", error);
      state.analysisPending = false;
      updateAnalysisActionButtons();
      setStatus("Could not play the engine move from this position.");
      renderBoardAtPly(state.currentPlyIndex);
    }
  }

  async function handleBoardClick(event) {
    const squareElement = event.target.closest("[data-square]");
    if (!squareElement) {
      return;
    }

    const clickedSquare = squareElement.getAttribute("data-square");
    const square = ensureAnalysisBoard(clickedSquare);
    const chess = createChessFromFen(state.analysisFen);
    const legalMoves = chess.moves({ square, verbose: true });
    const piece = chess.get(square);

    if (state.analysisSelectedSquare) {
      const selectedMoves = chess.moves({ square: state.analysisSelectedSquare, verbose: true });
      const chosenMove = selectedMoves.find((move) => move.to === square) || null;

      if (chosenMove) {
        await applyAnalysisMove({
          from: chosenMove.from,
          to: chosenMove.to,
          promotion: chosenMove.promotion
        });
        return;
      }

      if (state.analysisSelectedSquare === square) {
        clearAnalysisSelection();
        renderBoardAtPly(state.currentPlyIndex);
        return;
      }
    }

    if (!piece || piece.color !== chess.turn() || !legalMoves.length) {
      if (piece && piece.color !== chess.turn()) {
        setStatus(`Edit mode: it is ${chess.turn() === "w" ? "White" : "Black"} to move from this position.`);
      }
      clearAnalysisSelection();
      renderBoardAtPly(state.currentPlyIndex);
      return;
    }

    state.analysisSelectedSquare = square;
    state.analysisLegalTargets = legalMoves.map((move) => move.to);
    renderBoardAtPly(state.currentPlyIndex);
  }

  function decodeTcn(tcn) {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";
    const promoPieces = "qnrbkp";
    const moves = [];

    function indexToSquare(index) {
      const file = index % 8;
      const rank = Math.floor(index / 8) + 1;
      return `${"abcdefgh"[file]}${rank}`;
    }

    for (let i = 0; i < tcn.length; i += 2) {
      let code1 = alphabet.indexOf(tcn[i]);
      let code2 = alphabet.indexOf(tcn[i + 1]);
      const move = {};

      if (code1 < 0 || code2 < 0) {
        throw new Error("Chess.com returned an unreadable move list.");
      }

      if (code2 > 63) {
        const promoIndex = Math.floor((code2 - 64) / 3);
        move.promotion = promoPieces[promoIndex];
        const offset = ((code2 - 1) % 3) - 1;
        const direction = code1 < 16 ? -8 : 8;
        code2 = code1 + direction + offset;
      }

      if (code1 > 75) {
        move.drop = promoPieces[code1 - 79];
      } else {
        move.from = indexToSquare(code1);
      }

      move.to = indexToSquare(code2);
      moves.push(move);
    }

    return moves;
  }

  function toMoveNumber(plyIndex, color) {
    return color === "w" ? Math.floor(plyIndex / 2) + 1 : Math.ceil((plyIndex + 1) / 2);
  }

  function buildMoveList(gameData) {
    const tcn = gameData?.game?.moveList;

    if (!tcn) {
      throw new Error("This game page did not expose a move list.");
    }

    const initialFen = gameData?.game?.fen || undefined;
    const chess = initialFen ? new Chess(initialFen) : new Chess();
    const decodedMoves = decodeTcn(tcn);
    const moves = [];

    decodedMoves.forEach((move, index) => {
      if (move.drop) {
        throw new Error("Variant drop moves are not supported in this MVP.");
      }

      const beforeFen = chess.fen();
      const played = chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || "q"
      });

      if (!played) {
        throw new Error(`Illegal move encountered at ply ${index + 1}.`);
      }

      moves.push({
        plyIndex: index,
        moveNumber: toMoveNumber(index, played.color),
        color: played.color,
        beforeFen,
        afterFen: chess.fen(),
        from: played.from,
        to: played.to,
        uci: `${played.from}${played.to}${played.promotion || ""}`,
        san: played.san
      });
    });

    return moves;
  }

  class StockfishClient {
    constructor() {
      const stockfishUrl = chrome.runtime.getURL("vendor-stockfish.js");
      const wasmUrl = chrome.runtime.getURL("vendor-stockfish.wasm");
      const workerSource = `
        importScripts(${JSON.stringify(stockfishUrl)});
      `;
      const workerBlob = new Blob([workerSource], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(workerBlob);

      this.worker = new Worker(`${workerUrl}#${encodeURIComponent(wasmUrl)}`);
      URL.revokeObjectURL(workerUrl);
      this.phase = "boot";
      this.pending = null;
      this.searchQueue = Promise.resolve();
      this.worker.addEventListener("message", (event) => this.handleLine(String(event.data || "")));
    }

    async init() {
      await new Promise((resolve) => {
        this._waitFor = { token: "uciok", resolve };
        this.worker.postMessage("uci");
      });

      await new Promise((resolve) => {
        this._waitFor = { token: "readyok", resolve };
        this.worker.postMessage("isready");
      });

      this.worker.postMessage("setoption name MultiPV value 1");
      this.worker.postMessage("ucinewgame");
    }

    handleLine(raw) {
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

      for (const line of lines) {
        if (this._waitFor && line === this._waitFor.token) {
          const waitFor = this._waitFor;
          this._waitFor = null;
          waitFor.resolve();
          continue;
        }

        if (this.pending && line.startsWith("info ")) {
          const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
          const pvMatch = line.match(/\spv\s(.+)$/);

          if (scoreMatch) {
            this.pending.score = {
              unit: scoreMatch[1],
              value: Number(scoreMatch[2])
            };
          }

          if (pvMatch) {
            this.pending.pv = pvMatch[1].trim();
          }
        }

        if (this.pending && line.startsWith("bestmove ")) {
          const bestmove = line.split(/\s+/)[1];
          const resolve = this.pending.resolve;
          const payload = {
            bestmove,
            score: this.pending.score,
            pv: this.pending.pv
          };
          this.pending = null;
          resolve(payload);
        }
      }
    }

    analyzeFen(fen, options = {}) {
      const runSearch = () =>
        new Promise((resolve) => {
          const request = {
            score: null,
            pv: "",
            resolve: (payload) => {
              clearTimeout(timeoutId);
              resolve(payload);
            }
          };

          const timeoutId = setTimeout(() => {
            if (this.pending === request) {
              this.pending = null;
              resolve({
                bestmove: "(none)",
                score: request.score,
                pv: request.pv
              });
            }
          }, 8000);

          this.pending = request;
          this.worker.postMessage("stop");
          this.worker.postMessage(`position fen ${fen}`);
          const depth = Number(options.depth);
          if (Number.isFinite(depth) && depth > 0) {
            this.worker.postMessage(`go depth ${depth}`);
            return;
          }
          const moveTimeMs = Number(options.movetime);
          this.worker.postMessage(`go movetime ${Number.isFinite(moveTimeMs) && moveTimeMs > 0 ? moveTimeMs : 250}`);
        });

      this.searchQueue = this.searchQueue.catch(() => {}).then(runSearch);
      return this.searchQueue;
    }

    terminate() {
      this.worker.postMessage("quit");
      this.worker.terminate();
    }
  }

  async function getStockfish() {
    if (!state.stockfish) {
      state.stockfish = new StockfishClient();
      await state.stockfish.init();
    }

    return state.stockfish;
  }

  async function fetchGameData(gameId) {
    const response = await fetch(`https://www.chess.com/callback/live/game/${gameId}`, {
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error("Could not load this Chess.com game.");
    }

    return response.json();
  }

  function isFinishedGame(gameData) {
    const result = gameData?.game?.pgnHeaders?.Result;
    return Boolean(result && result !== "*");
  }

  function uciToSan(fen, uci) {
    if (!uci || uci === "(none)") {
      return "";
    }

    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4) || undefined
    });

    return move ? move.san : uci;
  }

  function pvToSan(fen, pv) {
    if (!pv) {
      return "";
    }

    const chess = new Chess(fen);
    const moves = [];

    for (const uci of pv.split(/\s+/).slice(0, 5)) {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined
      });

      if (!move) {
        break;
      }

      moves.push(move.san);
    }

    return moves.join(" ");
  }

  async function runAnalysis() {
    try {
      ensureUi();
      resetAnalysisBoard();
      state.root.classList.remove("crf-hidden");
      state.launcher.classList.add("crf-hidden");
      state.analyzeButton.disabled = true;
      setStatus("Loading Chess.com game data...");
      setProgress(0, 1);
      state.summary.innerHTML = "";
      state.moves.innerHTML = "";
      renderChart([]);
      updateEvalBar(0);

      const gameId = parseGameId();

      if (!gameId) {
        throw new Error("Open a Chess.com live game page first.");
      }

      const gameData = await fetchGameData(gameId);

      if (!isFinishedGame(gameData)) {
        throw new Error("This extension only runs after the game has finished.");
      }

      state.viewerColor = resolveViewerColor(gameData);
      state.boardOrientation = viewerColorToBoardOrientation(state.viewerColor);

      const moves = buildMoveList(gameData);
      state.currentMoves = moves;
      state.currentResults = [];
      state.currentPlyIndex = 0;
      renderBoardAtPly(0);

      if (!moves.length) {
        throw new Error("No moves were found for this game.");
      }

      const stockfish = await getStockfish();
      const profile = getAnalysisProfile(moves.length);
      const results = [];
      const bestAnalyses = [];
      let finalPositionAnalysis = null;

      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index];
        setStatus(`Analyzing move ${index + 1} of ${moves.length}: ${move.san}`);
        setProgress(index, moves.length);

        const best = await stockfish.analyzeFen(move.beforeFen, { depth: profile.bestDepth });
        bestAnalyses.push(best);
      }

      if (moves.length) {
        setStatus(`Finishing final position check...`);
        const finalRaw = await stockfish.analyzeFen(
          moves[moves.length - 1].afterFen,
          { depth: profile.finalDepth }
        );
        // normalizeScoreForFen handles the side-to-move flip, so no manual negation needed.
        finalPositionAnalysis = finalRaw;
      }

      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index];
        const best = bestAnalyses[index];
        const playedPosition = bestAnalyses[index + 1] || finalPositionAnalysis;

        const bestScore = normalizeScoreForFen(best.score, move.beforeFen);
        const afterScore = normalizeScoreForFen(playedPosition.score, move.afterFen);
        const bestMoverScore = perspectiveScoreForColor(bestScore, move.color);
        const playedMoverScore = perspectiveScoreForColor(afterScore, move.color);
        const bestCp = scoreToCp(bestMoverScore);
        const playedCp = scoreToCp(playedMoverScore);
        const cpl = Math.max(0, Math.round(bestCp - playedCp));
        const accuracy = accuracyFromCpl(cpl);
        const label = classifyMove(cpl, move.uci, best.bestmove);

        results.push({
          ...move,
          cpl,
          accuracy,
          label,
          bestUci: best.bestmove,
          bestSan: uciToSan(move.beforeFen, best.bestmove),
          playedScore: { unit: "cp", value: playedCp },
          afterScore,
          bestScore,
          pvSan: pvToSan(move.beforeFen, best.pv)
        });

        state.currentResults = results.slice();

        if (index === moves.length - 1 || index % 6 === 0) {
          renderSummary(results);
          renderMoves(results);
          renderChart(results);
        }
      }

      setProgress(moves.length, moves.length);
      renderBoardAtPly(0);
      setStatus(`Finished. Reviewed ${results.length} ply with a local Stockfish engine.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Analysis failed.");
    } finally {
      if (state.analyzeButton) {
        state.analyzeButton.disabled = false;
      }
    }
  }

  function maybeMount() {
    if (state.destroyed) {
      return;
    }

    const gameId = parseGameId();
    if (!gameId) {
      return;
    }

    ensureUi();
    state.viewerColor = resolveViewerColor({});
    state.boardOrientation = viewerColorToBoardOrientation(state.viewerColor);
    setStatus("Ready for post-game analysis.");
  }

  maybeMount();
  window.addEventListener("popstate", () => setTimeout(maybeMount, RETRY_DELAY_MS));
  new MutationObserver(() => {
    if (!document.getElementById(LAUNCHER_ID)) {
      maybeMount();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
