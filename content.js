(async () => {
  if (window.top !== window.self) {
    return;
  }

  const { Chess } = await import(chrome.runtime.getURL("vendor-chess.js"));

  const PANEL_ID = "crf-root";
  const LAUNCHER_ID = "crf-launcher";
  const MAX_MOVES_TO_ANALYZE = 80;
  const MOVE_TIME_MS = 700;
  const FOLLOW_UP_TIME_MS = 900;
  const DEEP_EVAL_TIME_MS = 2200;
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
    prevMoveButton: null,
    nextMoveButton: null,
    dragPointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    stockfish: null,
    currentMoves: [],
    currentResults: [],
    currentPlyIndex: 0,
    boardOrientation: "white",
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

  function detectBoardOrientation() {
    const boardElement = document.querySelector("chess-board");

    if (boardElement?.classList.contains("flipped")) {
      return "black";
    }

    return "white";
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
    state.prevMoveButton = root.querySelector("#crf-prev-move");
    state.nextMoveButton = root.querySelector("#crf-next-move");
    state.evalFill = root.querySelector("#crf-eval-fill");
    state.evalTop = root.querySelector("#crf-eval-top");
    state.evalBottom = root.querySelector("#crf-eval-bottom");
    state.analyzeButton = root.querySelector("#crf-analyze");
    state.analyzeButton.addEventListener("click", runAnalysis);
    state.prevMoveButton.addEventListener("click", () => stepBoard(-1));
    state.nextMoveButton.addEventListener("click", () => stepBoard(1));
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

    const parts = fen.split(" ");
    const sideToMove = parts[1] || "w";
    const multiplier = sideToMove === "w" ? 1 : -1;

    return {
      unit: score.unit,
      value: score.value * multiplier
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

  function selectedScoreForPly(plyIndex) {
    if (!state.currentResults.length || plyIndex <= 0) {
      return { unit: "cp", value: 0 };
    }

    const move = state.currentResults[Math.min(plyIndex - 1, state.currentResults.length - 1)];
    return move.afterScore || { unit: "cp", value: 0 };
  }

  function evalFractionFromScore(score) {
    const cp = scoreToCp(score);
    const normalized = clamp(cp / 400, -1, 1);
    return (normalized + 1) / 2;
  }

  function updateEvalBar(plyIndex) {
    if (!state.evalFill || !state.evalTop || !state.evalBottom) {
      return;
    }

    const score = selectedScoreForPly(plyIndex);
    const fraction = evalFractionFromScore(score);
    const text = score.unit === "mate" ? `#${score.value}` : `${score.value >= 0 ? "+" : ""}${humanScore(score)}`;

    state.evalFill.style.height = `${Math.round(fraction * 100)}%`;

    if (state.boardOrientation === "black") {
      state.evalTop.textContent = text;
      state.evalBottom.textContent = "";
    } else {
      state.evalTop.textContent = "";
      state.evalBottom.textContent = text;
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
      const deep = await stockfish.analyzeFen(move.afterFen, DEEP_EVAL_TIME_MS);

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

    const summaryCards = [
      { label: "White Accuracy", value: `${gameAccuracyFromMoves(white)}%` },
      { label: "Black Accuracy", value: `${gameAccuracyFromMoves(black)}%` },
      { label: "Moves Reviewed", value: String(results.length) },
      { label: "Biggest Miss", value: `${Math.max(...results.map((move) => move.cpl), 0)} cp` }
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
              <span class="crf-kbd">Loss ${move.cpl} cp</span>
              <span class="crf-kbd">Eval ${escapeHtml(humanScore(move.playedScore))}</span>
            </div>
            <p class="crf-muted">Best move: <strong>${escapeHtml(move.bestSan || move.bestUci || "N/A")}</strong> · Played: <strong>${escapeHtml(move.san)}</strong></p>
            <p class="crf-muted">Engine line: ${escapeHtml(move.pvSan || move.bestUci || "N/A")}</p>
          </article>
        `;
      })
      .join("");

    state.moves.querySelectorAll("[data-ply-index]").forEach((element) => {
      element.addEventListener("click", () => {
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
      const normalized = clamp(scoreToCp(move.afterScore) / 100, -8, 8);
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
    if (!state.currentMoves.length || plyIndex <= 0) {
      return null;
    }

    return state.currentMoves[Math.min(plyIndex - 1, state.currentMoves.length - 1)].afterFen;
  }

  function captionForPly(plyIndex) {
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
    const fen = fenForPly(state.currentPlyIndex);
    const chess = fen ? new Chess(fen) : new Chess();
    const files =
      state.boardOrientation === "black"
        ? ["h", "g", "f", "e", "d", "c", "b", "a"]
        : ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ranks =
      state.boardOrientation === "black"
        ? [1, 2, 3, 4, 5, 6, 7, 8]
        : [8, 7, 6, 5, 4, 3, 2, 1];
    const selectedMove =
      state.currentPlyIndex > 0
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

            return `
              <div class="crf-square ${squareClass}" data-square="${square}">
                ${stickerMarkup}
                <span class="crf-piece">${escapeHtml(piece ? pieceGlyph(piece) : "")}</span>
              </div>
            `;
          })
          .join("")
      )
      .join("");

    state.boardCaption.textContent = captionForPly(state.currentPlyIndex);
    state.prevMoveButton.disabled = state.currentPlyIndex <= 0;
    state.nextMoveButton.disabled = state.currentPlyIndex >= state.currentMoves.length;
    updateEvalBar(state.currentPlyIndex);
    void refineSelectedEval(state.currentPlyIndex);

    state.moves.querySelectorAll("[data-ply-index]").forEach((element) => {
      const isActive = Number(element.getAttribute("data-ply-index")) === state.currentPlyIndex;
      element.classList.toggle("crf-move-active", isActive);
    });
  }

  function stepBoard(direction) {
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

    analyzeFen(fen, moveTimeMs) {
      return new Promise((resolve) => {
        this.pending = {
          resolve,
          score: null,
          pv: ""
        };
        this.worker.postMessage(`position fen ${fen}`);
        this.worker.postMessage(`go movetime ${moveTimeMs}`);
      });
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
      state.boardOrientation = detectBoardOrientation();

      if (!isFinishedGame(gameData)) {
        throw new Error("This extension only runs after the game has finished.");
      }

      const allMoves = buildMoveList(gameData);
      const moves = allMoves.slice(0, MAX_MOVES_TO_ANALYZE);
      state.currentMoves = moves;
      state.currentResults = [];
      state.currentPlyIndex = 0;
      renderBoardAtPly(0);

      if (!moves.length) {
        throw new Error("No moves were found for this game.");
      }

      const stockfish = await getStockfish();
      const results = [];

      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index];
        setStatus(`Analyzing move ${index + 1} of ${moves.length}: ${move.san}`);
        setProgress(index, moves.length);

        const best = await stockfish.analyzeFen(move.beforeFen, MOVE_TIME_MS);
        const playedPosition = await stockfish.analyzeFen(move.afterFen, FOLLOW_UP_TIME_MS);

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
        renderSummary(results);
        renderMoves(results);
        renderChart(results);
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
    state.boardOrientation = detectBoardOrientation();
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
