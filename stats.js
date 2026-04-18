(function initStatsHelpers(global) {
  const PHASES = ["opening", "middlegame", "endgame"];
  const MIN_GAMES = 1;

  const TAG_EXPLANATIONS = {
    mistake: {
      hung_piece: {
        label: "Loose piece trouble",
        body: () => "One loose piece is doing more damage than a long strategic collapse. Your games are often turning when something is left unprotected."
      },
      missed_threat: {
        label: "Missed threat",
        body: () => "The problem is often not your plan itself. It is the forcing idea you did not answer before continuing with it."
      },
      king_safety: {
        label: "King safety cracks",
        body: () => "The danger is arriving once your king position loosens. Small weaknesses around the king are becoming real targets."
      },
      bad_trade: {
        label: "Bad trade",
        body: () => "Some exchanges look natural, but they are leaving you with the worse version of the position after the dust settles."
      },
      time_pressure: {
        label: "Clock trouble decisions",
        body: () => "The drop is happening when the decisions speed up. Your ideas are still there, but the clock is making the final choice worse."
      },
      missed_tactic: {
        label: "Missed tactic",
        body: () => "The winning shot is often there for a moment, then gone. These positions are asking for a forcing move, not a normal one."
      },
      slow_move: {
        label: "Slow move in a fast position",
        body: () => "Quiet moves are landing in positions that needed urgency. The game is punishing delay more than it is punishing ambition."
      },
      opening_principle_violation: {
        label: "Opening drift",
        body: () => "Early moves are sometimes spending time on side issues instead of development, center control, or king safety."
      },
      poor_endgame_decision: {
        label: "Endgame slip",
        body: () => "The simpler positions are not becoming safer yet. Once the board clears, precision starts to matter more than activity."
      },
      failed_conversion: {
        label: "Advantage not converted",
        body: () => "You are reaching good positions often enough, but not ending the argument quickly enough once you are ahead."
      }
    },
    strength: {
      capitalized_blunder: {
        label: "Punishes loose play",
        body: () => "When your opponent gives you something for free, you usually notice it and cash in instead of letting the chance pass."
      },
      strong_attack: {
        label: "Sharp attacking instinct",
        body: () => "You are comfortable when the game turns concrete. Once the king becomes a target, you tend to spot the momentum quickly."
      },
      good_conversion: {
        label: "Converts advantages",
        body: () => "When you get ahead, you often find the calmer route that keeps the position under control instead of inviting chaos back in."
      },
      solid_endgame: {
        label: "Steady endgame touch",
        body: () => "Simpler positions are not scaring you. You tend to keep structure and technique once the board gets lighter."
      },
      good_time_management: {
        label: "Composed under time pressure",
        body: () => "Your decisions stay cleaner than expected when the clock gets short. That practical steadiness is a real edge."
      },
      strong_opening: {
        label: "Gets out of the opening well",
        body: () => "You usually reach the middlegame without giving away the story early. That is a strong base to build from."
      },
      defensive_resource: {
        label: "Finds defensive resources",
        body: () => "You do not give up immediately when under pressure. You often find the move that keeps the game alive."
      },
      tactical_awareness: {
        label: "Tactical awareness",
        body: () => "You see tactical chances faster than many players at this stage. That gives you real winning chances when the position opens."
      }
    }
  };

  function capitalize(value) {
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
  }

  function humanizeTag(tag) {
    return String(tag || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function sortDesc(obj) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]);
  }

  function buildPatternSummary(games) {
    const recentGames = [...games].slice(0, 20);
    const mistakeCounts = {};
    const goodCounts = {};

    for (const game of recentGames) {
      for (const tag of game.mistakeTags || []) {
        mistakeCounts[tag] = (mistakeCounts[tag] || 0) + 1;
      }
      for (const tag of game.goodTags || []) {
        goodCounts[tag] = (goodCounts[tag] || 0) + 1;
      }
    }

    const topMistake = sortDesc(mistakeCounts)[0] || null;
    const topGood = sortDesc(goodCounts)[0] || null;

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

  function computePhaseStats(games) {
    const stats = {
      opening: { mistakes: 0, blunders: 0, moves: 0, games: 0 },
      middlegame: { mistakes: 0, blunders: 0, moves: 0, games: 0 },
      endgame: { mistakes: 0, blunders: 0, moves: 0, games: 0 }
    };

    for (const game of games) {
      for (const phase of PHASES) {
        const phaseData = game.phaseBreakdown?.[phase];
        if (!phaseData) {
          continue;
        }

        stats[phase].mistakes += Number(phaseData.mistakes || 0);
        stats[phase].blunders += Number(phaseData.blunders || 0);
        stats[phase].moves += Number(phaseData.moves || 0);
        stats[phase].games += 1;
      }
    }

    const rate = (phase) => (phase.mistakes + 2 * phase.blunders) / Math.max(1, phase.moves);

    let weakestPhase = null;
    let worst = -Infinity;

    for (const phase of PHASES) {
      const currentRate = rate(stats[phase]);
      stats[phase].rate = currentRate;
      if ((stats[phase].moves > 0 || stats[phase].games > 0) && currentRate > worst) {
        worst = currentRate;
        weakestPhase = phase;
      }
    }

    return { ...stats, weakestPhase };
  }

  function generateRevealHeadline(profile) {
    if (!profile.sampleSize) {
      return "Your Chess DNA will appear after your first saved game.";
    }

    if (profile.sampleSize === 1) {
      if (profile.weakestPhase === "endgame") {
        return "Your first game suggests the later phase is where things slipped.";
      }
      if (profile.weakestPhase === "middlegame" && profile.mostStablePhase === "opening") {
        return "Your first game held together early, then slipped in the middlegame.";
      }
      if (profile.weakestPhase === "opening") {
        return "Your first game suggests the trouble started before the game could settle.";
      }
      return "Your first game already hints at where the pressure starts to build.";
    }

    if (profile.topMistakeCount >= 2 && profile.topMistakeCount >= Math.ceil(profile.sampleSize / 2)) {
      if (profile.biggestWeakness === "hung_piece") {
        return "Your games are being decided by one recurring mistake: loose pieces.";
      }
      if (profile.biggestWeakness === "missed_threat") {
        return "Your games are often turning on the threat you did not answer first.";
      }
      if (profile.biggestWeakness === "failed_conversion") {
        return "You are getting good positions, then letting them stay alive too long.";
      }
    }

    if (profile.mostStablePhase === "opening" && profile.weakestPhase === "middlegame") {
      return "You are surviving the opening, but losing control in the middlegame.";
    }
    if (profile.mostStablePhase === "opening" && profile.weakestPhase === "endgame") {
      return "You stay stable early, then slip once the game simplifies.";
    }
    if (profile.weakestPhase === "opening") {
      return "Your games are starting with problems before they get a chance to settle.";
    }
    if (profile.weakestPhase === "endgame") {
      return "Your biggest issue so far is not the opening. It is what happens later.";
    }

    return "One pattern is starting to separate itself from the rest of your game.";
  }

  function generateProfileSummary(profile) {
    if (!profile.sampleSize) {
      return "No saved games yet. Analyze a game and this page will start turning your results into a real profile.";
    }

    const weakPhaseText = profile.weakestPhase ? `the ${profile.weakestPhase}` : "later phases";
    const stablePhaseText = profile.mostStablePhase ? `the ${profile.mostStablePhase}` : "the calmer parts of the game";
    const topMistakeText = profile.biggestWeakness ? humanizeTag(profile.biggestWeakness).toLowerCase() : "one recurring mistake";

    if (profile.sampleSize === 1) {
      return `Your profile is still forming, but this first result already points somewhere useful: the problem was not ${stablePhaseText === weakPhaseText ? "just the whole game" : stablePhaseText}. It was ${weakPhaseText}, where ${topMistakeText} started to matter.`;
    }

    if (profile.sampleSize <= 3) {
      return `This is still an early signal, not a verdict. So far, your games are not breaking in the same place every time, but ${weakPhaseText} is standing out more than the rest, with ${topMistakeText} showing up often enough to matter.`;
    }

    if (profile.mostStablePhase && profile.weakestPhase && profile.mostStablePhase !== profile.weakestPhase) {
      return `Across your recent games, the contrast is clear: you are steadier in the ${profile.mostStablePhase}, but the errors cluster in the ${profile.weakestPhase}. That usually means the issue is not overall understanding. It is keeping control when the position changes character.`;
    }

    return `Across your recent games, ${topMistakeText} keeps showing up as a real theme. That makes this less about one bad result and more about a habit worth fixing.`;
  }

  function generateArchetype(profile) {
    if (!profile.sampleSize) {
      return {
        title: "The Profile Still Forming",
        description: "You need a few saved games before the pattern feels real. One or two results can point somewhere, but they should not define you yet."
      };
    }

    if (profile.mostStablePhase === "opening" && profile.weakestPhase === "middlegame") {
      return {
        title: "The Fast Starter",
        description: "You usually reach a playable middlegame, which is good. The trouble starts once the position gets sharper and the decisions stop being automatic."
      };
    }

    if (profile.mostStablePhase === "opening" && profile.weakestPhase === "endgame") {
      return {
        title: "The Late-Game Slipper",
        description: "You often survive the early phase just fine. The points are leaking later, when simpler positions still demand patience and precision."
      };
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return {
        title: "The Unstable Converter",
        description: "You are earning good positions often enough. The next leap is learning how to close them without letting counterplay back in."
      };
    }

    if (profile.biggestStrength === "strong_attack" || profile.biggestStrength === "tactical_awareness") {
      return {
        title: "The Sharp Attacker",
        description: "You naturally understand momentum and tactical chances. The challenge is making the quiet phases of the game as reliable as the sharp ones."
      };
    }

    if (profile.biggestStrength === "good_conversion" || profile.biggestStrength === "solid_endgame") {
      return {
        title: "The Solid Builder",
        description: "You look most comfortable when the game can be brought under control. That stability is useful, and now it needs stronger support earlier in the game."
      };
    }

    return {
      title: "The Early Stabilizer",
      description: "You seem capable of reaching playable positions, but one recurring weakness keeps reshaping the rest of the game. The next improvement is about removing that leak."
    };
  }

  function generateMainCoachingFocus(profile) {
    if (!profile.sampleSize) {
      return {
        title: "Start the profile",
        description: "Save a few analyzed games first. The more real game endings we keep, the sharper this diagnosis becomes."
      };
    }

    if (profile.biggestWeakness === "hung_piece") {
      return {
        title: "What is holding you back is loose-piece discipline.",
        description: "Your games are not always collapsing because of a long plan gone wrong. They are often turning when one piece loses protection and the rest of the position cannot recover."
      };
    }

    if (profile.biggestWeakness === "missed_threat") {
      return {
        title: "What is holding you back is threat awareness.",
        description: "You are sometimes playing your move before fully respecting your opponent's idea. That one skipped check-captures-threats scan is changing the result."
      };
    }

    if (profile.weakestPhase === "endgame") {
      return {
        title: "What is holding you back is the later phase of the game.",
        description: "Right now, the opening is not the main emergency. The bigger leak is what happens once the board gets lighter and every move carries more technical weight."
      };
    }

    if (profile.weakestPhase === "middlegame") {
      return {
        title: "What is holding you back is the transition into complexity.",
        description: "You often reach playable positions first. Then the game sharpens, the position stops guiding you, and the mistakes start clustering."
      };
    }

    return {
      title: `What is holding you back is the ${profile.weakestPhase || "most fragile"} phase.`,
      description: "That is where your errors are costing the most right now, so that is where your next rating gains are likely hiding too."
    };
  }

  function generateImprovementFocus(profile) {
    if (!profile.sampleSize) {
      return {
        title: "Analyze one full game first.",
        description: "One saved game is enough to start the profile. After that, this section becomes much more specific."
      };
    }

    if (profile.biggestWeakness === "hung_piece") {
      return {
        title: "Before every active move, ask what becomes loose.",
        description: "This is your highest-value fix right now. A three-second scan for undefended pieces will save more points than studying new openings."
      };
    }

    if (profile.biggestWeakness === "missed_threat") {
      return {
        title: "Make your next move start with their threat, not yours.",
        description: "The fastest improvement edge is a checks-captures-threats scan before every serious decision. That habit will prevent a lot of avoidable damage."
      };
    }

    if (profile.weakestPhase === "endgame") {
      return {
        title: "Treat simple positions as technical, not automatic.",
        description: "Your next improvement focus is surviving the transition into the endgame with the same care you give sharp middlegames."
      };
    }

    if (profile.weakestPhase === "middlegame") {
      return {
        title: "Keep your accuracy once the position gets complicated.",
        description: "Your priority is not more opening theory right now. It is making better decisions once the game stops feeling familiar."
      };
    }

    return {
      title: `Give extra attention to the ${profile.weakestPhase || "fragile"} phase.`,
      description: "That is the phase where a focused training habit will pay back the fastest."
    };
  }

  function generateFixFirstSection(profile) {
    if (!profile.sampleSize) {
      return {
        title: "What to fix first: build the profile with one saved game.",
        description: "As soon as you save a reviewed game, this section will stop guessing and start pointing at one concrete training priority."
      };
    }

    if (profile.biggestWeakness === "poor_endgame_decision" || profile.weakestPhase === "endgame") {
      return {
        title: "What to fix first: slow down in technical endgames.",
        description: "Your games are not mainly collapsing because of bad openings. They are slipping later, when one inaccurate move in a simple position changes the result."
      };
    }

    if (profile.biggestWeakness === "hung_piece") {
      return {
        title: "What to fix first: stop leaving pieces loose during active play.",
        description: "This is the fastest rating leak to plug. The issue is not lack of ideas. It is losing material because one defender moved and never got replaced."
      };
    }

    if (profile.biggestWeakness === "missed_tactic" || profile.biggestWeakness === "missed_threat") {
      return {
        title: "What to fix first: improve your threat scan before every serious move.",
        description: "Your profile suggests that one missed tactical idea is deciding too many games. The fix is practical: pause, look for forcing moves, then continue with your plan."
      };
    }

    if (profile.biggestWeakness === "opening_principle_violation" || profile.weakestPhase === "opening") {
      return {
        title: "What to fix first: make your first ten moves simpler and cleaner.",
        description: "You do not need more opening theory right away. You need more repeatability in development, center control, and king safety."
      };
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return {
        title: "What to fix first: convert better positions without reopening the game.",
        description: "You are reaching playable or even better positions often enough. The next step is learning how to reduce counterplay instead of chasing extra complications."
      };
    }

    return {
      title: `What to fix first: stabilize the ${profile.weakestPhase || "fragile"} phase.`,
      description: "This is where your results are swinging most often, so the simplest improvement plan is to put your training there first."
    };
  }

  function generateImprovementActions(profile) {
    if (profile.biggestWeakness === "poor_endgame_decision" || profile.weakestPhase === "endgame") {
      return [
        "Before every endgame move, check your opponent's threat first.",
        "Activate your king before grabbing side pawns.",
        "When low on time, simplify into positions you understand instead of calculating long side lines.",
        "From move 25 onward, ask whether trading helps your king or your opponent's."
      ];
    }

    if (profile.biggestWeakness === "hung_piece") {
      return [
        "Before every active move, ask which of your pieces becomes undefended.",
        "After your opponent moves, scan checks, captures, threats, and loose pieces before making plans.",
        "When a piece is attacked twice, count defenders before assuming it is safe.",
        "If the position is sharp, choose moves that keep your pieces connected."
      ];
    }

    if (profile.biggestWeakness === "missed_tactic" || profile.biggestWeakness === "missed_threat") {
      return [
        "Pause after every opponent move and scan checks, captures, and threats.",
        "When one move feels natural, force yourself to compare it with one forcing alternative.",
        "In tactical positions, calculate the reply you fear most before playing your move.",
        "If the board opens, assume there is a concrete tactic until you prove otherwise."
      ];
    }

    if (profile.biggestWeakness === "opening_principle_violation" || profile.weakestPhase === "opening") {
      return [
        "Review the first ten moves of recent losses and mark where development slowed down.",
        "Prioritize development, center control, and castling over edge-pawn moves.",
        "Pick one simple opening response and repeat it until the early structure feels automatic.",
        "If you move the same piece twice early, make sure it wins something concrete."
      ];
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return [
        "When you are better, look for trades before looking for another attack.",
        "Choose positions with less counterplay if the clock is getting short.",
        "After winning material, ask what the safest improving move is, not the flashiest one.",
        "If you have the advantage, keep your king safe and your pieces coordinated before pushing pawns."
      ];
    }

    return [
      `Give the ${profile.weakestPhase || "fragile"} phase a deliberate pause before each move.`,
      "When the position changes character, slow down instead of assuming the same plan still works.",
      "Review your last losses only from the phase where the game started turning.",
      "Choose the simpler, more stable option when you are unsure."
    ];
  }

  function generateTrainingPlan(profile) {
    if (profile.biggestWeakness === "poor_endgame_decision" || profile.weakestPhase === "endgame") {
      return [
        "Practice king and pawn endings until basic opposition feels automatic.",
        "Study rook ending activity: active rook, king position, and pawn targets.",
        "Review recent games from move 25 onward only and ask where the technical slip began.",
        "Do conversion drills where the goal is to win a better ending cleanly."
      ];
    }

    if (profile.biggestWeakness === "hung_piece") {
      return [
        "Review your last ten losses and mark every move where a piece became loose.",
        "Do short tactical sets focused on loose pieces, overloading, and removal of the defender.",
        "Play slower games where your only goal is to keep every piece defended.",
        "Annotate one game per week with a special focus on piece safety."
      ];
    }

    if (profile.biggestWeakness === "missed_tactic" || profile.biggestWeakness === "missed_threat") {
      return [
        "Do 10 to 20 tactical puzzles per day, especially forks, pins, and discovered attacks.",
        "Pause after each puzzle attempt and name the forcing move type you missed.",
        "Review blitz losses by stopping right before the blunder and asking what the threat was.",
        "Play a few slower games each week where you verbalize checks, captures, and threats."
      ];
    }

    if (profile.biggestWeakness === "opening_principle_violation" || profile.weakestPhase === "opening") {
      return [
        "Review the first ten moves of recent losses and classify each mistake as development, center control, or king safety.",
        "Build one reliable response against your most common opening and repeat it.",
        "Study annotated model games that reach your preferred structures.",
        "Play training games where the goal is simply to finish development cleanly."
      ];
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return [
        "Review winning positions you failed to convert and identify the first move that reopened counterplay.",
        "Study simple annotated games where a small advantage is converted step by step.",
        "Do technical drills where you must trade down into a winning endgame.",
        "Play training games starting from plus-equal positions and focus on simplification."
      ];
    }

    return [
      `Review losses starting from the ${profile.weakestPhase || "critical"} phase instead of replaying the whole game.`,
      "Play slower games and write one sentence after each loss about where the position changed.",
      "Use post-game review to compare the first bad move with the best practical alternative."
    ];
  }

  function generateResourceTypes(profile) {
    if (profile.biggestWeakness === "poor_endgame_decision" || profile.weakestPhase === "endgame") {
      return [
        "Endgame puzzle sets",
        "Annotated endgame examples",
        "Slow-game reviews focused on move 25+",
        "Rook ending fundamentals"
      ];
    }

    if (profile.biggestWeakness === "hung_piece") {
      return [
        "Tactical puzzles about loose pieces",
        "Annotated blunder review",
        "Slow games with piece-safety notes",
        "Puzzle themes: overload, deflection, removal of defender"
      ];
    }

    if (profile.biggestWeakness === "missed_tactic" || profile.biggestWeakness === "missed_threat") {
      return [
        "Daily tactical puzzles",
        "Puzzle themes: forks, pins, discovered attacks",
        "Blitz review with a checks-captures-threats lens",
        "Annotated tactical master games"
      ];
    }

    if (profile.biggestWeakness === "opening_principle_violation" || profile.weakestPhase === "opening") {
      return [
        "Opening review of recent losses",
        "Annotated model games in your openings",
        "Development and center-control checklists",
        "Simple repertoire notes"
      ];
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return [
        "Annotated conversion games",
        "Simplification drills",
        "Technical endgame examples",
        "Slow games with post-game conversion review"
      ];
    }

    return [
      "Slow games with post-game analysis",
      "Annotated master games in your structures",
      "Targeted review of the weakest phase",
      "Practical puzzle sets"
    ];
  }

  function generateProgressMarker(profile) {
    if (!profile.sampleSize) {
      return "Progress will become visible once a few analyzed games are saved here.";
    }

    if (profile.biggestWeakness === "poor_endgame_decision" || profile.weakestPhase === "endgame") {
      return "Progress would look like fewer late blunders, calmer endgames, and fewer losses caused by one rushed move after move 30.";
    }

    if (profile.biggestWeakness === "hung_piece") {
      return "Progress would look like fewer games ending after a single loose piece, fewer sudden material drops, and more losses where the fight lasts longer.";
    }

    if (profile.biggestWeakness === "missed_tactic" || profile.biggestWeakness === "missed_threat") {
      return "Progress would look like fewer one-move tactical collapses, more games decided strategically, and fewer moments where the engine punishment is immediate.";
    }

    if (profile.biggestWeakness === "opening_principle_violation" || profile.weakestPhase === "opening") {
      return "Progress would look like reaching the middlegame with fewer deficits, less early king danger, and fewer games that feel bad before move 12.";
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return "Progress would look like more wins from better positions, fewer swing-backs after getting ahead, and cleaner trades when you have the advantage.";
    }

    return `Progress would look like a lower error rate in the ${profile.weakestPhase || "most fragile"} phase and fewer games decided by the same recurring habit.`;
  }

  function generateWarning(profile) {
    if (!profile.sampleSize) {
      return {
        title: "Watch for your first recurring pattern.",
        description: "The first few saved games are enough to show whether the damage starts early, late, or around one repeating habit."
      };
    }

    if (profile.biggestWeakness === "hung_piece") {
      return {
        title: "Watch for this: your losses may begin with one loose piece.",
        description: "Not every loss is a long collapse. Sometimes the whole game turns because one defender moved and never got replaced."
      };
    }

    if (profile.biggestWeakness === "failed_conversion") {
      return {
        title: "Watch for this: being better is not the same as being safe.",
        description: "Once you get the advantage, the danger is letting counterplay back in by chasing more than you need."
      };
    }

    if (profile.weakestPhase === "endgame") {
      return {
        title: "Watch for this: simpler can still mean harder.",
        description: "When the board gets quieter, your moves may get looser, not safer. That is a technical warning, not a tactical one."
      };
    }

    if (profile.weakestPhase === "middlegame") {
      return {
        title: "Watch for this: your errors rise when the position stops playing itself.",
        description: "Once the middlegame gets tactical or messy, your accuracy drops faster than it does in calmer openings."
      };
    }

    return {
      title: "Watch for this: one repeated habit is shaping too many results.",
      description: "That is good news in a way, because one clear habit is easier to fix than ten random problems."
    };
  }

  function explainTag(tag, count, profile, kind = "mistake") {
    const bank = kind === "strength" ? TAG_EXPLANATIONS.strength : TAG_EXPLANATIONS.mistake;
    const entry = bank[tag];
    const label = entry?.label || humanizeTag(tag);
    const body = entry?.body?.(count, profile) || `${label} is showing up as part of your current profile.`;
    const suffix = count <= 1
      ? profile.sampleSize <= 3
        ? "This is just an early signal so far."
        : "It has shown up once so far."
      : profile.sampleSize <= 3
        ? `It has already shown up ${count} times, which is enough to watch closely.`
        : `It has shown up ${count} times across your saved games.`;

    return {
      label,
      body: `${body} ${suffix}`.trim()
    };
  }

  function buildProfileSummary(profile) {
    return generateProfileSummary(profile);
  }

  function computeChessProfile(games) {
    const mistakeCounts = {};
    const goodCounts = {};

    for (const game of games) {
      for (const tag of game.mistakeTags || []) {
        mistakeCounts[tag] = (mistakeCounts[tag] || 0) + 1;
      }
      for (const tag of game.goodTags || []) {
        goodCounts[tag] = (goodCounts[tag] || 0) + 1;
      }
    }

    const topMistakes = sortDesc(mistakeCounts).slice(0, 3);
    const topStrengths = sortDesc(goodCounts).slice(0, 3);
    const phaseStats = computePhaseStats(games);

    let stablePhase = null;
    let bestRate = Infinity;
    for (const phase of PHASES) {
      const phaseData = phaseStats[phase];
      if ((phaseData.moves > 0 || phaseData.games > 0) && phaseData.rate < bestRate) {
        bestRate = phaseData.rate;
        stablePhase = phase;
      }
    }

    const sampleSize = games.length;
    const profile = {
      sampleSize,
      biggestWeakness: topMistakes[0]?.[0] || null,
      biggestStrength: topStrengths[0]?.[0] || null,
      topMistakeCount: topMistakes[0]?.[1] || 0,
      topStrengthCount: topStrengths[0]?.[1] || 0,
      commonMistakes: topMistakes,
      commonStrengths: sampleSize >= 5 ? topStrengths : topStrengths.slice(0, Math.min(topStrengths.length, 2)),
      weakestPhase: phaseStats.weakestPhase,
      mostStablePhase: stablePhase,
      phaseLabel: sampleSize === 0
        ? "No saved games yet."
        : stablePhase
          ? `${sampleSize <= 3 ? "Most stable so far" : "Most stable phase"}: ${capitalize(stablePhase)}`
          : "Profile still forming",
      phaseStats
    };

    profile.revealHeadline = generateRevealHeadline(profile);
    profile.summaryText = generateProfileSummary(profile);
    profile.archetype = generateArchetype(profile);
    profile.mainCoachingFocus = generateMainCoachingFocus(profile);
    profile.improvementFocus = generateImprovementFocus(profile);
    profile.fixFirst = generateFixFirstSection(profile);
    profile.improvementActions = generateImprovementActions(profile);
    profile.trainingPlan = generateTrainingPlan(profile);
    profile.resourceTypes = generateResourceTypes(profile);
    profile.progressMarker = generateProgressMarker(profile);
    profile.warning = generateWarning(profile);

    return profile;
  }

  global.CRFStats = {
    MIN_GAMES,
    PHASES,
    capitalize,
    humanizeTag,
    buildPatternSummary,
    computePhaseStats,
    computeChessProfile,
    buildProfileSummary,
    generateRevealHeadline,
    generateArchetype,
    generateMainCoachingFocus,
    generateFixFirstSection,
    generateImprovementActions,
    generateTrainingPlan,
    generateResourceTypes,
    generateProgressMarker,
    generateWarning,
    explainTag
  };
})(self);
