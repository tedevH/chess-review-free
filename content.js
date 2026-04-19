(async () => {
  if (window.top !== window.self) {
    return;
  }

  function isExtensionContextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function safeRuntimeGetURL(path) {
    if (!isExtensionContextValid()) {
      throw new Error("Extension context invalidated");
    }

    return chrome.runtime.getURL(path);
  }

  function runtimeSafeMessage(error, fallback = "Analysis failed.") {
    if (isContextInvalidatedError(error) || !isExtensionContextValid()) {
      return "The extension was reloaded. Refresh the page and run the review again.";
    }

    return error instanceof Error ? error.message : fallback;
  }

  let Chess;
  try {
    ({ Chess } = await import(safeRuntimeGetURL("vendor-chess.js")));
  } catch (error) {
    console.error("Failed to initialize Chess Review Free", error);
    return;
  }

  const PANEL_ID = "crf-root";
  const LAUNCHER_ID = "crf-launcher";
  const RETRY_DELAY_MS = 1200;

  const state = {
    root: null,
    launcher: null,
    status: null,
    progressBar: null,
    resultBadge: null,
    reasonLabel: null,
    reasonText: null,
    blunderStat: null,
    mistakeStat: null,
    focusLabel: null,
    focusText: null,
    insightList: null,
    summary: null,
    moves: null,
    chart: null,
    analyzeButton: null,
    board: null,
    boardCoordinates: null,
    boardCaption: null,
    boardHelper: null,
    coachLabel: null,
    coachExplanation: null,
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

  function hasCompleteMoveData(move) {
    return Boolean(
      move &&
      typeof move.from === "string" &&
      typeof move.to === "string" &&
      typeof move.beforeFen === "string" &&
      typeof move.afterFen === "string" &&
      typeof move.color === "string"
    );
  }

  function emptyKingSafetySnapshot() {
    return {
      kingSquare: null,
      castled: false,
      attackers: 0,
      legalEscapes: 0,
      shieldMissing: 0,
      danger: 0
    };
  }

  function emptyMoveFeatures(move = {}) {
    return {
      movedPiece: null,
      ownLooseBefore: [],
      ownLooseAfter: [],
      enemyLooseBefore: [],
      movedPieceLooseAfter: null,
      bestForkTargets: [],
      playedForkTargets: [],
      beforeKing: emptyKingSafetySnapshot(),
      afterKing: emptyKingSafetySnapshot(),
      beforeEnemyKing: emptyKingSafetySnapshot(),
      afterEnemyKing: emptyKingSafetySnapshot(),
      beforePawns: { pawns: [], isolated: [], doubled: [], passed: [] },
      afterPawns: { pawns: [], isolated: [], doubled: [], passed: [] },
      createdIsolatedPawn: false,
      createdPassedPawn: false,
      improvedDevelopment: false,
      repeatedPieceInOpening: false,
      earlyQueenOrRookMove: false,
      flankPawnMove: false,
      captureTradeDown: false,
      lateMistakePattern: false,
      captureInfo: null,
      featuresDetected: [],
      phase: phaseForMove(Number.isFinite(move?.moveNumber) ? move.moveNumber : 1),
      color: move?.color || "w",
      isEndgame: false,
      movedPieceName: "piece",
      beforeMaterial: 0,
      afterMaterial: 0,
      beforeCenter: { occupiedCore: 0, occupiedExtended: 0, attackedCore: 0, attackedExtended: 0, controlScore: 0 },
      afterCenter: { occupiedCore: 0, occupiedExtended: 0, attackedCore: 0, attackedExtended: 0, controlScore: 0 },
      enemyBeforeCenter: { occupiedCore: 0, occupiedExtended: 0, attackedCore: 0, attackedExtended: 0, controlScore: 0 },
      enemyAfterCenter: { occupiedCore: 0, occupiedExtended: 0, attackedCore: 0, attackedExtended: 0, controlScore: 0 },
      beforeDevelopment: 0,
      afterDevelopment: 0,
      isCastling: false,
      isCapture: false,
      isCheck: false,
      isPawnBreak: false,
      pawnWeakening: {
        lostControlSquares: [],
        weakSquares: [],
        criticalWeakSquares: [],
        outposts: [],
        primaryWeakSquare: null,
        primaryOutpost: null
      },
      createdWeakSquare: false,
      createdCriticalWeakSquare: false,
      createdOpponentOutpost: false,
      occupiesOutpost: false,
      rookActivation: false,
      activatedKing: false,
      simplified: false,
      pressuredEnemyKing: false,
      centralOccupationGain: 0,
      centralControlGain: 0,
      enemyCentralGain: 0,
      gainsSpace: false,
      threatResponse: false,
      addressesThreat: false,
      wasAhead: false,
      wasBehind: false,
      tradeQueens: false,
      winsMaterial: false,
      losesMaterial: false,
      opensDiagonal: false,
      openingSlowMove: false,
      prophylacticPawnIdea: null,
      blockedOwnBishop: false,
      immediatePunish: null,
      bestMoveImprovesDevelopmentMore: false,
      bestMoveFeatures: null
    };
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

  const MISTAKE_COPY = {
    hung_piece: "You hang pieces in the middlegame.",
    time_pressure: "Time pressure is turning decent positions into mistakes.",
    late_game_blunder: "Late-game blunders are undoing your earlier work.",
    early_game_mistake: "Early mistakes are putting you behind right away.",
    opening_principle_violation: "You are drifting from basic opening principles too early.",
    slow_move: "Slow developing moves are costing you time and initiative.",
    missed_threat: "You missed your opponent's threat in a critical moment.",
    bad_trade: "A bad trade left you worse in the resulting position.",
    king_safety: "Your king became too exposed and the position collapsed.",
    missed_tactic: "You missed a tactical idea that changed the game.",
    fork_tactic: "You missed a double attack that changed the position immediately.",
    back_rank: "Your back rank became a real tactical problem.",
    isolated_pawn: "Your pawn structure picked up a weakness that was easy to target.",
    passed_pawn: "You let a passed pawn become the main story of the position."
  };

  const STRENGTH_COPY = {
    capitalized_blunder: "You capitalized on opponent mistakes.",
    solid_endgame: "You converted the endgame cleanly.",
    good_time_management: "You stayed composed as the game got longer.",
    strong_opening: "You built the better position out of the opening.",
    strong_attack: "You created pressure on the king and made it count.",
    good_conversion: "You kept control after getting the advantage.",
    loose_piece_punished: "You punished a loose piece immediately.",
    tactical_shot: "You found a tactical shot that changed the position.",
    passed_pawn_play: "You used a passed pawn or endgame runner well."
  };

  const PIECE_NAMES = {
    p: "pawn",
    n: "knight",
    b: "bishop",
    r: "rook",
    q: "queen",
    k: "king"
  };

  const PIECE_VALUES = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
    k: 100
  };

  const STARTING_SQUARES = {
    w: {
      k: ["e1"],
      q: ["d1"],
      r: ["a1", "h1"],
      b: ["c1", "f1"],
      n: ["b1", "g1"]
    },
    b: {
      k: ["e8"],
      q: ["d8"],
      r: ["a8", "h8"],
      b: ["c8", "f8"],
      n: ["b8", "g8"]
    }
  };

  const CONCEPT_TAXONOMY = {
    openingPrinciples: {
      label: "Opening Principles",
      definition: "How a move affects development, the center, tempo, and king safety before the middlegame really starts.",
      concepts: [
        "control of the center",
        "occupation of the center",
        "pressure on the center",
        "development",
        "development lead",
        "loss of tempo",
        "gain of tempo",
        "moving the same piece twice",
        "premature queen development",
        "castling",
        "delayed castling",
        "king safety in the opening",
        "creating luft too early",
        "flank pawn move in the opening",
        "opening a line",
        "closing the center",
        "opening the center",
        "central tension",
        "pawn break",
        "overextension",
        "initiative in the opening",
        "transition from opening to middlegame"
      ]
    },
    tacticalMotifs: {
      label: "Tactical Motifs",
      definition: "Short forcing ideas that win material, create threats, or punish loose coordination immediately.",
      concepts: [
        "fork",
        "double attack",
        "pin",
        "absolute pin",
        "relative pin",
        "skewer",
        "discovered attack",
        "discovered check",
        "double check",
        "deflection",
        "decoy",
        "interference",
        "clearance",
        "removal of the defender",
        "overloading",
        "x-ray attack",
        "zwischenzug",
        "desperado",
        "attraction",
        "trapping a piece",
        "loose piece",
        "hanging piece",
        "underdefended piece",
        "back-rank weakness",
        "mating net",
        "perpetual check",
        "smothered mate",
        "back-rank mate",
        "Greek gift sacrifice",
        "sacrifice for initiative",
        "tactical shot",
        "forcing sequence",
        "checks captures threats scan",
        "tactical oversight",
        "missed tactic"
      ]
    },
    strategicConcepts: {
      label: "Strategic / Positional Concepts",
      definition: "Longer-term ideas about space, piece quality, files, diagonals, squares, and overall coordination.",
      concepts: [
        "strong center",
        "weak center",
        "space advantage",
        "cramped position",
        "open file",
        "half-open file",
        "closed file",
        "control of a file",
        "seventh rank invasion",
        "open diagonal",
        "long diagonal pressure",
        "weak square",
        "hole",
        "outpost",
        "color complex",
        "dark-square weakness",
        "light-square weakness",
        "bishop pair",
        "bad bishop",
        "good bishop",
        "knight outpost",
        "knight vs bishop imbalance",
        "rook activity",
        "queen activity",
        "piece coordination",
        "piece harmony",
        "piece improvement",
        "piece rerouting",
        "piece activation",
        "passive piece",
        "active piece",
        "domination",
        "restriction",
        "prophylaxis",
        "overprotection",
        "initiative",
        "compensation",
        "structural concession",
        "static weakness",
        "dynamic advantage",
        "imbalance",
        "transition into favorable structure"
      ]
    },
    pawnStructureConcepts: {
      label: "Pawn Structure Concepts",
      definition: "How pawns shape long-term plans, create targets, and determine where the play belongs.",
      concepts: [
        "pawn chain",
        "pawn lever",
        "pawn break",
        "passed pawn",
        "protected passed pawn",
        "outside passed pawn",
        "connected passed pawns",
        "isolated pawn",
        "isolated queen pawn",
        "backward pawn",
        "doubled pawns",
        "tripled pawns",
        "hanging pawns",
        "pawn island",
        "minority attack",
        "majority attack",
        "fixed pawns",
        "mobile pawns",
        "weak pawn",
        "strong pawn center",
        "pawn storm",
        "kingside pawn storm",
        "queenside expansion",
        "undermining a pawn chain",
        "blockading a pawn",
        "blockade square",
        "creating a target",
        "pawn weakness",
        "overextended pawns",
        "pawn shelter",
        "pawn cover",
        "destroying pawn shelter"
      ]
    },
    kingSafetyConcepts: {
      label: "King Safety Concepts",
      definition: "Whether the king is secure, exposed, under pressure, or becoming the natural target of the position.",
      concepts: [
        "castled king safety",
        "exposed king",
        "uncastled king",
        "shattered kingside",
        "weakened dark squares around king",
        "weakened light squares around king",
        "open lines to king",
        "file opened against king",
        "diagonal opened against king",
        "lack of defenders around king",
        "attacking chances against king",
        "overextended pawn shield",
        "unsafe king walk",
        "mating net formation",
        "exchange sacrifice for attack",
        "piece concentration near king"
      ]
    },
    middlegamePlanningConcepts: {
      label: "Middlegame Planning Concepts",
      definition: "Plans about where to play, when to trade, how to build pressure, and how to handle tension and counterplay.",
      concepts: [
        "attack on king",
        "attack on center",
        "attack on flank",
        "minority attack",
        "central break",
        "queenside play",
        "kingside play",
        "improving worst-placed piece",
        "converting initiative",
        "preventing counterplay",
        "simplifying into favorable ending",
        "avoiding simplification",
        "maintaining tension",
        "releasing tension too early",
        "exchanging attacking piece",
        "favorable trade",
        "unfavorable trade",
        "good trade",
        "bad trade",
        "strategic concession",
        "fixing a weakness",
        "creating a second weakness",
        "target selection",
        "plan consistency",
        "plan mismatch",
        "too slow for the position",
        "automatic move that ignores position demands"
      ]
    },
    endgameConcepts: {
      label: "Endgame Concepts",
      definition: "Technique, king activity, pawn races, rook activity, theoretical methods, and conversion mechanics once the pieces come off.",
      concepts: [
        "king activity",
        "king centralization",
        "opposition",
        "distant opposition",
        "triangulation",
        "zugzwang",
        "fortress",
        "breakthrough",
        "outside passed pawn",
        "connected passed pawns",
        "rook behind passed pawn",
        "active rook",
        "passive rook",
        "rook on seventh rank",
        "cutting off the king",
        "converting extra pawn",
        "converting material advantage",
        "simplifying while ahead",
        "trading pieces not pawns",
        "wrong rook pawn",
        "wrong bishop rook pawn ending",
        "theoretical draw",
        "Lucena-type bridge idea",
        "Philidor-type defensive setup",
        "rook activity over pawn grabbing",
        "bishop of wrong color",
        "knight blockade",
        "drawing mechanism",
        "winning mechanism"
      ]
    },
    practicalPlayConcepts: {
      label: "Time / Practical Play Concepts",
      definition: "Decisions shaped by clock pressure, practical simplification, risk management, and the easiest way to play the position.",
      concepts: [
        "time pressure",
        "blitz practical decision",
        "safe simplification",
        "risky complication",
        "practical chances",
        "avoiding opponent counterplay",
        "choosing easier move over best move",
        "playing too fast",
        "playing too slowly",
        "using forcing moves under time pressure",
        "practical conversion",
        "practical defense"
      ]
    }
  };

  const MOVE_PURPOSES = [
    "develop a piece",
    "improve a piece",
    "defend a piece",
    "defend a square",
    "contest the center",
    "occupy the center",
    "gain space",
    "create counterplay",
    "attack king",
    "attack structure",
    "open a file",
    "open a diagonal",
    "create a passed pawn",
    "fix a weakness",
    "exploit a weakness",
    "trade pieces",
    "trade queens",
    "simplify",
    "increase tension",
    "release tension",
    "prepare a pawn break",
    "execute a pawn break",
    "improve king safety",
    "stop a threat",
    "prevent opponent plan",
    "win material",
    "start tactical sequence",
    "convert advantage",
    "hold a draw",
    "activate king",
    "activate rook",
    "create an outpost",
    "occupy an outpost",
    "blockade a pawn"
  ];

  function oppositeColor(color) {
    return color === "w" ? "b" : "w";
  }

  function capitalizeWord(value) {
    if (!value) {
      return "";
    }

    return `${value[0].toUpperCase()}${value.slice(1)}`;
  }

  function movePrefixText(move) {
    const san = move.san || move.moveSan || move.bestSan || "move";
    return `${move.color === "w" ? `${move.moveNumber}.` : `${move.moveNumber}...`} ${san}`;
  }

  function pieceValue(piece) {
    if (!piece) {
      return 0;
    }

    const type = typeof piece === "string" ? piece : piece.type;
    return PIECE_VALUES[type] || 0;
  }

  function squareFileIndex(square) {
    return square ? square.charCodeAt(0) - 97 : -1;
  }

  function squareRankIndex(square) {
    return square ? Number(square[1]) : -1;
  }

  function isCenterSquare(square) {
    return ["d4", "d5", "e4", "e5"].includes(square);
  }

  function isExtendedCenterSquare(square) {
    return ["c3", "c4", "c5", "c6", "d3", "d4", "d5", "d6", "e3", "e4", "e5", "e6", "f3", "f4", "f5", "f6"].includes(square);
  }

  function withTurnInFen(fen, turn) {
    const parts = String(fen || "").trim().split(/\s+/);
    if (parts.length < 2) {
      return fen;
    }

    parts[1] = turn;
    return parts.join(" ");
  }

  function safePieceAtFen(fen, square) {
    try {
      return new Chess(fen).get(square);
    } catch {
      return null;
    }
  }

  function collectPieces(fen, color, type = null) {
    try {
      const chess = new Chess(fen);
      const board = chess.board();
      const pieces = [];

      board.forEach((rank, rankIndex) => {
        rank.forEach((piece, fileIndex) => {
          if (!piece || piece.color !== color || (type && piece.type !== type)) {
            return;
          }

          pieces.push({
            square: `${String.fromCharCode(97 + fileIndex)}${8 - rankIndex}`,
            ...piece
          });
        });
      });

      return pieces;
    } catch {
      return [];
    }
  }

  function attackerSquares(fen, square, color) {
    try {
      return new Chess(fen).attackers(square, color) || [];
    } catch {
      return [];
    }
  }

  function findKingSquare(fen, color) {
    return collectPieces(fen, color, "k")[0]?.square || null;
  }

  function isPieceOnStartingSquare(type, square, color) {
    return STARTING_SQUARES[color]?.[type]?.includes(square) || false;
  }

  function countDevelopedMinorPieces(fen, color) {
    return collectPieces(fen, color)
      .filter((piece) => ["n", "b"].includes(piece.type))
      .filter((piece) => !isPieceOnStartingSquare(piece.type, piece.square, color))
      .length;
  }

  function countLoosePieces(fen, color) {
    return collectPieces(fen, color)
      .filter((piece) => piece.type !== "k")
      .map((piece) => {
        const attackers = attackerSquares(fen, piece.square, oppositeColor(color));
        const defenders = attackerSquares(fen, piece.square, color);
        return {
          square: piece.square,
          type: piece.type,
          attackers: attackers.length,
          defenders: defenders.length,
          piece
        };
      })
      .filter((entry) => entry.attackers > 0 && entry.defenders < entry.attackers);
  }

  function isLoosePieceAtSquare(fen, color, square) {
    return countLoosePieces(fen, color).find((piece) => piece.square === square) || null;
  }

  function kingSafetySnapshot(fen, color) {
    const kingSquare = findKingSquare(fen, color);
    if (!kingSquare) {
      return {
        kingSquare: null,
        castled: false,
        attackers: 0,
        legalEscapes: 0,
        shieldMissing: 0,
        danger: 0
      };
    }

    const enemyColor = oppositeColor(color);
    const enemyAttackers = attackerSquares(fen, kingSquare, enemyColor);
    const castledSquares = color === "w" ? ["g1", "c1"] : ["g8", "c8"];
    const castled = castledSquares.includes(kingSquare);
    let shieldSquares = [];

    if (kingSquare === "g1") shieldSquares = ["f2", "g2", "h2"];
    if (kingSquare === "c1") shieldSquares = ["a2", "b2", "c2"];
    if (kingSquare === "g8") shieldSquares = ["f7", "g7", "h7"];
    if (kingSquare === "c8") shieldSquares = ["a7", "b7", "c7"];

    const shieldMissing = shieldSquares.filter((square) => {
      const piece = safePieceAtFen(fen, square);
      return !piece || piece.color !== color || piece.type !== "p";
    }).length;

    let legalEscapes = 0;
    try {
      legalEscapes = new Chess(withTurnInFen(fen, color)).moves({ square: kingSquare, verbose: true }).length;
    } catch {
      legalEscapes = 0;
    }

    let danger = enemyAttackers.length * 2 + shieldMissing;
    if (!castled && ["e1", "d1", "e8", "d8"].includes(kingSquare)) {
      danger += 2;
    }
    if (legalEscapes === 0) {
      danger += 1;
    }

    return {
      kingSquare,
      castled,
      attackers: enemyAttackers.length,
      legalEscapes,
      shieldMissing,
      danger
    };
  }

  function hasBackRankWeakness(fen, color) {
    const kingSquare = findKingSquare(fen, color);
    if (!kingSquare) {
      return false;
    }

    const backRank = color === "w" ? "1" : "8";
    if (!kingSquare.endsWith(backRank)) {
      return false;
    }

    const legalEscapes = (() => {
      try {
        return new Chess(withTurnInFen(fen, color)).moves({ square: kingSquare, verbose: true }).length;
      } catch {
        return 0;
      }
    })();

    const heavyAttackers = attackerSquares(fen, kingSquare, oppositeColor(color))
      .map((square) => safePieceAtFen(fen, square))
      .filter((piece) => piece && ["r", "q"].includes(piece.type)).length;

    return legalEscapes === 0 && heavyAttackers > 0;
  }

  function pawnStructureSnapshot(fen, color) {
    const pawns = collectPieces(fen, color, "p");
    const enemyPawns = collectPieces(fen, oppositeColor(color), "p");
    const pawnsByFile = new Map();
    const isolated = [];
    const doubled = [];
    const passed = [];

    pawns.forEach((pawn) => {
      const file = pawn.square[0];
      if (!pawnsByFile.has(file)) {
        pawnsByFile.set(file, []);
      }
      pawnsByFile.get(file).push(pawn.square);
    });

    pawns.forEach((pawn) => {
      const fileIndex = squareFileIndex(pawn.square);
      const leftFile = fileIndex > 0 ? String.fromCharCode(96 + fileIndex) : null;
      const rightFile = fileIndex < 7 ? String.fromCharCode(98 + fileIndex) : null;
      const hasNeighbor = Boolean((leftFile && pawnsByFile.get(leftFile)?.length) || (rightFile && pawnsByFile.get(rightFile)?.length));

      if (!hasNeighbor) {
        isolated.push(pawn.square);
      }

      if ((pawnsByFile.get(pawn.square[0]) || []).length > 1) {
        doubled.push(pawn.square);
      }

      const pawnFile = squareFileIndex(pawn.square);
      const pawnRank = squareRankIndex(pawn.square);
      const enemyAhead = enemyPawns.some((enemyPawn) => {
        const enemyFile = squareFileIndex(enemyPawn.square);
        const enemyRank = squareRankIndex(enemyPawn.square);
        if (Math.abs(enemyFile - pawnFile) > 1) {
          return false;
        }

        return color === "w" ? enemyRank > pawnRank : enemyRank < pawnRank;
      });

      if (!enemyAhead) {
        passed.push(pawn.square);
      }
    });

    return {
      pawns,
      isolated,
      doubled,
      passed
    };
  }

  function applyUciMoveToFen(fen, uci) {
    if (!fen || !uci || uci.length < 4) {
      return null;
    }

    try {
      const chess = new Chess(fen);
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || "q"
      });

      if (!move) {
        return null;
      }

      return {
        chess,
        move,
        afterFen: chess.fen()
      };
    } catch {
      return null;
    }
  }

  function detectForkTargets(fen, color, square) {
    if (!square) {
      return [];
    }

    try {
      const chess = new Chess(withTurnInFen(fen, color));
      const moves = chess.moves({ square, verbose: true });
      const targets = [];

      moves.forEach((candidate) => {
        const targetPiece = safePieceAtFen(fen, candidate.to);
        if (!targetPiece || targetPiece.color !== oppositeColor(color)) {
          return;
        }

        targets.push({
          square: candidate.to,
          type: targetPiece.type,
          value: pieceValue(targetPiece)
        });
      });

      const unique = new Map();
      targets.forEach((target) => {
        unique.set(target.square, target);
      });

      return [...unique.values()].filter((target) => target.value >= 3 || target.type === "k");
    } catch {
      return [];
    }
  }

  function describeTargets(targets) {
    if (!targets.length) {
      return "multiple targets";
    }

    return targets
      .slice(0, 3)
      .map((target) => `${PIECE_NAMES[target.type] || "piece"} on ${target.square}`)
      .join(" and ");
  }

  function inferCaptureInfo(move) {
    try {
      const chess = new Chess(move.beforeFen);
      const played = chess.move({
        from: move.from,
        to: move.to,
        promotion: move.uci?.slice(4) || "q"
      });
      return played || null;
    } catch {
      return null;
    }
  }

  function severityFromCpl(cpl = 0) {
    if (cpl >= 220) {
      return "high";
    }

    if (cpl >= 120) {
      return "medium";
    }

    return "low";
  }

  function extractMoveFeatures(move, allPlayerMoves = []) {
    if (!hasCompleteMoveData(move)) {
      return emptyMoveFeatures(move);
    }

    const movedPiece = safePieceAtFen(move.beforeFen, move.from);
    const enemyColor = oppositeColor(move.color);
    const beforeKing = kingSafetySnapshot(move.beforeFen, move.color);
    const afterKing = kingSafetySnapshot(move.afterFen, move.color);
    const beforeEnemyKing = kingSafetySnapshot(move.beforeFen, enemyColor);
    const afterEnemyKing = kingSafetySnapshot(move.afterFen, enemyColor);
    const beforePawns = pawnStructureSnapshot(move.beforeFen, move.color);
    const afterPawns = pawnStructureSnapshot(move.afterFen, move.color);
    const ownLooseBefore = countLoosePieces(move.beforeFen, move.color);
    const ownLooseAfter = countLoosePieces(move.afterFen, move.color);
    const enemyLooseBefore = countLoosePieces(move.beforeFen, enemyColor);
    const movedPieceLooseAfter = isLoosePieceAtSquare(move.afterFen, move.color, move.to);
    const bestMoveResult = applyUciMoveToFen(move.beforeFen, move.bestUci);
    const playedForkTargets = detectForkTargets(move.afterFen, move.color, move.to);
    const bestForkTargets = bestMoveResult ? detectForkTargets(bestMoveResult.afterFen, move.color, bestMoveResult.move.to) : [];
    const captureInfo = inferCaptureInfo(move);
    const createdIsolatedPawn = afterPawns.isolated.length > beforePawns.isolated.length;
    const createdPassedPawn = afterPawns.passed.length > beforePawns.passed.length;
    const improvedDevelopment = countDevelopedMinorPieces(move.afterFen, move.color) > countDevelopedMinorPieces(move.beforeFen, move.color);
    const repeatedPieceInOpening = Boolean(
      movedPiece &&
      move.moveNumber <= 10 &&
      ["n", "b", "q", "r"].includes(movedPiece.type) &&
      !isPieceOnStartingSquare(movedPiece.type, move.from, move.color)
    );
    const earlyQueenOrRookMove = Boolean(
      movedPiece &&
      move.moveNumber <= 10 &&
      ["q", "r"].includes(movedPiece.type)
    );
    const flankPawnMove = Boolean(
      movedPiece &&
      movedPiece.type === "p" &&
      ["a", "b", "g", "h"].includes(move.to[0]) &&
      move.moveNumber <= 10
    );
    const captureTradeDown = Boolean(
      captureInfo?.captured &&
      movedPiece &&
      pieceValue(movedPiece) > pieceValue(captureInfo.captured) &&
      move.cpl > 100
    );
    const lateMistakePattern = allPlayerMoves.filter((item) => item.moveNumber >= 20 && item.cpl > 100).length >= 2;
    const featuresDetected = [];

    if (movedPieceLooseAfter) featuresDetected.push("hanging_piece");
    if (bestForkTargets.length >= 2) featuresDetected.push("fork_threat");
    if (playedForkTargets.length >= 2) featuresDetected.push("double_attack");
    if (afterKing.danger > beforeKing.danger + 1) featuresDetected.push("king_safety_drop");
    if (hasBackRankWeakness(move.afterFen, move.color)) featuresDetected.push("back_rank_weakness");
    if (createdIsolatedPawn) featuresDetected.push("isolated_pawn");
    if (createdPassedPawn) featuresDetected.push("passed_pawn");
    if (improvedDevelopment) featuresDetected.push("development_gain");
    if (repeatedPieceInOpening || earlyQueenOrRookMove || flankPawnMove) featuresDetected.push("opening_principle_violation");
    if (enemyLooseBefore.length) featuresDetected.push("enemy_loose_piece");
    if (captureTradeDown) featuresDetected.push("bad_trade");

    return {
      movedPiece,
      ownLooseBefore,
      ownLooseAfter,
      enemyLooseBefore,
      movedPieceLooseAfter,
      bestForkTargets,
      playedForkTargets,
      beforeKing,
      afterKing,
      beforeEnemyKing,
      afterEnemyKing,
      beforePawns,
      afterPawns,
      createdIsolatedPawn,
      createdPassedPawn,
      improvedDevelopment,
      repeatedPieceInOpening,
      earlyQueenOrRookMove,
      flankPawnMove,
      captureTradeDown,
      lateMistakePattern,
      captureInfo,
      featuresDetected
    };
  }

  function pushUnique(list, value) {
    if (value && !list.includes(value)) {
      list.push(value);
    }
  }

  function joinNaturalLanguage(items) {
    const filtered = (items || []).filter(Boolean);
    if (!filtered.length) {
      return "";
    }
    if (filtered.length === 1) {
      return filtered[0];
    }
    if (filtered.length === 2) {
      return `${filtered[0]} and ${filtered[1]}`;
    }
    return `${filtered.slice(0, -1).join(", ")}, and ${filtered.at(-1)}`;
  }

  function firstSentence(text) {
    const value = String(text || "").trim();
    if (!value) {
      return "";
    }

    const match = value.match(/^.*?[.!?](?:\s|$)/);
    return (match ? match[0] : value).trim();
  }

  function safeLabelText(move) {
    return String(inferredMoveLabel(move) || "move").toLowerCase();
  }

  function inferredMoveLabel(move) {
    if (move?.label) {
      return move.label;
    }

    if (typeof move?.cpl === "number") {
      return classifyMove(move.cpl, move.moveUci || move.uci || "", move.bestUci || "");
    }

    return "";
  }

  function summarizeMovePurposes(purposes) {
    const list = [...new Set((purposes || []).filter(Boolean))];
    if (!list.length) {
      return "improved the position";
    }

    const hasCenter = list.includes("occupy the center") || list.includes("contest the center");
    const hasDevelopment = list.includes("develop a piece");
    const hasKingSafety = list.includes("improve king safety");
    const hasTempo = list.includes("attack a piece");
    const hasSimplify = list.includes("simplify") || list.includes("trade queens") || list.includes("trade pieces");
    const hasPassedPawn = list.includes("create a passed pawn");
    const hasAttack = list.includes("attack king");
    const hasOutpost = list.includes("occupy an outpost") || list.includes("create an outpost");
    const hasKingActivity = list.includes("activate king");
    const hasRookActivity = list.includes("activate rook");
    const hasPawnBreak = list.includes("execute a pawn break") || list.includes("prepare a pawn break");
    const hasThreat = list.includes("stop a threat");

    if (hasDevelopment && hasCenter) {
      return "developed and fought for the center";
    }
    if (hasKingSafety && hasDevelopment) {
      return "developed and made king safety easier";
    }
    if (hasCenter && hasTempo) {
      return "fought for the center and attacked a piece";
    }
    if (hasTempo) {
      return "attacked a piece and gained a tempo";
    }
    if (hasKingSafety) {
      return "improved king safety";
    }
    if (hasCenter) {
      return "fought for the center";
    }
    if (hasAttack) {
      return "increased pressure on the king";
    }
    if (hasPawnBreak) {
      return "challenged the pawn structure";
    }
    if (hasSimplify) {
      return "simplified the position";
    }
    if (hasPassedPawn) {
      return "created a passed pawn";
    }
    if (hasOutpost) {
      return "claimed a strong outpost";
    }
    if (hasKingActivity) {
      return "improved king activity";
    }
    if (hasRookActivity) {
      return "improved rook activity";
    }
    if (hasThreat) {
      return "met the main threat";
    }

    return list[0];
  }

  function buildCoachPanelCopy(move) {
    const readableMove = move?.san || move?.moveSan || "this move";
    const explanation = firstSentence(move.explanation || `${readableMove} was labeled ${safeLabelText(move)}.`);
    const effectiveLabel = inferredMoveLabel(move);
    const showAlternative = effectiveLabel === "Good" || effectiveLabel === "Inaccuracy";
    const followup = showAlternative
      ? firstSentence(move.alternative || move.whatChanged || "")
      : move.moveNumber <= 10
        ? ""
        : firstSentence(move.advice || move.lesson || move.whatChanged || "");
    const followupPrefix = showAlternative && /^better\b/i.test(followup || "")
      ? ""
      : showAlternative
        ? "Better: "
        : "Tip: ";

    return [explanation, followup ? `${followupPrefix}${followup}` : ""].filter(Boolean).join(" ");
  }

  function movePrefixLabel(move) {
    const san = move?.san || move?.moveSan || "this move";
    const hasNumber = Number.isFinite(move?.moveNumber);
    const hasColor = move?.color === "w" || move?.color === "b";

    if (hasNumber && hasColor) {
      return move.color === "w" ? `${move.moveNumber}. ${san}` : `${move.moveNumber}... ${san}`;
    }

    return san;
  }

  function sumMaterialForColor(fen, color) {
    return collectPieces(fen, color)
      .filter((piece) => piece.type !== "k")
      .reduce((sum, piece) => sum + pieceValue(piece), 0);
  }

  function totalMaterialOnBoard(fen) {
    return sumMaterialForColor(fen, "w") + sumMaterialForColor(fen, "b");
  }

  function materialBalanceForColor(fen, color) {
    return sumMaterialForColor(fen, color) - sumMaterialForColor(fen, oppositeColor(color));
  }

  function centerSnapshot(fen, color) {
    const coreSquares = ["d4", "d5", "e4", "e5"];
    const extendedSquares = ["c3", "c4", "c5", "c6", "d3", "d4", "d5", "d6", "e3", "e4", "e5", "e6", "f3", "f4", "f5", "f6"];
    const occupiedCore = coreSquares.filter((square) => safePieceAtFen(fen, square)?.color === color).length;
    const occupiedExtended = extendedSquares.filter((square) => safePieceAtFen(fen, square)?.color === color).length;
    const attackedCore = coreSquares.filter((square) => attackerSquares(fen, square, color).length > 0).length;
    const attackedExtended = extendedSquares.filter((square) => attackerSquares(fen, square, color).length > 0).length;

    return {
      occupiedCore,
      occupiedExtended,
      attackedCore,
      attackedExtended,
      controlScore: occupiedCore * 2 + attackedCore + Math.max(0, occupiedExtended - occupiedCore)
    };
  }

  function moveIsCastling(move) {
    return /\bO-O(-O)?\b/.test(move.san || move.moveSan || "");
  }

  function moveIsCheck(move) {
    return /[+#]/.test(move.san || move.moveSan || "");
  }

  function fileHasPawn(fen, file, color = null) {
    return collectPieces(fen, color || "w", "p").concat(color ? [] : collectPieces(fen, "b", "p"))
      .some((piece) => piece.square[0] === file);
  }

  function isOpenFile(fen, file) {
    return !fileHasPawn(fen, file);
  }

  function isHalfOpenFile(fen, file, color) {
    return !fileHasPawn(fen, file, color);
  }

  function detectPawnBreak(move, movedPiece) {
    if (!movedPiece || movedPiece.type !== "p") {
      return false;
    }

    if (move.san?.includes("x")) {
      return false;
    }

    const enemyPawns = collectPieces(move.beforeFen, oppositeColor(move.color), "p");
    const toFile = squareFileIndex(move.to);
    const toRank = squareRankIndex(move.to);
    const directContact = enemyPawns.some((enemyPawn) => {
      const enemyFile = squareFileIndex(enemyPawn.square);
      const enemyRank = squareRankIndex(enemyPawn.square);
      return Math.abs(enemyFile - toFile) === 1 && Math.abs(enemyRank - toRank) <= 1;
    });

    return ["c", "d", "e", "f"].includes(move.from[0]) && (directContact || isCenterSquare(move.to) || isExtendedCenterSquare(move.to));
  }

  function clearDiagonalSquares(fromSquare, toSquare) {
    const fromFile = squareFileIndex(fromSquare);
    const toFile = squareFileIndex(toSquare);
    const fromRank = squareRankIndex(fromSquare);
    const toRank = squareRankIndex(toSquare);
    const fileStep = Math.sign(toFile - fromFile);
    const rankStep = Math.sign(toRank - fromRank);

    if (!fileStep || !rankStep || Math.abs(toFile - fromFile) !== Math.abs(toRank - fromRank)) {
      return [];
    }

    const squares = [];
    let file = fromFile + fileStep;
    let rank = fromRank + rankStep;

    while (file !== toFile && rank !== toRank) {
      squares.push(`${String.fromCharCode(97 + file)}${rank}`);
      file += fileStep;
      rank += rankStep;
    }

    return squares;
  }

  function diagonalPressureFromSquare(fen, color, fromSquare, pieceTypes = ["b", "q"]) {
    const pieces = collectPieces(fen, color)
      .filter((piece) => pieceTypes.includes(piece.type) && piece.square !== fromSquare);

    for (const piece of pieces) {
      const between = clearDiagonalSquares(piece.square, fromSquare);
      if (!between.length) {
        continue;
      }

      const blockedBefore = between.some((square) => safePieceAtFen(fen, square));
      if (!blockedBefore) {
        return true;
      }
    }

    return false;
  }

  function detectMeaningfulOpenDiagonal(move, movedPiece) {
    if (!movedPiece || movedPiece.type !== "p") {
      return false;
    }

    const beforePressure = diagonalPressureFromSquare(move.beforeFen, move.color, move.from);
    const afterPressure = diagonalPressureFromSquare(move.afterFen, move.color, move.from);
    return beforePressure && !afterPressure;
  }

  function createsForcingMove(features) {
    if (!features) {
      return false;
    }

    if (features.isCheck) {
      return true;
    }

    if (features.immediatePunish?.isHanging) {
      return true;
    }

    if ((features.playedForkTargets || []).length >= 2) {
      return true;
    }

    return Boolean(features.pressuredEnemyKing && features.afterEnemyKing.attackers > features.beforeEnemyKing.attackers);
  }

  function squaresControlledByPawn(square, color) {
    if (!square) {
      return [];
    }

    const file = squareFileIndex(square);
    const rank = squareRankIndex(square);
    const rankDelta = color === "w" ? 1 : -1;
    const targets = [];

    [[file - 1, rank + rankDelta], [file + 1, rank + rankDelta]].forEach(([targetFile, targetRank]) => {
      if (targetFile < 0 || targetFile > 7 || targetRank < 1 || targetRank > 8) {
        return;
      }
      targets.push(`${String.fromCharCode(97 + targetFile)}${targetRank}`);
    });

    return targets;
  }

  function pawnDefendersOfSquare(fen, color, square) {
    return attackerSquares(fen, square, color)
      .map((attackerSquare) => safePieceAtFen(fen, attackerSquare))
      .filter((piece) => piece?.type === "p");
  }

  function kingZoneSquares(fen, color) {
    const kingSquare = findKingSquare(fen, color);
    if (!kingSquare) {
      return [];
    }

    const file = squareFileIndex(kingSquare);
    const rank = squareRankIndex(kingSquare);
    const squares = [];

    for (let fileOffset = -1; fileOffset <= 1; fileOffset += 1) {
      for (let rankOffset = -1; rankOffset <= 1; rankOffset += 1) {
        const targetFile = file + fileOffset;
        const targetRank = rank + rankOffset;
        if (targetFile < 0 || targetFile > 7 || targetRank < 1 || targetRank > 8) {
          continue;
        }
        squares.push(`${String.fromCharCode(97 + targetFile)}${targetRank}`);
      }
    }

    return squares;
  }

  function isCriticalWeakSquare(square, fen, weakSide) {
    return isCenterSquare(square) || isExtendedCenterSquare(square) || kingZoneSquares(fen, weakSide).includes(square);
  }

  function detectWeakSquares(fen, side) {
    const candidates = [...new Set([
      "d4", "d5", "e4", "e5",
      ...kingZoneSquares(fen, side)
    ])].filter(Boolean);

    return candidates.filter((square) => pawnDefendersOfSquare(fen, side, square).length === 0);
  }

  function knightCanOccupySquareSoon(fen, color, square) {
    return collectPieces(fen, color, "n").some((piece) => {
      const fileDelta = Math.abs(squareFileIndex(piece.square) - squareFileIndex(square));
      const rankDelta = Math.abs(squareRankIndex(piece.square) - squareRankIndex(square));
      return (fileDelta === 1 && rankDelta === 2) || (fileDelta === 2 && rankDelta === 1);
    });
  }

  function detectOutpost(square, fen, weakSide) {
    if (!square) {
      return null;
    }

    const occupyingSide = oppositeColor(weakSide);
    const rank = squareRankIndex(square);
    const inEnemyTerritory = occupyingSide === "w" ? rank >= 5 : rank <= 4;
    if (!inEnemyTerritory) {
      return null;
    }

    if (pawnDefendersOfSquare(fen, weakSide, square).length > 0) {
      return null;
    }

    if (!knightCanOccupySquareSoon(fen, occupyingSide, square)) {
      return null;
    }

    return {
      square,
      type: "outpost",
      strength: isCenterSquare(square) || kingZoneSquares(fen, weakSide).includes(square) ? "high" : "medium"
    };
  }

  function detectPawnWeakening(move, beforeFen, afterFen) {
    const movedPiece = safePieceAtFen(beforeFen, move.from);
    if (!movedPiece || movedPiece.type !== "p") {
      return {
        lostControlSquares: [],
        weakSquares: [],
        criticalWeakSquares: [],
        outposts: [],
        primaryWeakSquare: null,
        primaryOutpost: null
      };
    }

    const beforeControl = squaresControlledByPawn(move.from, move.color);
    const afterControl = squaresControlledByPawn(move.to, move.color);
    const lostControlSquares = beforeControl.filter((square) => !afterControl.includes(square));
    const weakSquares = lostControlSquares.filter((square) => pawnDefendersOfSquare(afterFen, move.color, square).length === 0);
    const criticalWeakSquares = weakSquares.filter((square) => isCriticalWeakSquare(square, afterFen, move.color));
    const outposts = criticalWeakSquares
      .map((square) => detectOutpost(square, afterFen, move.color))
      .filter(Boolean)
      .sort((a, b) => (a.strength === "high" ? -1 : 1) - (b.strength === "high" ? -1 : 1));

    return {
      lostControlSquares,
      weakSquares,
      criticalWeakSquares,
      outposts,
      primaryWeakSquare: criticalWeakSquares[0] || weakSquares[0] || null,
      primaryOutpost: outposts[0] || null
    };
  }

  function detectOutpostOccupation(fen, color, square, pieceType) {
    if (!square || !["n", "b"].includes(pieceType)) {
      return false;
    }

    const rank = squareRankIndex(square);
    const advanced = color === "w" ? rank >= 5 : rank <= 4;
    if (!advanced) {
      return false;
    }

    const defenders = attackerSquares(fen, square, color)
      .map((attackerSquare) => safePieceAtFen(fen, attackerSquare))
      .filter((piece) => piece?.type === "p");
    const enemyPawnPressure = attackerSquares(fen, square, oppositeColor(color))
      .map((attackerSquare) => safePieceAtFen(fen, attackerSquare))
      .filter((piece) => piece?.type === "p");

    return defenders.length > 0 && enemyPawnPressure.length === 0;
  }

  function detectRookActivation(fen, color, square) {
    if (!square) {
      return false;
    }

    const file = square[0];
    const rank = squareRankIndex(square);
    return isOpenFile(fen, file) || isHalfOpenFile(fen, file, color) || (color === "w" ? rank >= 7 : rank <= 2);
  }

  function analyzeImmediatePunish(fen, color, square) {
    if (!square) {
      return null;
    }

    const targetPiece = safePieceAtFen(fen, square);
    if (!targetPiece || targetPiece.color !== color || targetPiece.type === "k") {
      return null;
    }

    const enemyColor = oppositeColor(color);
    const attackerSquaresList = attackerSquares(fen, square, enemyColor);
    if (!attackerSquaresList.length) {
      return null;
    }

    const defenderSquaresList = attackerSquares(fen, square, color);
    const attackers = attackerSquaresList
      .map((attackerSquare) => ({
        square: attackerSquare,
        piece: safePieceAtFen(fen, attackerSquare)
      }))
      .filter((entry) => entry.piece);

    if (!attackers.length) {
      return null;
    }

    const cheapestAttacker = attackers.reduce((best, entry) => {
      if (!best) {
        return entry;
      }
      return pieceValue(entry.piece) < pieceValue(best.piece) ? entry : best;
    }, null);

    const targetValue = pieceValue(targetPiece);
    const attackerValue = pieceValue(cheapestAttacker.piece);
    const winningCapture = targetValue - attackerValue >= 2;
    const insufficientDefense = defenderSquaresList.length < attackerSquaresList.length;

    return {
      targetSquare: square,
      targetPiece,
      targetPieceName: PIECE_NAMES[targetPiece.type] || "piece",
      targetValue,
      attackers,
      defenders: defenderSquaresList.length,
      attackerCount: attackerSquaresList.length,
      cheapestAttackerSquare: cheapestAttacker.square,
      cheapestAttackerPiece: cheapestAttacker.piece,
      cheapestAttackerName: PIECE_NAMES[cheapestAttacker.piece.type] || "piece",
      cheapestAttackerValue: attackerValue,
      winningCapture,
      insufficientDefense,
      isHanging: insufficientDefense || winningCapture
    };
  }

  function detectProphylacticPawnIdea(move, movedPiece) {
    if (!movedPiece || movedPiece.type !== "p") {
      return null;
    }

    if (move.from === "h7" && move.to === "h6") return "stopped Bg5 ideas and gave the king luft";
    if (move.from === "h2" && move.to === "h3") return "stopped ...Bg4 ideas and gave the king luft";
    if (move.from === "a7" && move.to === "a6") return "stopped Bb5 ideas and prepared queenside space";
    if (move.from === "a2" && move.to === "a3") return "stopped ...Bb4 ideas and prepared queenside space";
    if (move.from === "g7" && move.to === "g6") return "prepared a kingside fianchetto";
    if (move.from === "g2" && move.to === "g3") return "prepared a kingside fianchetto";
    if (move.from === "b7" && move.to === "b6") return "prepared a queenside fianchetto";
    if (move.from === "b2" && move.to === "b3") return "prepared a queenside fianchetto";

    return null;
  }

  function isOpeningMove(moveNumber, positionBefore) {
    if (moveNumber <= 1) {
      return true;
    }

    try {
      const occupied = collectPieces(positionBefore, "w").length + collectPieces(positionBefore, "b").length;
      const developedWhite = countDevelopedMinorPieces(positionBefore, "w");
      const developedBlack = countDevelopedMinorPieces(positionBefore, "b");
      return moveNumber <= 4 || (occupied >= 28 && developedWhite + developedBlack <= 4);
    } catch {
      return moveNumber <= 4;
    }
  }

  function isCapture(move) {
    return Boolean(move?.san?.includes("x") || move?.captureInfo?.captured || move?.capturedPiece);
  }

  function isRecapture(move, previousMove, positionBefore, positionAfter) {
    if (!isCapture(move) || !previousMove?.wasCapture || !move?.to || !previousMove?.to) {
      return false;
    }

    if (move.to !== previousMove.to) {
      return false;
    }

    const beforeMaterial = materialBalanceForColor(positionBefore, move.color);
    const afterMaterial = materialBalanceForColor(positionAfter, move.color);
    return afterMaterial >= beforeMaterial;
  }

  function isThreatResponse(move, positionBefore) {
    if (!move || isOpeningMove(move.moveNumber, positionBefore) || !move.previousMoveMeta) {
      return false;
    }

    const ownLooseBefore = countLoosePieces(positionBefore, move.color).length;
    const kingBefore = kingSafetySnapshot(positionBefore, move.color);
    const previousWasForcing = Boolean(move.previousMoveMeta.wasCheck || move.previousMoveMeta.wasCapture);

    return previousWasForcing && (ownLooseBefore > 0 || kingBefore.attackers > 0 || kingBefore.danger >= 4);
  }

  function isForcedRecapture(move, features) {
    if (!features?.captureInfo?.captured || !move?.to) {
      return false;
    }

    if (move.bestUci && move.moveUci && move.bestUci !== move.moveUci && move.bestUci !== move.uci) {
      return false;
    }
    const noFreshTactic = (features.playedForkTargets || []).length < 2;

    return isRecapture(move, move.previousMoveMeta, move.beforeFen, move.afterFen) && noFreshTactic;
  }

  function isNaturalRecapture(move, features) {
    if (!features?.captureInfo?.captured || !isRecapture(move, move.previousMoveMeta, move.beforeFen, move.afterFen)) {
      return false;
    }

    const movedPieceValue = pieceValue(features.movedPiece);
    const capturedValue = pieceValue(features.captureInfo.captured);
    const centralRecapture = isCenterSquare(move.to) || isExtendedCenterSquare(move.to);
    const noBigSwing = (move.cpl || 0) <= 35;
    const noNewStory = !features.createdCriticalWeakSquare && !features.createdOpponentOutpost && (features.playedForkTargets || []).length < 2;

    return noBigSwing && noNewStory && (centralRecapture || capturedValue >= movedPieceValue - 1);
  }

  function isOnlyReasonableMove(move, features) {
    if (!move?.bestUci) {
      return false;
    }

    const playedUci = move.moveUci || move.uci || "";
    const bestMatches = playedUci && playedUci === move.bestUci;
    const urgentDefense = features.addressesThreat && (features.ownLooseBefore.length > 0 || features.beforeKing.attackers > 0);

    return bestMatches && urgentDefense && (move.cpl || 0) <= 20;
  }

  function isRoutineDevelopingMove(move, features) {
    const movedPiece = features?.movedPiece;
    if (!movedPiece || !["n", "b"].includes(movedPiece.type)) {
      return false;
    }

    const standardOpeningMove = move.moveNumber <= 10 &&
      features.improvedDevelopment &&
      !isCapture(move) &&
      !features.createdCriticalWeakSquare &&
      !features.createdOpponentOutpost &&
      !features.prophylacticPawnIdea &&
      (features.playedForkTargets || []).length < 2 &&
      (move.cpl || 0) <= 35;

    return standardOpeningMove;
  }

  function isRoutineCastlingMove(move, features) {
    return features?.isCastling && !features.pressuredEnemyKing && !features.createdCriticalWeakSquare && (move.cpl || 0) <= 35;
  }

  function isSimpleDefensiveMove(move, features) {
    const simpleDefense = isThreatResponse(move, move.beforeFen) &&
      !isCapture(move) &&
      !features.pressuredEnemyKing &&
      !features.createdCriticalWeakSquare &&
      !features.createdOpponentOutpost &&
      (features.playedForkTargets || []).length < 2 &&
      (move.cpl || 0) <= 45;

    return simpleDefense;
  }

  function classifyExplanationMode(move, features, conceptData) {
    const label = inferredMoveLabel(move) || "";
    const criticalLabels = ["Blunder", "Mistake"];

    if (
      criticalLabels.includes(label) ||
      ["hung_piece", "missed_tactic", "king_safety_mistake", "bad_trade", "failed_conversion", "structural_weakening"].includes(conceptData.category) ||
      (move.cpl || 0) >= 120
    ) {
      return "critical";
    }

    if (
      isForcedRecapture(move, features) ||
      isNaturalRecapture(move, features) ||
      isOnlyReasonableMove(move, features) ||
      isRoutineDevelopingMove(move, features) ||
      isRoutineCastlingMove(move, features) ||
      isSimpleDefensiveMove(move, features)
    ) {
      return "routine";
    }

    return "strategic";
  }

  function blocksHomeBishop(beforeFen, color, from, to, pieceType) {
    if (pieceType !== "n") {
      return false;
    }

    if (color === "w" && to === "d2") {
      return safePieceAtFen(beforeFen, "c1")?.type === "b";
    }
    if (color === "w" && to === "e2") {
      return safePieceAtFen(beforeFen, "f1")?.type === "b";
    }
    if (color === "b" && to === "d7") {
      return safePieceAtFen(beforeFen, "c8")?.type === "b";
    }
    if (color === "b" && to === "e7") {
      return safePieceAtFen(beforeFen, "f8")?.type === "b";
    }

    return false;
  }

  function extractBoardFeatures(move, allPlayerMoves = [], includeBestComparison = true) {
    if (!hasCompleteMoveData(move)) {
      return emptyMoveFeatures(move);
    }

    const base = extractMoveFeatures(move, allPlayerMoves);
    const movedPiece = base.movedPiece || safePieceAtFen(move.beforeFen, move.from);
    const phase = phaseForMove(move.moveNumber);
    const isEndgame = phase === "endgame" || totalMaterialOnBoard(move.beforeFen) <= 16;
    const beforeMaterial = materialBalanceForColor(move.beforeFen, move.color);
    const afterMaterial = materialBalanceForColor(move.afterFen, move.color);
    const beforeCenter = centerSnapshot(move.beforeFen, move.color);
    const afterCenter = centerSnapshot(move.afterFen, move.color);
    const enemyBeforeCenter = centerSnapshot(move.beforeFen, oppositeColor(move.color));
    const enemyAfterCenter = centerSnapshot(move.afterFen, oppositeColor(move.color));
    const beforeDevelopment = countDevelopedMinorPieces(move.beforeFen, move.color);
    const afterDevelopment = countDevelopedMinorPieces(move.afterFen, move.color);
    const isCastling = moveIsCastling(move);
    const isCapture = (move.san || "").includes("x");
    const isCheck = moveIsCheck(move);
    const isPawnBreak = detectPawnBreak(move, movedPiece);
    const pawnWeakening = detectPawnWeakening(move, move.beforeFen, move.afterFen);
    const occupiesOutpost = detectOutpostOccupation(move.afterFen, move.color, move.to, movedPiece?.type);
    const rookActivation = movedPiece?.type === "r" && detectRookActivation(move.afterFen, move.color, move.to);
    const activatedKing = Boolean(isEndgame && movedPiece?.type === "k" && isExtendedCenterSquare(move.to));
    const simplified = totalMaterialOnBoard(move.afterFen) < totalMaterialOnBoard(move.beforeFen);
    const pressuredEnemyKing = base.afterEnemyKing.danger > base.beforeEnemyKing.danger;
    const centralOccupationGain = afterCenter.occupiedCore - beforeCenter.occupiedCore;
    const centralControlGain = afterCenter.controlScore - beforeCenter.controlScore;
    const enemyCentralGain = enemyAfterCenter.controlScore - enemyBeforeCenter.controlScore;
    const gainsSpace = afterCenter.occupiedExtended > beforeCenter.occupiedExtended;
    const threatResponse = isThreatResponse(move, move.beforeFen);
    const addressesThreat = threatResponse && (base.ownLooseAfter.length < base.ownLooseBefore.length || base.afterKing.danger < base.beforeKing.danger);
    const wasAhead = beforeMaterial >= 1.5;
    const wasBehind = beforeMaterial <= -1.5;
    const tradeQueens = Boolean(base.captureInfo?.captured?.type === "q" && movedPiece?.type === "q");
    const winsMaterial = afterMaterial > beforeMaterial + 0.5;
    const losesMaterial = afterMaterial < beforeMaterial - 0.5;
    const opensDiagonal = detectMeaningfulOpenDiagonal(move, movedPiece);
    const openingSlowMove = Boolean(
      phase === "opening" &&
      !base.improvedDevelopment &&
      !hasExplicitKingSafetyGain(move, {
        ...base,
        color: move.color,
        isCastling,
        movedPiece
      }) &&
      centralOccupationGain <= 0 &&
      centralControlGain <= 0 &&
      (base.flankPawnMove || base.repeatedPieceInOpening || base.earlyQueenOrRookMove)
    );
    const prophylacticPawnIdea = detectProphylacticPawnIdea(move, movedPiece);
    const blockedOwnBishop = blocksHomeBishop(move.beforeFen, move.color, move.from, move.to, movedPiece?.type);
    const immediatePunish = analyzeImmediatePunish(move.afterFen, move.color, move.to);
    const bestMoveImprovesDevelopmentMore = Boolean(
      move.bestUci &&
      (() => {
        const bestMoveResult = applyUciMoveToFen(move.beforeFen, move.bestUci);
        if (!bestMoveResult) {
          return false;
        }
        const bestAfterDev = countDevelopedMinorPieces(bestMoveResult.afterFen, move.color);
        return bestAfterDev > afterDevelopment;
      })()
    );

    const features = {
      ...base,
      phase,
      color: move.color,
      isEndgame,
      movedPiece,
      movedPieceName: movedPiece ? PIECE_NAMES[movedPiece.type] || "piece" : "piece",
      beforeMaterial,
      afterMaterial,
      beforeCenter,
      afterCenter,
      enemyBeforeCenter,
      enemyAfterCenter,
      beforeDevelopment,
      afterDevelopment,
      isCastling,
      isCapture,
      isCheck,
      isPawnBreak,
      pawnWeakening,
      createdWeakSquare: Boolean(pawnWeakening.primaryWeakSquare),
      createdCriticalWeakSquare: Boolean(pawnWeakening.criticalWeakSquares.length),
      createdOpponentOutpost: Boolean(pawnWeakening.primaryOutpost),
      occupiesOutpost,
      rookActivation,
      activatedKing,
      simplified,
      pressuredEnemyKing,
      centralOccupationGain,
      centralControlGain,
      enemyCentralGain,
      gainsSpace,
      threatResponse,
      addressesThreat,
      wasAhead,
      wasBehind,
      tradeQueens,
      winsMaterial,
      losesMaterial,
      opensDiagonal,
      openingSlowMove,
      prophylacticPawnIdea,
      blockedOwnBishop,
      immediatePunish,
      bestMoveImprovesDevelopmentMore,
      bestMoveFeatures: null
    };

    if (includeBestComparison && move.bestUci) {
      const bestResult = applyUciMoveToFen(move.beforeFen, move.bestUci);
      if (bestResult) {
        const bestMoveLike = {
          ...move,
          san: bestResult.move.san,
          from: bestResult.move.from,
          to: bestResult.move.to,
          uci: move.bestUci,
          afterFen: bestResult.afterFen
        };
        features.bestMoveFeatures = extractBoardFeatures(bestMoveLike, allPlayerMoves, false);
      }
    }

    return features;
  }

  function hasExplicitKingSafetyGain(move, features) {
    if (!features?.beforeKing || !features?.afterKing) {
      return false;
    }

    const color = move?.color || features.color;
    if (features.isCastling) {
      return true;
    }

    const underPressure = features.beforeKing.attackers > 0 || features.beforeKing.danger >= 4;
    const dangerDrop = features.beforeKing.danger - features.afterKing.danger;
    const attackersReduced = features.afterKing.attackers < features.beforeKing.attackers;
    const kingMoveToSaferSquare = features.movedPiece?.type === "k" && (attackersReduced || dangerDrop >= 1);
    const kingSidePawnBlock = features.movedPiece?.type === "p" &&
      isKingPawnMove(move, color) &&
      underPressure &&
      (attackersReduced || dangerDrop >= 2);

    return underPressure && (kingMoveToSaferSquare || kingSidePawnBlock);
  }

  function hasExplicitKingSafetyLoss(move, features) {
    if (!features?.beforeKing || !features?.afterKing) {
      return false;
    }

    const color = move?.color || features.color;
    if (features.afterKing.danger > features.beforeKing.danger + 1) {
      return true;
    }

    const castledAndLoosenedShield = features.beforeKing.castled &&
      features.movedPiece?.type === "p" &&
      isKingPawnMove(move, color) &&
      features.afterKing.shieldMissing > features.beforeKing.shieldMissing;
    const invitedPressure = features.afterKing.attackers > features.beforeKing.attackers || features.afterKing.danger > features.beforeKing.danger;

    return castledAndLoosenedShield && invitedPressure;
  }

  function buildPawnTradeoffClause(features) {
    if (features.movedPiece?.type !== "p" || (!features.createdCriticalWeakSquare && !features.createdOpponentOutpost)) {
      return "";
    }

    const outpost = features.pawnWeakening.primaryOutpost;
    const weakSquare = features.pawnWeakening.primaryWeakSquare;

    if (outpost) {
      return `It also weakened ${outpost.square}, which can become a knight outpost for the opponent later.`;
    }
    if (weakSquare) {
      return `It also weakened ${weakSquare}, so that square becomes harder to cover with a pawn later on.`;
    }

    return "";
  }

  function legalMovesFromSquare(fen, color, square) {
    if (!fen || !square) {
      return [];
    }

    try {
      return new Chess(withTurnInFen(fen, color)).moves({ square, verbose: true }) || [];
    } catch {
      return [];
    }
  }

  function describePieceTarget(target, withArticle = true) {
    if (!target) {
      return withArticle ? "the piece" : "piece";
    }

    const name = PIECE_NAMES[target.type] || "piece";
    return withArticle ? `the ${name} on ${target.square}` : `${name} on ${target.square}`;
  }

  function squarePriority(square, color, enemyKingSquares = [], ownKingSquares = []) {
    let score = 0;
    if (isCenterSquare(square)) score += 6;
    if (isExtendedCenterSquare(square)) score += 3;
    if (enemyKingSquares.includes(square)) score += 5;
    if (ownKingSquares.includes(square)) score += 4;
    const rank = squareRankIndex(square);
    if (color === "w") {
      score += rank;
    } else {
      score += 9 - rank;
    }
    return score;
  }

  function summarizeSquarePressure(squares, color, enemyKingSquares = [], ownKingSquares = []) {
    const uniqueSquares = [...new Set((squares || []).filter(Boolean))];
    if (!uniqueSquares.length) {
      return "";
    }

    const sorted = uniqueSquares
      .sort((a, b) => squarePriority(b, color, enemyKingSquares, ownKingSquares) - squarePriority(a, color, enemyKingSquares, ownKingSquares))
      .slice(0, 2);

    return joinNaturalLanguage(sorted);
  }

  function analyzeConcreteImpacts(move, features) {
    const movedPiece = features.movedPiece;
    if (!movedPiece || !move?.to || !move?.afterFen) {
      return {
        attackedTargets: [],
        defendedTargets: [],
        newlyDefendedTargets: [],
        pressuredSquares: [],
        enemyKingSquares: [],
        ownKingSquares: []
      };
    }

    const enemyColor = oppositeColor(move.color);
    const enemyPieces = collectPieces(move.afterFen, enemyColor).filter((piece) => piece.type !== "k");
    const legalMoves = legalMovesFromSquare(move.afterFen, move.color, move.to);
    const enemyKingSquares = kingZoneSquares(move.afterFen, enemyColor);
    const ownKingSquares = kingZoneSquares(move.afterFen, move.color);
    const attackedTargets = enemyPieces
      .filter((piece) => attackerSquares(move.afterFen, piece.square, move.color).includes(move.to))
      .map((piece) => ({
        square: piece.square,
        type: piece.type,
        value: pieceValue(piece),
        inKingZone: enemyKingSquares.includes(piece.square)
      }))
      .sort((a, b) => {
        if (b.value !== a.value) {
          return b.value - a.value;
        }
        if (Number(b.inKingZone) !== Number(a.inKingZone)) {
          return Number(b.inKingZone) - Number(a.inKingZone);
        }
        return squarePriority(b.square, move.color, enemyKingSquares, ownKingSquares) - squarePriority(a.square, move.color, enemyKingSquares, ownKingSquares);
      });

    const pressuredSquares = [...new Set(legalMoves.map((candidate) => candidate.to))]
      .filter((square) => !attackedTargets.some((target) => target.square === square))
      .filter((square) => isCenterSquare(square) || isExtendedCenterSquare(square) || enemyKingSquares.includes(square));

    const defendedTargets = collectPieces(move.afterFen, move.color)
      .filter((piece) => piece.square !== move.to)
      .filter((piece) => attackerSquares(move.afterFen, piece.square, move.color).includes(move.to))
      .map((piece) => ({
        square: piece.square,
        type: piece.type,
        value: pieceValue(piece),
        wasLooseBefore: features.ownLooseBefore.some((entry) => entry.square === piece.square)
      }))
      .sort((a, b) => (b.wasLooseBefore - a.wasLooseBefore) || (b.value - a.value));
    const newlyDefendedTargets = defendedTargets.filter((piece) => !attackerSquares(move.beforeFen, piece.square, move.color).includes(move.from));

    return {
      attackedTargets,
      defendedTargets,
      newlyDefendedTargets,
      pressuredSquares,
      enemyKingSquares,
      ownKingSquares
    };
  }

  function buildPositionalFollowup(move, features, impacts) {
    const clauses = [];
    const movedPiece = features.movedPiece;

    if (features.improvedDevelopment) {
      if (movedPiece?.type === "n" || movedPiece?.type === "b") {
        clauses.push(`develops the ${PIECE_NAMES[movedPiece.type] || "piece"}`);
      } else {
        clauses.push("improves development");
      }
    }

    if (features.isCastling) {
      clauses.push("gets the king safer and connects the rooks");
    } else if (hasExplicitKingSafetyGain(move, features)) {
      clauses.push("makes king safety easier");
    }

    if (features.centralOccupationGain > 0 && features.centralControlGain > 0) {
      clauses.push("claims more central space");
    } else if (features.centralOccupationGain > 0) {
      clauses.push("puts another pawn or piece in the center");
    } else if (features.centralControlGain > 0) {
      const keyCenter = summarizeSquarePressure(impacts.pressuredSquares.filter((square) => isCenterSquare(square) || isExtendedCenterSquare(square)), move.color, impacts.enemyKingSquares, impacts.ownKingSquares);
      clauses.push(keyCenter ? `adds pressure to ${keyCenter}` : "adds central pressure");
    }

    if (features.opensDiagonal) {
      clauses.push("opens a useful diagonal for the bishop or queen");
    }

    if (features.rookActivation) {
      clauses.push("puts the rook on a more active file");
    }

    if (features.activatedKing) {
      clauses.push("brings the king closer to the center");
    }

    if (features.simplified && features.wasAhead) {
      clauses.push("cuts down counterplay");
    }

    if (features.occupiesOutpost) {
      clauses.push(`plants the ${features.movedPieceName} on a square that is hard to chase away`);
    }

    if (features.prophylacticPawnIdea) {
      clauses.push(features.prophylacticPawnIdea);
    }

    return clauses.slice(0, 2);
  }

  function buildConcreteOpening(move, features, impacts) {
    const attackedTarget = impacts.attackedTargets[0];
    const defendedTarget = impacts.newlyDefendedTargets.find((target) => target.wasLooseBefore) || impacts.newlyDefendedTargets[0];
    const pressuredSquares = summarizeSquarePressure(impacts.pressuredSquares, move.color, impacts.enemyKingSquares, impacts.ownKingSquares);
    const pieceName = features.movedPieceName;

    if (features.isCastling) {
      return "gets the king off the center and brings the rook into play";
    }

    if (features.captureInfo?.captured) {
      const captured = {
        square: move.to,
        type: features.captureInfo.captured.type
      };
      if (isForcedRecapture(move, features) || isNaturalRecapture(move, features)) {
        return `recaptures ${describePieceTarget(captured, true)} and restores the balance`;
      }
      return `captures ${describePieceTarget(captured, true)}`;
    }

    if (features.playedForkTargets.length >= 2) {
      return `attacks ${describeTargets(features.playedForkTargets)} at the same time`;
    }

    if (moveIsCheck(move)) {
      return "gives check and forces an immediate response";
    }

    if (attackedTarget) {
      const gainsTempo = !features.isCapture && attackedTarget.value >= 3;
      return gainsTempo
        ? `attacks ${describePieceTarget(attackedTarget, true)}, so the opponent has to respond`
        : `attacks ${describePieceTarget(attackedTarget, true)}`;
    }

    if (defendedTarget) {
      return `defends ${describePieceTarget(defendedTarget, true)}`;
    }

    if (features.threatResponse && features.addressesThreat) {
      return "meets the immediate threat and keeps the position together";
    }

    if (pressuredSquares) {
      return `adds pressure to ${pressuredSquares}`;
    }

    if (features.prophylacticPawnIdea) {
      return features.prophylacticPawnIdea;
    }

    if (features.improvedDevelopment) {
      return `develops the ${pieceName}`;
    }

    return "handles the position cleanly";
  }

  function buildConcretePositiveExplanation(move, features, effectiveLabel, conceptData) {
    const played = move.san || move.moveSan || "This move";
    const labelText = effectiveLabel.toLowerCase();
    const impacts = analyzeConcreteImpacts(move, features);
    const opening = buildConcreteOpening(move, features, impacts);
    const positionalClauses = buildPositionalFollowup(move, features, impacts);
    const drawback = buildPawnTradeoffClause(features);
    const sentences = [`${played} is ${labelText} because it ${opening}.`];

    if (positionalClauses.length) {
      sentences.push(`It also ${joinNaturalLanguage(positionalClauses)}.`);
    } else if (conceptData.category === "tactical_awareness") {
      sentences.push("It creates a concrete problem the opponent has to solve right away.");
    }

    if (drawback) {
      sentences.push(drawback);
    }

    return sentences.slice(0, 3).join(" ");
  }

  function buildRoutineExplanation(move, features, effectiveLabel) {
    const played = move.san || move.moveSan || "your move";
    const impacts = analyzeConcreteImpacts(move, features);
    const defendedTarget = impacts.newlyDefendedTargets.find((target) => target.wasLooseBefore) || impacts.newlyDefendedTargets[0];
    const pressuredSquares = summarizeSquarePressure(impacts.pressuredSquares, move.color, impacts.enemyKingSquares, impacts.ownKingSquares);

    if (isForcedRecapture(move, features) || isNaturalRecapture(move, features)) {
      const captured = features.captureInfo?.captured
        ? {
            square: move.to,
            type: features.captureInfo.captured.type
          }
        : null;
      if (isCenterSquare(move.to) || isExtendedCenterSquare(move.to)) {
        return `${played} is ${effectiveLabel.toLowerCase()} because it recaptures ${captured ? describePieceTarget(captured, true) : "the material"} and keeps the piece active in the center.`;
      }
      return `${played} is ${effectiveLabel.toLowerCase()} because it is the natural recapture and restores the balance.`;
    }

    if (isRoutineCastlingMove(move, features)) {
      return `${played} is ${effectiveLabel.toLowerCase()} because it gets the king safer and brings the rook into the game.`;
    }

    if (isRoutineDevelopingMove(move, features)) {
      if (pressuredSquares) {
        return `${played} is ${effectiveLabel.toLowerCase()} because it develops a piece while increasing pressure on ${pressuredSquares}.`;
      }
      return `${played} is ${effectiveLabel.toLowerCase()} because it develops a piece to a natural square without creating a weakness.`;
    }

    if (isSimpleDefensiveMove(move, features)) {
      if (defendedTarget) {
        return `${played} is ${effectiveLabel.toLowerCase()} because it covers ${describePieceTarget(defendedTarget, true)} and deals with the immediate threat.`;
      }
      return `${played} is ${effectiveLabel.toLowerCase()} because it deals with the immediate threat and keeps the position together.`;
    }

    if (isOnlyReasonableMove(move, features)) {
      return `${played} is ${effectiveLabel.toLowerCase()} because it is the clean move that keeps the position under control.`;
    }

    return `${played} is ${effectiveLabel.toLowerCase()} because it is the natural move for the position.`;
  }

  function classifyMovePurpose(move, features) {
    if (!features) {
      return [];
    }

    const purposes = [];
    const playedForkTargets = features.playedForkTargets || [];

    if (features.improvedDevelopment) pushUnique(purposes, "develop a piece");
    if (hasExplicitKingSafetyGain(move, features)) pushUnique(purposes, "improve king safety");
    if (features.centralOccupationGain > 0) pushUnique(purposes, "occupy the center");
    if (features.centralControlGain > 0) pushUnique(purposes, "contest the center");
    if (features.gainsSpace) pushUnique(purposes, "gain space");
    if (playedForkTargets.length) pushUnique(purposes, "attack a piece");
    if (features.threatResponse && features.addressesThreat) pushUnique(purposes, "stop a threat");
    if (features.isPawnBreak) pushUnique(purposes, "execute a pawn break");
    if (features.opensDiagonal) pushUnique(purposes, "open a diagonal");
    if (features.pressuredEnemyKing) pushUnique(purposes, "attack king");
    if (features.winsMaterial) pushUnique(purposes, "win material");
    if (features.tradeQueens) pushUnique(purposes, "trade queens");
    if (features.simplified) pushUnique(purposes, "simplify");
    if (features.wasAhead && features.simplified) pushUnique(purposes, "convert advantage");
    if (features.createdPassedPawn) pushUnique(purposes, "create a passed pawn");
    if (features.occupiesOutpost) pushUnique(purposes, "occupy an outpost");
    if (features.activatedKing) pushUnique(purposes, "activate king");
    if (features.rookActivation) pushUnique(purposes, "activate rook");
    if (features.captureTradeDown) pushUnique(purposes, "trade pieces");

    if (!purposes.length) {
      pushUnique(purposes, features.movedPiece?.type === "p" ? "gain space" : "improve a piece");
    }

    return purposes.slice(0, 3);
  }

  function detectConcepts(move, features) {
    const isPositive = ["Best", "Excellent", "Good"].includes(move.label);
    const concepts = [];
    let category = isPositive ? "piece_improvement" : "missed_threat";

    if (isPositive) {
      if (features.improvedDevelopment) pushUnique(concepts, "development");
      if (features.centralOccupationGain > 0) pushUnique(concepts, "occupation of the center");
      if (features.centralControlGain > 0) pushUnique(concepts, "control of the center");
      if (features.gainsSpace) pushUnique(concepts, "space advantage");
      if (features.isCastling) pushUnique(concepts, "castling");
      if (hasExplicitKingSafetyGain(move, features)) pushUnique(concepts, features.isCastling ? "castled king safety" : "king safety");
      if (features.isPawnBreak) pushUnique(concepts, features.phase === "opening" ? "pawn break" : "central break");
      if (features.opensDiagonal) pushUnique(concepts, "open diagonal");
      if (features.occupiesOutpost) pushUnique(concepts, "outpost");
      if (features.rookActivation) pushUnique(concepts, "rook activity");
      if (features.activatedKing) pushUnique(concepts, "king activity");
      if (features.simplified && features.wasAhead) pushUnique(concepts, "safe simplification");
      if (features.simplified && features.wasAhead) pushUnique(concepts, "converting material advantage");
      if (features.pressuredEnemyKing) pushUnique(concepts, "attacking chances against king");
      if (createsForcingMove(features)) pushUnique(concepts, "tactical shot");
      if (features.prophylacticPawnIdea) pushUnique(concepts, "prophylaxis");
    } else {
      if (features.createdCriticalWeakSquare) {
        pushUnique(concepts, "weak square");
        pushUnique(concepts, "pawn weakness");
      }
      if (features.createdOpponentOutpost) {
        pushUnique(concepts, "outpost");
        pushUnique(concepts, "knight outpost");
      }
      if (features.immediatePunish?.isHanging || features.movedPieceLooseAfter) {
        pushUnique(concepts, "hanging piece");
        pushUnique(concepts, "underdefended piece");
      }
      if (features.bestForkTargets.length >= 2 && features.playedForkTargets.length < 2) {
        pushUnique(concepts, "missed tactic");
        pushUnique(concepts, "fork");
      }
      if (features.afterKing.danger > features.beforeKing.danger + 1) {
        pushUnique(concepts, "exposed king");
        pushUnique(concepts, "open lines to king");
      }
      if (features.captureTradeDown) pushUnique(concepts, "bad trade");
      if (features.openingSlowMove) {
        pushUnique(concepts, "too slow for the position");
        pushUnique(concepts, "opening principle violation");
        if (features.flankPawnMove) pushUnique(concepts, "flank pawn move in the opening");
        if (features.earlyQueenOrRookMove) pushUnique(concepts, "premature queen development");
        if (features.repeatedPieceInOpening) pushUnique(concepts, "moving the same piece twice");
      }
      if (features.blockedOwnBishop) pushUnique(concepts, "blocked development");
    }

    if (!isPositive) {
      if (features.immediatePunish?.isHanging || features.movedPieceLooseAfter) {
        category = "hung_piece";
      } else if (features.bestForkTargets.length >= 2 && features.playedForkTargets.length < 2) {
        category = "missed_tactic";
      } else if (hasExplicitKingSafetyLoss(move, features)) {
        category = "king_safety_mistake";
      } else if (features.captureTradeDown) {
        category = "bad_trade";
      } else if (features.createdCriticalWeakSquare || features.createdOpponentOutpost) {
        category = "structural_weakening";
      } else if (features.openingSlowMove) {
        category = "slow_opening_move";
      } else if (features.blockedOwnBishop || (features.improvedDevelopment && features.bestMoveImprovesDevelopmentMore)) {
        category = "passive_development";
      } else if (features.wasAhead && features.losesMaterial) {
        category = "failed_conversion";
      } else if (features.isEndgame && features.movedPiece?.type !== "k" && !features.activatedKing && features.label !== "Inaccuracy") {
        category = "poor_endgame_decision";
      }
    } else if (createsForcingMove(features)) {
      category = "tactical_awareness";
    } else if (features.prophylacticPawnIdea) {
      category = "prophylaxis";
    } else if (features.isCastling || features.improvedDevelopment) {
      category = "development";
    } else if (features.isPawnBreak || features.centralControlGain > 0 || features.centralOccupationGain > 0) {
      category = "center_play";
    } else if (features.occupiesOutpost) {
      category = "outpost_creation";
    } else if (features.wasAhead && features.simplified) {
      category = "good_conversion";
    } else if (features.activatedKing) {
      category = "endgame_king_activity";
    }

    return {
      category,
      mainConcepts: (concepts.length ? concepts : [isPositive ? "piece improvement" : "missed threat"]).slice(0, 4)
    };
  }

  function describeBestMoveIdea(bestFeatures, bestMoveSan) {
    if (!bestFeatures) {
      return bestMoveSan || "the engine move";
    }

    const ideas = classifyMovePurpose(null, bestFeatures);
    if (!ideas.length) {
      return bestMoveSan || "the engine move";
    }

    return `${bestMoveSan || "the engine move"} was stronger because it ${joinNaturalLanguage(ideas)}`;
  }

  function buildBestMoveSuggestion(bestFeatures, bestMoveSan) {
    if (!bestMoveSan) {
      return "";
    }

    if (bestFeatures?.playedForkTargets?.length >= 2) {
      return `Better was ${bestMoveSan} because it attacked ${describeTargets(bestFeatures.playedForkTargets)} at once.`;
    }

    if (bestFeatures?.isCastling) {
      return `Better was ${bestMoveSan} because it got the king safer and brought the rook into play.`;
    }

    if (bestFeatures?.improvedDevelopment && bestFeatures?.centralControlGain > 0) {
      return `Better was ${bestMoveSan} because it developed a piece while adding pressure to the center.`;
    }

    if (bestFeatures?.improvedDevelopment) {
      return `Better was ${bestMoveSan} because it developed a piece to a more active square.`;
    }

    if (bestFeatures?.centralOccupationGain > 0 || bestFeatures?.centralControlGain > 0) {
      return `Better was ${bestMoveSan} because it challenged the center more directly.`;
    }

    if (bestFeatures?.threatResponse && bestFeatures?.addressesThreat) {
      return `Better was ${bestMoveSan} because it dealt with the immediate threat more cleanly.`;
    }

    const summary = summarizeMovePurposes(classifyMovePurpose(null, bestFeatures || {}));
    if (!summary || summary === "improved the position") {
      return `Better was ${bestMoveSan} because it handled the position more directly.`;
    }

    return `Better was ${bestMoveSan} because it ${summary}.`;
  }

  function buildStructuralBestMoveSuggestion(move, features) {
    const bestMoveSan = move.bestSan || move.bestUci || "";
    if (!bestMoveSan) {
      return "";
    }

    const weakSquare = features.pawnWeakening.primaryOutpost?.square || features.pawnWeakening.primaryWeakSquare;
    if (!features.bestMoveFeatures) {
      return `Better was ${bestMoveSan} because it handled the position without conceding ${weakSquare || "a long-term square"}.`;
    }

    const summary = summarizeMovePurposes(classifyMovePurpose(null, features.bestMoveFeatures || {}));
    if (!weakSquare) {
      return `Better was ${bestMoveSan} because it ${summary}.`;
    }

    return `Better was ${bestMoveSan} because it ${summary} without conceding ${weakSquare}.`;
  }

  function evaluateMoveConsequences(move, features, conceptData) {
    const piece = features.movedPieceName;
    const bestIdea = describeBestMoveIdea(features.bestMoveFeatures, move.bestSan || move.bestUci || "the engine move");
    const playedMove = move.san || move.moveSan || "this move";

    switch (conceptData.category) {
      case "hung_piece":
        if (features.immediatePunish?.isHanging) {
          return {
            whatChanged: `After ${playedMove}, your ${features.immediatePunish.targetPieceName} on ${features.immediatePunish.targetSquare} could be taken by ${features.immediatePunish.cheapestAttackerName === "pawn" ? "a pawn" : `the ${features.immediatePunish.cheapestAttackerName}`} from ${features.immediatePunish.cheapestAttackerSquare}.`,
            lesson: "If a more valuable piece can be captured immediately by a cheaper one, that usually decides the position on the spot.",
            advice: `Before every capture, check what attacks ${move.to} after your piece lands there.`
          };
        }
        return {
          whatChanged: `After ${playedMove}, your ${piece} on ${move.to} was defended fewer times than it could be attacked, so it became an immediate tactical target.`,
          lesson: "Loose pieces and underdefended pieces are often the first thing tactics punish.",
          advice: "Before you play an active move, count attackers and defenders on the piece you move and on the pieces it stops protecting."
        };
      case "missed_tactic":
        return {
          whatChanged: `The position contained a forcing idea, but your move let it pass. ${bestIdea}.`,
          lesson: "When the position is sharp, tactics matter more than quiet improvements.",
          advice: "Use a short checks, captures, and threats scan before every move in tactical positions."
        };
      case "king_safety_mistake":
        return {
          whatChanged: `Your move made the king easier to attack by increasing open lines or reducing the pawn cover in front of it.`,
          lesson: "King safety is a positional concept first and a tactical problem right after.",
          advice: "Avoid pawn moves around your king unless they solve a direct threat or create concrete counterplay."
        };
      case "bad_trade":
        return {
          whatChanged: `The exchange simplified into a position where your structure, activity, or minor-piece balance was worse.`,
          lesson: "A trade is only good if the position after the trade still favors your pieces and pawns.",
          advice: "Before exchanging, picture the position one move later and ask which side benefits from the simpler structure."
        };
      case "structural_weakening": {
        const weakSquare = features.pawnWeakening.primaryWeakSquare;
        const outpost = features.pawnWeakening.primaryOutpost;
        const bestAvoidsWeakness = features.bestMoveFeatures && !features.bestMoveFeatures.createdCriticalWeakSquare && !features.bestMoveFeatures.createdOpponentOutpost;
        return {
          whatChanged: outpost
            ? `The pawn move gave up control of ${outpost.square}, which can become a ${outpost.strength === "high" ? "very strong" : "useful"} outpost for an enemy knight.`
            : `The pawn move gave up control of ${weakSquare}, and that square is now much harder for your pawns to challenge.`,
          lesson: "An active pawn push can still be strategically wrong if it gives the opponent a long-term square to use.",
          advice: bestAvoidsWeakness && move.bestSan
            ? `${move.bestSan} was better because it handled the position without conceding that square.`
            : "Before a pawn push, ask which squares that pawn used to control and whether one of them becomes a lasting hole."
        };
      }
      case "slow_opening_move":
        return {
          whatChanged: `The move spent a tempo without helping development, the center, or king safety, so the opponent kept the initiative.`,
          lesson: "Opening moves need to solve opening problems: develop, fight for the center, or secure the king.",
          advice: "In the first 8 to 10 moves, be suspicious of flank pawn moves and repeated piece moves unless they answer a concrete threat."
        };
      case "failed_conversion":
        return {
          whatChanged: `You were already better, but the move kept too much counterplay on the board instead of making the position easier to handle.`,
          lesson: "When you are ahead, simplicity and safety are often stronger than one more ambitious try.",
          advice: "When better, look first for trades, king safety, and ways to reduce the opponent's active ideas."
        };
      case "poor_endgame_decision":
        return {
          whatChanged: `In an endgame, your move did not improve king activity or the pawn structure, so the other side kept the important practical chances.`,
          lesson: "Endgames reward activity more than passivity, especially from the king and rook.",
          advice: "When pieces are reduced, ask first whether your king or rook can become more active."
        };
      case "tactical_awareness":
        return {
          whatChanged: `Your move created a concrete threat and forced the opponent to react instead of improving their own position.`,
          lesson: "Good tactics come from noticing loose pieces, overloaded defenders, and forcing replies.",
          advice: "Keep checking whether one move can attack two targets or win material by force."
        };
      case "development":
        return {
          whatChanged: `The move improved piece coordination and made the next useful move, such as castling or central play, easier to achieve.`,
          lesson: "Good opening moves do more than one job: they develop, coordinate, and prepare the next step.",
          advice: "Favor moves that improve a piece while also supporting the center or king safety."
        };
      case "prophylaxis":
        return {
          whatChanged: `The move prevented a useful idea for the opponent while keeping your position healthy.`,
          lesson: "Small prophylactic moves are good when they stop something concrete.",
          advice: "Use a waiting move only when you can name the threat or idea it prevents."
        };
      case "center_play":
        return {
          whatChanged: `The move changed the central battle immediately by adding pressure, occupying key squares, or challenging the pawn structure.`,
          lesson: "Control of the center usually decides which side gets to choose the middlegame plan.",
          advice: "When the center is still fluid, prioritize moves that claim space or challenge central pawns directly."
        };
      case "outpost_creation":
        return {
          whatChanged: `You placed a piece on a square that is hard to chase away and easy for your own pawns to support.`,
          lesson: "A stable outpost turns one active piece into a long-term positional advantage.",
          advice: "Look for advanced squares that enemy pawns cannot challenge and that your pawns can support."
        };
      case "good_conversion":
        return {
          whatChanged: `The move reduced counterplay and made your advantage easier to handle in practical terms.`,
          lesson: "Conversion is not about finding the flashiest move; it is about removing the opponent's best chances.",
          advice: "When you are better, prefer clean simplification and active pieces over extra complications."
        };
      case "endgame_king_activity":
        return {
          whatChanged: `Your king stepped toward the center, where it can support pawns and restrict the opponent's king.`,
          lesson: "In endgames, the king becomes a fighting piece, not just something to hide.",
          advice: "Once the queens and most pieces are gone, improve the king before chasing side pawn moves."
        };
      case "passive_development":
        return {
          whatChanged: `The move developed a piece, but it landed on a passive square or got in the way of better coordination.`,
          lesson: "Development only helps when the new square improves activity and fits the rest of your position.",
          advice: "When developing, ask whether the square increases activity, keeps lines open, and supports the center."
        };
      default:
        return {
          whatChanged: `${bestIdea}. Your move did not match the most urgent feature of the position as well.`,
          lesson: "The right move is usually the one that addresses the position's biggest demand first.",
          advice: "Before moving, ask what matters most right now: center, king safety, tactics, or simplification."
        };
    }
  }

  function generateCoachExplanation(move, allPlayerMoves = []) {
    const features = extractBoardFeatures(move, allPlayerMoves);
    const movePurpose = classifyMovePurpose(move, features);
    const conceptData = detectConcepts(move, features);
    const explanationMode = classifyExplanationMode(move, features, conceptData);
    const consequences = evaluateMoveConsequences(move, features, conceptData);
    const effectiveLabel = inferredMoveLabel(move) || "Move";
    const isPositive = ["Best", "Excellent", "Good"].includes(effectiveLabel);
    const played = move.san || move.moveSan || "your move";
    const labelText = effectiveLabel.toLowerCase();
    const movePurposeText = summarizeMovePurposes(movePurpose);
    const conceptText = joinNaturalLanguage(conceptData.mainConcepts.slice(0, 3));
    const bestIdea = describeBestMoveIdea(features.bestMoveFeatures, move.bestSan || move.bestUci || "the engine move");
    const pawnTradeoff = buildPawnTradeoffClause(features);
    const bestSuggestion = conceptData.category === "structural_weakening"
      ? buildStructuralBestMoveSuggestion(move, features)
      : buildBestMoveSuggestion(features.bestMoveFeatures, move.bestSan || move.bestUci || "");

    let explanation = `${played} was labeled ${labelText}.`;

    if (isPositive && explanationMode === "routine") {
      explanation = buildRoutineExplanation(move, features, effectiveLabel);
    } else if (isPositive) {
      explanation = buildConcretePositiveExplanation(move, features, effectiveLabel, conceptData);
    } else {
      switch (conceptData.category) {
        case "hung_piece":
          if (features.immediatePunish?.isHanging) {
            explanation = `${played} is a ${labelText} because your ${features.immediatePunish.targetPieceName} can be taken immediately by ${features.immediatePunish.cheapestAttackerName === "pawn" ? "a pawn" : `the ${features.immediatePunish.cheapestAttackerName}`}.`;
          } else {
            explanation = `${played} is a ${labelText} because it leaves your ${features.movedPieceName} loose or underdefended.`;
          }
          break;
        case "missed_tactic":
          explanation = `${played} is a ${labelText} because it misses a forcing tactical idea. ${firstSentence(bestIdea)}.`;
          break;
        case "king_safety_mistake":
          explanation = `${played} is a ${labelText} because it weakens your king's cover or opens lines too early.`;
          break;
        case "bad_trade":
          explanation = `${played} is a ${labelText} because the trade helps the opponent more than it helps you.`;
          break;
        case "structural_weakening": {
          const weakSquare = features.pawnWeakening.primaryWeakSquare;
          const outpost = features.pawnWeakening.primaryOutpost;
          const activeTarget = features.playedForkTargets[0];
          const activeIdea = activeTarget
            ? `it attacks the ${PIECE_NAMES[activeTarget.type] || "piece"} on ${activeTarget.square}`
            : "it has an active short-term idea";
          if (outpost) {
            explanation = `${played} is a ${labelText} because ${activeIdea}, but it weakens ${outpost.square}. After this move, you can no longer control ${outpost.square} with a pawn, which gives the opponent a potential knight outpost there.`;
          } else if (weakSquare) {
            explanation = `${played} is a ${labelText} because ${activeIdea}, but it weakens the ${weakSquare} square. After this move, that square becomes much harder to cover with a pawn and can turn into a long-term hole.`;
          } else {
            explanation = `${played} is a ${labelText} because the pawn push creates a long-term structural weakness even though the move looks active at first.`;
          }
          break;
        }
        case "passive_development":
          explanation = `${played} is a ${labelText} because it develops a piece to a passive square. It improves less than ${move.bestSan || "the best move"} and makes coordination harder.`;
          break;
        case "slow_opening_move":
          explanation = `${played} is a ${labelText} because it is too slow for the opening. It does not help development, the center, or king safety.`;
          break;
        case "failed_conversion":
          explanation = `${played} is a ${labelText} because it does not convert your advantage cleanly. It leaves extra counterplay on the board.`;
          break;
        case "poor_endgame_decision":
          explanation = `${played} is a ${labelText} because it misses the main endgame priority.`;
          break;
        default:
          if (effectiveLabel === "Inaccuracy") {
            explanation = `${played} is an inaccuracy because it is a bit too passive for the position. ${bestSuggestion}`;
          } else {
            explanation = `${played} is a ${labelText} because it does not meet the position's main demand. ${bestSuggestion}`;
          }
          break;
      }
    }

    if (!isPositive && effectiveLabel === "Inaccuracy" && !explanation.includes("Better was")) {
      explanation = `${firstSentence(explanation)} ${bestSuggestion}`.trim();
    }

    return {
      label: effectiveLabel,
      explanationMode,
      moveNumber: move.moveNumber,
      playedMove: played,
      bestMove: move.bestSan || move.bestUci || "the engine move",
      phase: features.phase,
      movePurpose,
      mainConcepts: conceptData.mainConcepts,
      category: conceptData.category,
      severity: severityFromCpl(move.cpl || 0),
      explanation,
      alternative: effectiveLabel === "Good" || effectiveLabel === "Inaccuracy" ? bestSuggestion : "",
      whatChanged: consequences.whatChanged,
      lesson: consequences.lesson,
      advice: consequences.advice
    };
  }

  function getCoachExplanationData(move, allPlayerMoves = []) {
    const cacheKey = `${move.beforeFen || ""}|${move.afterFen || ""}|${inferredMoveLabel(move) || ""}|${move.cpl || 0}`;
    if (move.__coachCache?.key === cacheKey) {
      return move.__coachCache.value;
    }

    const value = generateCoachExplanation(move, allPlayerMoves);
    move.__coachCache = { key: cacheKey, value };
    return value;
  }

  function pieceNameAtFen(fen, square) {
    try {
      const piece = new Chess(fen).get(square);
      return piece ? PIECE_NAMES[piece.type] || "piece" : "piece";
    } catch {
      return "piece";
    }
  }

  function phaseForMove(moveNumber) {
    if (moveNumber <= 8) return "opening";
    if (moveNumber <= 25) return "middlegame";
    return "endgame";
  }

  function isKingPawnMove(move, color) {
    if (!move?.from) {
      return false;
    }

    return (color === "w" && ["f2", "g2", "h2"].includes(move.from)) || (color === "b" && ["f7", "g7", "h7"].includes(move.from));
  }

  function isMajorPieceMoveInOpening(move, beforeFen) {
    if (!move?.from) {
      return false;
    }

    const pieceName = pieceNameAtFen(beforeFen, move.from);
    return move.moveNumber <= 8 && (pieceName === "queen" || pieceName === "rook" || pieceName === "king");
  }

  function bestMoveLooksForcing(move) {
    return /\+|#|x/.test(move.bestSan || "") || /\+|#|x/.test(move.pvSan || "");
  }

  function detectLossCategory(move, allPlayerMoves) {
    const features = extractMoveFeatures(move, allPlayerMoves);

    if (move.moveNumber >= 20 && move.cpl > 220) {
      return "late_game_blunder";
    }
    if (features.movedPieceLooseAfter && move.cpl >= 140) {
      return "hung_piece";
    }
    if (features.bestForkTargets.length >= 2 && move.cpl >= 120) {
      return "fork_tactic";
    }
    if (features.afterKing.danger > features.beforeKing.danger + 1 && move.cpl >= 110) {
      return "king_safety";
    }
    if (features.featuresDetected.includes("back_rank_weakness") && move.cpl >= 110) {
      return "back_rank";
    }
    if (features.captureTradeDown) {
      return "bad_trade";
    }
    if (features.createdIsolatedPawn && move.cpl >= 90) {
      return "isolated_pawn";
    }
    if (features.createdPassedPawn && move.cpl >= 90 && phaseForMove(move.moveNumber) === "endgame") {
      return "passed_pawn";
    }
    if (
      move.moveNumber <= 10 &&
      (features.repeatedPieceInOpening || features.earlyQueenOrRookMove || features.flankPawnMove || isMajorPieceMoveInOpening(move, move.beforeFen))
    ) {
      return features.improvedDevelopment ? "slow_move" : "opening_principle_violation";
    }
    if (features.lateMistakePattern && move.moveNumber >= 20) {
      return "time_pressure";
    }
    if (bestMoveLooksForcing(move) && move.cpl > 120) {
      return "missed_tactic";
    }
    if (move.moveNumber <= 8 && move.cpl > 100) {
      return "early_game_mistake";
    }
    return "missed_threat";
  }

  function detectWinCategory(opponentMove, playerMoves) {
    const features = extractMoveFeatures(opponentMove, playerMoves);
    const cleanReplies = playerMoves.filter((move) => move.moveNumber >= opponentMove.moveNumber && move.cpl <= 60);
    if (features.movedPieceLooseAfter) {
      return "loose_piece_punished";
    }
    if (features.bestForkTargets.length >= 2 || bestMoveLooksForcing(opponentMove)) {
      return "tactical_shot";
    }
    if (opponentMove.moveNumber >= 20 && cleanReplies.length >= 2) {
      return "solid_endgame";
    }
    if (opponentMove.moveNumber <= 8) {
      return "strong_opening";
    }
    if (
      features.afterKing.danger > features.beforeKing.danger + 1 ||
      (opponentMove.bestSan || "").includes("+") ||
      (opponentMove.pvSan || "").includes("+")
    ) {
      return "strong_attack";
    }
    if (features.createdPassedPawn && phaseForMove(opponentMove.moveNumber) === "endgame") {
      return "passed_pawn_play";
    }
    if (cleanReplies.length >= 2) {
      return "good_conversion";
    }
    return "capitalized_blunder";
  }

  function buildExplanationFromCategory(category, move, result, details = null) {
    const piece = pieceNameAtFen(move.beforeFen, move.from);
    const phase = phaseForMove(move.moveNumber);
    const movePrefix = movePrefixText(move);
    const features = details || extractMoveFeatures(move, []);
    const subjectIsOpponent = result === "win" && move.color !== state.viewerColor;
    const subject = subjectIsOpponent ? "your opponent" : "you";
    const possessive = subjectIsOpponent ? "their" : "your";
    const best = move.bestSan || move.bestUci || "the engine move";

    const templates = {
      hung_piece: {
        reason: `On ${movePrefix}, ${subject} left ${possessive} ${piece} loose${move.to ? ` on ${move.to}` : ""}, and the position swung immediately.`,
        lesson: "Loose pieces get punished quickly.",
        advice: "Before every move, check which of your pieces is undefended or only defended once."
      },
      missed_threat: {
        reason: `On ${movePrefix}, ${subject} missed the opponent's main threat and the position turned immediately.`,
        lesson: "A good move still fails if it ignores the opponent's forcing idea.",
        advice: "Before moving, scan checks, captures, and threats for your opponent first."
      },
      bad_trade: {
        reason: `On ${movePrefix}, the trade looked natural, but it left ${subjectIsOpponent ? "them" : "you"} worse in the resulting ${phase}.`,
        lesson: "Trades are only good when the resulting position still works for you.",
        advice: "Before exchanging, ask whether the end position helps your worst piece, king safety, or pawn structure."
      },
      king_safety: {
        reason: `On ${movePrefix}, ${subject} weakened ${possessive} king and gave the other side clear targets.`,
        lesson: "King safety usually matters more than a hopeful attack.",
        advice: "Avoid pawn pushes around your king unless you gain something concrete right away."
      },
      time_pressure: {
        reason: `The key swing came on ${movePrefix}, and it fits the same rushed late-game decisions that keep showing up.`,
        lesson: "Speeding up in sharp positions creates avoidable losses.",
        advice: "When the game gets tense after move 20, slow down long enough to check one blunder before playing."
      },
      late_game_blunder: {
        reason: `On ${movePrefix}, one late blunder wiped out the work that came before it.`,
        lesson: "Winning or equal games still need clean moves late on.",
        advice: "In late positions, simplify your thought process: king safety, loose pieces, then forcing moves."
      },
      early_game_mistake: {
        reason: `On ${movePrefix}, ${subject} drifted from the basic needs of the opening and fell behind too early.`,
        lesson: "Opening errors often show up later as harder positions to defend.",
        advice: "Develop minor pieces and finish king safety before spending time on queen or rook moves."
      },
      opening_principle_violation: {
        reason: `On ${movePrefix}, ${subject} spent a tempo on the wrong thing instead of development or king safety.`,
        lesson: "Openings punish slow queen moves, repeated piece moves, and side-pawn pushes more than they seem to.",
        advice: "In the first 8 to 10 moves, prioritize pieces toward the center and get castled."
      },
      slow_move: {
        reason: `On ${movePrefix}, ${subject} made a move that was playable but too slow for the position's needs.`,
        lesson: "Tempo matters most when both sides are still organizing their pieces.",
        advice: "If the position is still in development, ask which move improves your worst minor piece first."
      },
      missed_tactic: {
        reason: `On ${movePrefix}, ${subject} missed a tactical idea. ${best} was stronger because it created immediate threats.`,
        lesson: "Big swings often come from one forcing move you did not calculate.",
        advice: "When a position is tactical, spend a few extra seconds checking checks, captures, and direct threats."
      },
      fork_tactic: {
        reason: `On ${movePrefix}, ${subject} missed a fork or double attack. ${best} was stronger because it hit ${describeTargets(features.bestForkTargets)} at once.`,
        lesson: "Forks are strongest when one move attacks two important targets and forces an awkward reply.",
        advice: "Before moving on, look for knight jumps, pawn pushes, or queen moves that attack two pieces at once."
      },
      back_rank: {
        reason: `On ${movePrefix}, ${subject} left the back rank too tight and gave heavy pieces tactical ideas right away.`,
        lesson: "A king with no luft can turn a normal move into a back-rank tactic.",
        advice: "Create an escape square or keep enough defenders on the back rank before chasing activity elsewhere."
      },
      isolated_pawn: {
        reason: `On ${movePrefix}, ${subject} created an isolated pawn and gave the other side a clean long-term target.`,
        lesson: "Static pawn weaknesses matter more once the tactics settle down.",
        advice: "Before a pawn push, check whether that pawn will still have support from a neighboring pawn afterward."
      },
      passed_pawn: {
        reason: `On ${movePrefix}, ${subject} let a passed pawn become the main feature of the position.`,
        lesson: "Passed pawns get stronger as pieces come off the board.",
        advice: "In endgames, spend extra time asking whether a pawn race or pawn breakthrough is about to start."
      },
      capitalized_blunder: {
        reason: `You won because after ${movePrefix}, the position became clearly easier and you took the chance right away.`,
        lesson: "Good players cash in when the position suddenly becomes easier.",
        advice: "Keep punishing big mistakes by taking the material or simplifying immediately."
      },
      loose_piece_punished: {
        reason: `You won because on ${movePrefix}, your opponent left a loose ${piece}, and the position was ripe for punishment.`,
        lesson: "Loose pieces rarely survive for long when the other side is alert.",
        advice: "Whenever your opponent moves, scan once for pieces that lost a defender or moved onto a vulnerable square."
      },
      tactical_shot: {
        reason: `You won because the position around ${movePrefix} contained a tactical shot, and the follow-up was forcing.`,
        lesson: "Tactics appear when pieces are overloaded, loose, or lined up awkwardly.",
        advice: "When the eval suddenly jumps, check for forks, discovered attacks, and deflections before anything else."
      },
      strong_attack: {
        reason: `You won because by ${movePrefix}, the pressure on the king was real and the attack kept growing.`,
        lesson: "Attacks work when more than one piece joins the pressure.",
        advice: "When the king is exposed, improve one more attacker before forcing everything."
      },
      good_conversion: {
        reason: `You won because after ${movePrefix}, you kept control instead of letting counterplay back in.`,
        lesson: "Conversion is about staying clean once you are better.",
        advice: "When ahead, look for trades, safer king positions, and moves that remove your opponent's activity."
      },
      solid_endgame: {
        reason: `You won because after ${movePrefix}, you handled the ending more cleanly than your opponent.`,
        lesson: "Small endgame edges grow when you keep the position simple.",
        advice: "Keep repeating the habit of removing counterplay before pushing for something bigger."
      },
      strong_opening: {
        reason: `You won because by ${movePrefix}, you already had the healthier position out of the opening.`,
        lesson: "Good openings make the middlegame easier to play.",
        advice: "Keep prioritizing development and king safety before chasing side ideas."
      },
      passed_pawn_play: {
        reason: `You won because by ${movePrefix}, the passed pawn or runner in the ending became too strong to ignore.`,
        lesson: "Passed pawns force the other side to react, which makes conversion much easier.",
        advice: "In better endgames, keep asking whether pushing the passer or trading into a pawn race helps you most."
      }
    };

    return templates[category] || {
      reason: result === "loss"
        ? `On ${movePrefix}, the position turned against you for concrete tactical reasons.`
        : `On ${movePrefix}, the game finally tipped your way and you kept the edge.`,
      lesson: "The biggest lesson is hidden in one critical moment, not in every small inaccuracy.",
      advice: "Review the biggest swing first, then focus on one habit you can repeat next game."
    };
  }

  function buildMoveTeachingNotes(move) {
    const coach = getCoachExplanationData(move);
    return {
      category: coach.category,
      severity: coach.severity,
      featuresDetected: coach.mainConcepts,
      lesson: coach.lesson,
      advice: coach.advice,
      alternative: coach.alternative,
      movePurpose: coach.movePurpose,
      mainConcepts: coach.mainConcepts,
      whatChanged: coach.whatChanged
    };
  }

  function resultForViewer(gameData) {
    const result = String(gameData?.game?.pgnHeaders?.Result || "");
    if (result === "1/2-1/2") {
      return "draw";
    }
    if ((result === "1-0" && state.viewerColor === "w") || (result === "0-1" && state.viewerColor === "b")) {
      return "win";
    }
    if ((result === "1-0" && state.viewerColor === "b") || (result === "0-1" && state.viewerColor === "w")) {
      return "loss";
    }
    return "draw";
  }

  function countMovesByThreshold(moves, thresholdCp) {
    return moves.filter((move) => move.cpl > thresholdCp).length;
  }

  function countMistakesOnly(moves) {
    return moves.filter((move) => move.cpl > 100 && move.cpl <= 200).length;
  }

  function countInaccuraciesOnly(moves) {
    return moves.filter((move) => move.label === "Inaccuracy" || (move.cpl > 60 && move.cpl <= 100)).length;
  }

  function buildPhaseBreakdown(moves) {
    const breakdown = {
      opening: { mistakes: 0, blunders: 0, moves: 0 },
      middlegame: { mistakes: 0, blunders: 0, moves: 0 },
      endgame: { mistakes: 0, blunders: 0, moves: 0 }
    };

    for (const move of moves) {
      const phase = move.phase || phaseForMove(move.moveNumber);
      if (!breakdown[phase]) {
        continue;
      }

      breakdown[phase].moves += 1;

      if (move.cpl > 200) {
        breakdown[phase].blunders += 1;
      } else if (move.cpl > 100) {
        breakdown[phase].mistakes += 1;
      }
    }

    return breakdown;
  }

  function dominantTag(tags) {
    const counts = {};
    for (const tag of tags) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  function buildGameTags(playerMoves, opponentMoves, result) {
    const mistakeTags = new Set();
    const goodTags = new Set();
    const bigMistakes = playerMoves.filter((move) => move.cpl > 100);
    const blunders = playerMoves.filter((move) => move.cpl > 200);
    const lateMistakes = playerMoves.filter((move) => move.moveNumber >= 20 && move.cpl > 100);
    const endgameMoves = playerMoves.filter((move) => move.moveNumber >= 20);
    const openingMoves = playerMoves.filter((move) => move.moveNumber <= 5);

    bigMistakes.slice(0, 4).forEach((move) => {
      mistakeTags.add(detectLossCategory(move, playerMoves));
    });

    if (lateMistakes.length >= 2) {
      mistakeTags.add("time_pressure");
    }

    if (result === "win" && opponentMoves.some((move) => move.cpl > 200)) {
      opponentMoves
        .filter((move) => move.cpl > 100)
        .slice(0, 3)
        .forEach((move) => goodTags.add(detectWinCategory(move, playerMoves)));
    }
    if (endgameMoves.length >= 4 && endgameMoves.every((move) => move.cpl <= 100)) {
      goodTags.add("solid_endgame");
    }
    if (lateMistakes.length === 0 && endgameMoves.length >= 4) {
      goodTags.add("good_time_management");
    }
    if (openingMoves.length >= 4 && openingMoves.every((move) => move.cpl <= 60)) {
      goodTags.add("strong_opening");
    }

    if (!mistakeTags.length && result === "loss" && bigMistakes.length) {
      mistakeTags.add("hung_piece");
    }
    if (!goodTags.length && result === "win") {
      goodTags.add(opponentMoves.some((move) => move.cpl > 100) ? "capitalized_blunder" : "strong_opening");
    }

    return { mistakeTags: [...mistakeTags], goodTags: [...goodTags] };
  }

  function buildInsights(playerMoves, opponentMoves) {
    const insights = [];
    const mistakesAfter20 = playerMoves.filter((move) => move.cpl > 100 && move.moveNumber > 20).length;
    const totalMistakes = playerMoves.filter((move) => move.cpl > 100).length;
    const biggestSwing = [...playerMoves].sort((a, b) => b.cpl - a.cpl)[0];
    const opponentBlunder = opponentMoves.filter((move) => move.cpl > 200).length;

    if (mistakesAfter20 > 0 && mistakesAfter20 >= Math.max(1, Math.ceil(totalMistakes / 2))) {
      insights.push("Most mistakes happened after move 20.");
    }
    if (opponentBlunder) {
      insights.push(`Your opponent made ${opponentBlunder} major mistake${opponentBlunder === 1 ? "" : "s"} that you could punish.`);
    }
    if (biggestSwing) {
      insights.push(`Your biggest swing came on move ${biggestSwing.moveNumber} (${biggestSwing.san}).`);
    }
    if (!insights.length) {
      insights.push("This game was decided by a small number of critical swings.");
    }

    return insights.slice(0, 3);
  }

  function buildReviewSummary(gameData, results) {
    const result = resultForViewer(gameData);
    const playerMoves = results.filter((move) => move.color === state.viewerColor);
    const opponentMoves = results.filter((move) => move.color !== state.viewerColor);
    const blunders = countMovesByThreshold(playerMoves, 200);
    const mistakes = countMistakesOnly(playerMoves);
    const inaccuracies = countInaccuraciesOnly(playerMoves);
    const phaseBreakdown = buildPhaseBreakdown(playerMoves);
    const tags = buildGameTags(playerMoves, opponentMoves, result);
    const biggestLoss = [...playerMoves].sort((a, b) => b.cpl - a.cpl)[0] || null;
    const biggestWin = [...opponentMoves].sort((a, b) => b.cpl - a.cpl)[0] || null;
    const focusMove = result === "loss" ? biggestLoss : result === "win" ? biggestWin : biggestLoss || biggestWin;
    const reasonTag = focusMove
      ? result === "loss"
        ? detectLossCategory(focusMove, playerMoves)
        : detectWinCategory(focusMove, playerMoves)
      : result === "loss"
        ? dominantTag(tags.mistakeTags)
        : dominantTag(tags.goodTags);
    const focusFeatures = focusMove
      ? extractMoveFeatures(focusMove, result === "loss" ? playerMoves : opponentMoves)
      : null;
    const explanation = focusMove
      ? buildExplanationFromCategory(reasonTag, focusMove, result, focusFeatures)
      : {
          reason: result === "loss"
            ? "A few big mistakes swung the game against you."
            : result === "win"
              ? "You handled the key moments better than your opponent."
              : "The game came down to a few balanced turning points.",
          lesson: "The most useful review starts with the single biggest swing.",
          advice: "Focus on one repeatable habit from this game before looking at everything else."
        };

    return {
      gameId: parseGameId() || `${Date.now()}`,
      date: Date.now(),
      result,
      color: state.viewerColor === "b" ? "black" : "white",
      opening: null,
      blunders,
      mistakes,
      inaccuracies,
      moveCount: results.length,
      phaseBreakdown,
      reasonTag,
      primaryReason: reasonTag,
      reasonText: explanation.reason,
      lessonText: explanation.lesson,
      adviceText: explanation.advice,
      focusMoveNumber: focusMove?.moveNumber || null,
      mistakeTags: tags.mistakeTags,
      goodTags: tags.goodTags,
      summary: {
        headline: explanation.reason,
        lesson: explanation.lesson,
        advice: explanation.advice
      },
      insights: [
        `Lesson: ${explanation.lesson}`,
        `Advice: ${explanation.advice}`,
        ...buildInsights(playerMoves, opponentMoves).filter(Boolean)
      ].slice(0, 4)
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

  function syncPageContextViewerIdentity() {
    // Intentionally blank. Injecting an inline page script here violates
    // Chrome extension CSP on Chess.com, so we fall back to DOM scraping.
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
    return scrapeUsernameFromChessDom();
  }

  function getViewerIdFromPage() {
    return null;
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
    launcher.textContent = "Game Review";
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
          <p class="crf-subtitle">Instant post-game review with local Stockfish and habit tracking.</p>
        </div>
        <button class="crf-close" id="crf-close" type="button" aria-label="Close review panel">Back to game</button>
      </div>
      <div class="crf-scroll">
        <section class="crf-hero">
          <div class="crf-hero-main">
            <div class="crf-result-badge" id="crf-result-badge" data-result="draw">Game Review</div>
            <div class="crf-reason-label" id="crf-reason-label">Why this game mattered</div>
            <div class="crf-reason-text" id="crf-reason-text">Run review to see the clearest reason you won or lost.</div>
            <button class="crf-cta" id="crf-analyze" type="button">Analyze This Game</button>
            <div class="crf-progress">
              <div class="crf-progress-bar" id="crf-progress-bar"></div>
            </div>
            <p class="crf-muted" id="crf-status">Waiting for a finished Chess.com live game.</p>
          </div>
          <div class="crf-hero-side">
            <div class="crf-hero-stat">
              <span class="crf-stat-label">Blunders</span>
              <span class="crf-hero-stat-value" id="crf-blunder-stat">0</span>
            </div>
            <div class="crf-hero-stat">
              <span class="crf-stat-label">Mistakes</span>
              <span class="crf-hero-stat-value" id="crf-mistake-stat">0</span>
            </div>
            <div class="crf-focus-card">
              <div class="crf-reason-label" id="crf-focus-label">What to work on next</div>
              <div class="crf-focus-text" id="crf-focus-text">Run a review and this panel will turn the biggest mistake into one clear next step.</div>
            </div>
          </div>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Insights</strong>
            <span class="crf-muted">Your biggest learning points from this game</span>
          </div>
          <ul class="crf-insight-list" id="crf-insight-list"></ul>
        </section>
        <section class="crf-card">
          <div class="crf-row">
            <strong>Review Board</strong>
            <span class="crf-muted">Step through the game or branch into edit mode</span>
          </div>
          <div class="crf-board-stage">
            <div class="crf-board-shell">
              <div class="crf-board-wrap">
                <div class="crf-eval-bar-shell">
                  <div class="crf-eval-label crf-eval-label-top" id="crf-eval-top">+0.0</div>
                  <div class="crf-eval-bar" id="crf-eval-bar">
                    <div class="crf-eval-fill" id="crf-eval-fill"></div>
                  </div>
                  <div class="crf-eval-label crf-eval-label-bottom" id="crf-eval-bottom">+0.0</div>
                </div>
                <div class="crf-board-surface">
                  <div id="crf-board" class="crf-board"></div>
                  <div id="crf-board-coordinates" class="crf-board-coordinates" aria-hidden="true"></div>
                </div>
              </div>
            </div>
            <aside class="crf-coach-panel">
              <div class="crf-coach-avatar" aria-hidden="true">
                <div class="crf-coach-logo">♞</div>
              </div>
              <div class="crf-coach-label" id="crf-coach-label">Chess Coach</div>
              <div class="crf-coach-explanation" id="crf-coach-explanation">Pick a move on the board or in the move list to see exactly why it was labeled best, good, inaccuracy, mistake, or blunder.</div>
            </aside>
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
            <strong>Game Metrics</strong>
            <span class="crf-muted">Quick scorecard for this review</span>
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

    state.root = root;
    state.launcher = launcher;
    state.status = root.querySelector("#crf-status");
    state.progressBar = root.querySelector("#crf-progress-bar");
    state.resultBadge = root.querySelector("#crf-result-badge");
    state.reasonLabel = root.querySelector("#crf-reason-label");
    state.reasonText = root.querySelector("#crf-reason-text");
    state.blunderStat = root.querySelector("#crf-blunder-stat");
    state.mistakeStat = root.querySelector("#crf-mistake-stat");
    state.focusLabel = root.querySelector("#crf-focus-label");
    state.focusText = root.querySelector("#crf-focus-text");
    state.insightList = root.querySelector("#crf-insight-list");
    state.summary = root.querySelector("#crf-summary");
    state.moves = root.querySelector("#crf-moves");
    state.chart = root.querySelector("#crf-chart");
    state.board = root.querySelector("#crf-board");
    state.boardCoordinates = root.querySelector("#crf-board-coordinates");
    state.boardCaption = root.querySelector("#crf-board-caption");
    state.boardHelper = root.querySelector("#crf-board-helper");
    state.coachLabel = root.querySelector("#crf-coach-label");
    state.coachExplanation = root.querySelector("#crf-coach-explanation");
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
    setReviewHero(
      {
        result: "draw",
        reasonText: "Run review to see the clearest reason you won or lost.",
        adviceText: "After the review runs, this panel will show one practical fix to carry into your next game.",
        blunders: 0,
        mistakes: 0,
        insights: ["Review will highlight one clear reason, blunder count, and your biggest trend."]
      }
    );
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

  function setReviewHero(summary) {
    if (state.resultBadge) {
      state.resultBadge.textContent = summary.result === "win" ? "You Won" : summary.result === "loss" ? "You Lost" : "Draw";
      state.resultBadge.dataset.result = summary.result;
    }
    if (state.reasonLabel) {
      state.reasonLabel.textContent = summary.result === "loss" ? "Why you lost" : summary.result === "win" ? "Why you won" : "Why it was drawn";
    }
    if (state.reasonText) {
      state.reasonText.textContent = summary.reasonText;
    }
    if (state.blunderStat) {
      state.blunderStat.textContent = String(summary.blunders);
    }
    if (state.mistakeStat) {
      state.mistakeStat.textContent = String(summary.mistakes);
    }
    if (state.focusLabel) {
      state.focusLabel.textContent = "What to work on next";
    }
    if (state.focusText) {
      state.focusText.textContent =
        summary.adviceText ||
        "Use the biggest swing from this game as one concrete thing to clean up in the next one.";
    }
    if (state.insightList) {
      state.insightList.innerHTML = summary.insights.map((insight) => `<li>${escapeHtml(insight)}</li>`).join("");
    }
  }

  function updateCoachPanel(move) {
    if (!state.coachLabel || !state.coachExplanation) {
      return;
    }

    if (!move) {
      state.coachLabel.textContent = "Chess Coach";
      state.coachExplanation.textContent = "Pick a move on the board or in the move list to see exactly why it was labeled best, good, inaccuracy, mistake, or blunder.";
      return;
    }

    const effectiveLabel = safeLabelText(move);
    const movePrefix = movePrefixLabel(move);
    state.coachLabel.textContent = `Why ${movePrefix} was ${effectiveLabel}`;
    state.coachExplanation.textContent = buildCoachPanelCopy(move);
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

  function buildMoveExplanation(move) {
    return getCoachExplanationData(move).explanation;
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
    const playerMoves = results.filter((move) => move.color === state.viewerColor);
    const opponentMoves = results.filter((move) => move.color !== state.viewerColor);
    const biggestMiss = playerMoves.reduce((worst, move) => (move.cpl > (worst?.cpl || -1) ? move : worst), null);
    const biggestPunish = opponentMoves.reduce((worst, move) => (move.cpl > (worst?.cpl || -1) ? move : worst), null);

    const summaryCards = [
      { label: "Your Accuracy", value: `${gameAccuracyFromMoves(playerMoves)}%` },
      { label: "Opponent Accuracy", value: `${gameAccuracyFromMoves(opponentMoves)}%` },
      { label: "Blunders", value: String(countMovesByThreshold(playerMoves, 200)) },
      { label: "Mistakes", value: String(countMistakesOnly(playerMoves)) },
      {
        label: "Toughest Moment",
        value: biggestMiss ? `${biggestMiss.color === "w" ? `${biggestMiss.moveNumber}.` : `${biggestMiss.moveNumber}...`} ${biggestMiss.san}` : "None"
      },
      {
        label: "Best Punish",
        value: biggestPunish ? `${biggestPunish.color === "w" ? `${biggestPunish.moveNumber}.` : `${biggestPunish.moveNumber}...`} ${biggestPunish.san}` : "None"
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
        const moveSan = move.san || move.moveSan || "this move";
        const moveLabel = inferredMoveLabel(move) || move.label || "Move";
        return `
          <article class="crf-move" data-ply-index="${index + 1}">
            <div class="crf-move-top">
              <strong>${escapeHtml(moveNumber)} ${escapeHtml(moveSan)}</strong>
              <div class="crf-move-top-right">
                ${renderStickerMarkup(moveLabel)}
                <span class="crf-badge ${colorBadgeClass(moveLabel)}">${escapeHtml(moveLabel)}</span>
              </div>
            </div>
            <div class="crf-move-meta">
              <span class="crf-kbd">Accuracy ${move.accuracy}%</span>
              <span class="crf-kbd">Swing ${moveSwingText(move.cpl)}</span>
              <span class="crf-kbd">Eval ${escapeHtml(formatEngineEvalText(move.afterScore || { unit: "cp", value: 0 }))}</span>
            </div>
            <p class="crf-muted">Best move: <strong>${escapeHtml(move.bestSan || move.bestUci || "N/A")}</strong> · Played: <strong>${escapeHtml(moveSan)}</strong></p>
            <p class="crf-move-expl">${escapeHtml(move.explanation || `${moveSan} was labeled ${safeLabelText(move)}.`)}</p>
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
      p: { w: "♟", b: "♟" },
      n: { w: "♞", b: "♞" },
      b: { w: "♝", b: "♝" },
      r: { w: "♜", b: "♜" },
      q: { w: "♛", b: "♛" },
      k: { w: "♚", b: "♚" }
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
      const moveSan = currentAnalysis.moveSan || currentAnalysis.san || "this move";
      const label = currentAnalysis.label || inferredMoveLabel(currentAnalysis) || "Move";
      return `Edit mode · ${moveSan} · ${label} · Accuracy ${currentAnalysis.accuracy}%${line}`;
    }

    if (!state.currentResults.length || plyIndex <= 0) {
      return "Start position";
    }

    const move = state.currentResults[Math.min(plyIndex - 1, state.currentResults.length - 1)];
    const moveNumber = move.color === "w" ? `${move.moveNumber}.` : `${move.moveNumber}...`;
    const moveSan = move.san || move.moveSan || "this move";
    const label = move.label || inferredMoveLabel(move) || "Move";
    return `${moveNumber} ${moveSan} · ${label} · Accuracy ${move.accuracy}%`;
  }

  function renderFiles(orientation = "white") {
    const files = orientation === "white"
      ? ["a", "b", "c", "d", "e", "f", "g", "h"]
      : ["h", "g", "f", "e", "d", "c", "b", "a"];

    return files.map((file, index) => {
      const left = `${(index * 12.5) + 1.8}%`;
      return `<div class="crf-coord-file" style="left:${left}">${file}</div>`;
    }).join("");
  }

  function renderRanks(orientation = "white") {
    const ranks = orientation === "white"
      ? ["8", "7", "6", "5", "4", "3", "2", "1"]
      : ["1", "2", "3", "4", "5", "6", "7", "8"];

    return ranks.map((rank, index) => {
      const top = `${(index * 12.5) + 1.2}%`;
      return `<div class="crf-coord-rank" style="top:${top}">${rank}</div>`;
    }).join("");
  }

  function renderCoordinates(orientation = "white") {
    if (!state.boardCoordinates) {
      return;
    }

    state.boardCoordinates.innerHTML = `
      ${renderFiles(orientation)}
      ${renderRanks(orientation)}
    `;
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
    const coachMove = state.analysisActive
      ? state.analysisByFen[state.analysisFen] || state.analysisResult
      : selectedMove;
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
                <span class="crf-piece${piece ? ` crf-piece-${piece.color} crf-piece-type-${piece.type}` : ""}">${escapeHtml(piece ? pieceGlyph(piece) : "")}</span>
              </div>
            `;
          })
          .join("")
      )
      .join("");
    renderCoordinates(state.boardOrientation);

    state.boardCaption.textContent = captionForPly(state.currentPlyIndex);
    updateCoachPanel(coachMove);
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
          const plyIndex = state.currentPlyIndex + state.analysisMoves.length - 1;
          const normalizedMove = {
            plyIndex,
            moveNumber: toMoveNumber(plyIndex, played.color),
            color: played.color,
            san: played.san,
            moveSan: played.san,
            uci,
            moveUci: uci,
            from: played.from,
            to: played.to,
            beforeFen,
            afterFen,
            accuracy,
            cpl,
            label,
            bestUci: best.bestmove,
            bestSan: uciToSan(beforeFen, best.bestmove),
            afterScore,
            bestScore,
            pvSan: pvToSan(beforeFen, best.pv)
          };
          const teaching = buildMoveTeachingNotes(normalizedMove);
          normalizedMove.explanation = buildMoveExplanation(normalizedMove);
          normalizedMove.category = teaching.category;
          normalizedMove.severity = teaching.severity;
          normalizedMove.featuresDetected = teaching.featuresDetected;
          normalizedMove.movePurpose = teaching.movePurpose;
          normalizedMove.mainConcepts = teaching.mainConcepts;
          normalizedMove.alternative = teaching.alternative;
          normalizedMove.whatChanged = teaching.whatChanged;
          normalizedMove.lesson = teaching.lesson;
          normalizedMove.advice = teaching.advice;

          state.analysisByFen[afterFen] = normalizedMove;

          if (state.analysisFen === afterFen || token === state.analysisToken) {
            state.analysisResult = normalizedMove;
            setStatus(`Analysis board: ${played.san} is marked ${label.toLowerCase()} (${accuracy}% accuracy).`);
            updateEvalBar(state.currentPlyIndex);
          }
        } catch (error) {
          console.error("Analysis board move failed", error);
          setStatus(runtimeSafeMessage(error, "Could not analyze that move."));
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
      setStatus(runtimeSafeMessage(error, "Could not play the engine move from this position."));
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

      const previousMoveMeta = moves.length
        ? {
            color: moves[moves.length - 1].color,
            from: moves[moves.length - 1].from,
            to: moves[moves.length - 1].to,
            san: moves[moves.length - 1].san,
            uci: moves[moves.length - 1].uci,
            wasCapture: Boolean(moves[moves.length - 1].capturedPiece),
            wasCheck: /[+#]/.test(moves[moves.length - 1].san || "")
          }
        : null;

      moves.push({
        plyIndex: index,
        moveNumber: toMoveNumber(index, played.color),
        color: played.color,
        beforeFen,
        afterFen: chess.fen(),
        from: played.from,
        to: played.to,
        uci: `${played.from}${played.to}${played.promotion || ""}`,
        san: played.san,
        capturedPiece: played.captured || null,
        previousMoveMeta
      });
    });

    return moves;
  }

  class StockfishClient {
    constructor() {
      const stockfishUrl = safeRuntimeGetURL("vendor-stockfish.js");
      const wasmUrl = safeRuntimeGetURL("vendor-stockfish.wasm");
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
      this.worker.addEventListener("message", (event) => this.handleLine(String(event?.data ?? "")));
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
      try {
        this.worker.postMessage("quit");
      } catch {
        /* noop */
      }

      if (typeof this.worker?.terminate === "function") {
        this.worker.terminate();
      }
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

      moves.push(move.san || move.moveSan || move.uci || "move");
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
        setStatus(`Analyzing move ${index + 1} of ${moves.length}: ${move.san || move.moveSan || "this move"}`);
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
        const moveData = {
          ...move,
          cpl,
          accuracy,
          label,
          bestUci: best.bestmove,
          bestSan: uciToSan(move.beforeFen, best.bestmove),
          afterScore,
          bestScore,
          pvSan: pvToSan(move.beforeFen, best.pv)
        };
        const teaching = buildMoveTeachingNotes(moveData);

        results.push({
          ...moveData,
          playedScore: { unit: "cp", value: playedCp },
          explanation: buildMoveExplanation(moveData),
          category: teaching.category,
          severity: teaching.severity,
          featuresDetected: teaching.featuresDetected,
          movePurpose: teaching.movePurpose,
          mainConcepts: teaching.mainConcepts,
          alternative: teaching.alternative,
          whatChanged: teaching.whatChanged,
          lesson: teaching.lesson,
          advice: teaching.advice
        });

        state.currentResults = results.slice();

        if (index === moves.length - 1 || index % 6 === 0) {
          renderSummary(results);
          renderMoves(results);
          renderChart(results);
        }
      }

      const reviewSummary = buildReviewSummary(gameData, results);
      setReviewHero(reviewSummary);
      setProgress(moves.length, moves.length);
      renderBoardAtPly(0);
      setStatus(`Finished. Reviewed ${results.length} ply with a local Stockfish engine.`);
    } catch (error) {
      console.error(error);
      setStatus(runtimeSafeMessage(error));
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
