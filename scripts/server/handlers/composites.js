'use strict';

/**
 * Composite handlers that orchestrate multiple ctx.handlers cross-calls.
 * Extracted from createMcpHandlers() in handlers.js.
 *
 * These handlers do NOT contain closure functions (like runScreenRankedImpl,
 * runLeagueScreen, etc.) — they ONLY use ctx.handlers.* for cross-calls.
 */

const { DEFAULT_LEAGUES } = require('../../../lib/ssb-shared-utils');
const { getMarketsForSport } = require('../../../lib/ssb-market-registry');
const { ok } = require('../../../lib/response-envelope');
const { getBacktestSummary, readCheckpoint, writeCheckpoint } = require('../../../lib/ssb-picks');
const { suggestStakes } = require('../../../lib/ssb-risk-score');
const { parseNaturalLanguagePropQuery } = require('../../../lib/ssb-query-parser');

function findSmartBetMatch(screenResult, selection, league, market) {
  let match = null;
  let matchLeague = league || null;
  let matchMarket = market;

  for (const entry of screenResult.results || []) {
    const found = (entry.candidates || []).find(
      (candidate) => candidate.selection && candidate.selection.toLowerCase().includes(selection.toLowerCase())
    );
    if (found) {
      match = found;
      matchLeague = entry.league || matchLeague;
      matchMarket = entry.market || matchMarket;
      break;
    }
  }

  return { match, matchLeague, matchMarket };
}

async function runSmartBet(ctx, args = {}) {
  const selection = String(args.selection || '').trim();
  const book = String(args.book || '').trim();
  const league = String(args.league || '').trim() || undefined;
  const market = String(args.market || 'Moneyline').trim();
  const bankroll = Number.isFinite(Number(args.bankroll)) ? Number(args.bankroll) : 1000;
  const verbosity = args.verbosity || 'standard';

  if (!selection) {
    const error = new Error('selection is required');
    error.code = 'MISSING_PARAMS';
    error.category = 'validation';
    error.status = 400;
    throw error;
  }
  if (!book) {
    const error = new Error('book is required');
    error.code = 'MISSING_PARAMS';
    error.category = 'validation';
    error.status = 400;
    throw error;
  }

  const screenResult = await ctx.handlers.quick_screen({
    book,
    leagues: league ? [league] : undefined,
    markets: [market],
    limit: 20,
    includeResearch: false,
    verbosity: 'full'
  });

  const { match, matchLeague, matchMarket } = findSmartBetMatch(screenResult, selection, league, market);

  if (!match) {
    return {
      ok: true,
      found: false,
      message: `No play found for "${selection}" on ${book}. The slate may be empty or the player/team isn't in today's games.`,
      activeSlate: screenResult.activeSlate || []
    };
  }

  let validation;
  try {
    validation = await ctx.handlers.validate_play({
      league: matchLeague,
      gameId: match.gameId,
      selection: match.selection,
      market: matchMarket,
      book
    });
  } catch (err) {
    validation = { _error: true, error: err?.message || String(err) };
  }

  let bestPrice;
  try {
    bestPrice = await ctx.handlers.find_best_price({
      game: match.game,
      league: matchLeague,
      market: matchMarket,
      selection: match.selection
    });
  } catch (err) {
    bestPrice = { _error: true, error: err?.message || String(err) };
  }

  let staking = null;
  if (validation?.verdict === 'BET' || validation?.verdict === 'CONSIDER') {
    try {
      const stakingResult = await ctx.handlers.staking_plan({
        bankroll,
        leagues: matchLeague ? [matchLeague] : undefined,
        markets: [matchMarket],
        targetTiers: validation.verdict === 'BET' ? ['TIER 1'] : ['TIER 1', 'TIER 2']
      });
      const stakingStakes = stakingResult?.stakes || [];
      staking =
        stakingStakes.find((p) => p.selection && p.selection.toLowerCase().includes(selection.toLowerCase())) || null;
    } catch (err) {
      staking = { _error: true, error: err?.message || String(err) };
    }
  }

  return {
    ok: true,
    found: true,
    play: {
      selection: match.selection,
      game: match.game,
      league: matchLeague,
      market: matchMarket,
      odds: match.odds,
      edge: match.edge,
      executionQuality: match.executionQuality,
      movementDisposition: match.movementDisposition,
      displayTier: match.displayTier,
      kaiCall: match.kaiCall,
      confidenceTier: match.confidenceTier,
      riskScore: match.riskScore
    },
    verdict: validation
      ? {
          verdict: validation.verdict,
          tier: validation.tier,
          actionableSummary: validation.verdictSummary?.actionableSummary,
          riskFlags: validation.verdictSummary?.riskFlags || [],
          movementDisposition: validation.verdictSummary?.movementDisposition
        }
      : null,
    bestPrice: bestPrice?.found ? bestPrice.bestPrice : null,
    staking: staking
      ? {
          stake: staking.stakeDollars,
          stakePct: staking.bankrollPct,
          reason: staking.rationale
        }
      : null,
    verbosity
  };
}

async function runCompositeAsk(ctx, args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    const error = new Error(
      'query is required. Pass a natural language bet query, e.g. "best plays on Fliff today" or "Tatum over 29.5 points".'
    );
    error.code = 'MISSING_PARAMS';
    error.category = 'validation';
    error.status = 400;
    throw error;
  }
  const parsed = parseNaturalLanguagePropQuery(query);

  // Execute the appropriate tool based on the parsed query.
  // One call = one answer — no more parse-only suggest-then-call-again pattern.

  const isValidationQuery = /\b(should i bet|is .* safe|validate|check .* play)\b/i.test(query);

  // Build pure-args objects for each branch so we can attach
  // _suggestedTool metadata regardless of which path was taken.
  const queryArgs = {
    query,
    parsed: {
      league: parsed.league,
      book: parsed.book,
      market: parsed.market,
      side: parsed.side,
      line: parsed.line,
      player: parsed.player,
      rawText: parsed.raw
    }
  };

  let result, executedTool, executedArgs;

  if (isValidationQuery && parsed.player) {
    executedTool = 'validate_play';
    executedArgs = {
      ...(parsed.league ? { league: parsed.league } : {}),
      selection: parsed.player,
      ...(parsed.book ? { book: parsed.book } : {})
    };
    result = await ctx.handlers.validate_play(executedArgs);
  } else if (parsed.book) {
    executedTool = 'quick_screen';
    executedArgs = {
      books: [parsed.book],
      ...(parsed.league ? { leagues: [parsed.league] } : {}),
      ...(parsed.market ? { markets: [parsed.market] } : {})
    };
    result = await ctx.handlers.quick_screen(executedArgs);
  } else if (parsed.player) {
    executedTool = 'player_context';
    executedArgs = {
      player: parsed.player,
      ...(parsed.league ? { sport: parsed.league } : {})
    };
    result = await ctx.handlers.player_context(executedArgs);
  } else {
    executedTool = 'quick_screen';
    executedArgs = { mode: 'recommended' };
    result = await ctx.handlers.quick_screen(executedArgs);
  }

  // Preserve the debug surface — agents can see what was called and
  // with what args, alongside the actual result.
  return {
    ok: result && result.ok !== false,
    ...queryArgs,
    _executed: { tool: executedTool, args: executedArgs },
    result
  };
}

function createUnavailableTodayBriefing(userType, error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'TODAY_BRIEFING_UNAVAILABLE',
      message: error?.message || 'today briefing unavailable'
    },
    asOf: new Date().toISOString(),
    leagues: [],
    book: 'NoVigApp',
    slate: [],
    pendingPicks: [],
    stats: null,
    backtest: null,
    summary: `Today briefing unavailable for ${userType}`
  };
}

async function runCompositeGetStarted(ctx, args = {}) {
  const userType = args.user_type || 'intermediate';

  const workflows = {
    casual: {
      summary: 'For casual bettors who just want top picks.',
      prompt: [
        '1. Call today({ leagues: [...], book: "NoVigApp" }) for a one-call briefing — sharp slate + your pending picks + recent stats.',
        '2. For quick picks: quick_screen({ book: "NoVigApp", kaiCall: ["BET"], sortBy: "start", verbosity: "minimal" }). Present the top 3-5 plays.',
        '3. Before recommending: player_context({ player, sport }) for injury/availability flags.',
        '4. Use ev_candidates when you need the Positive EV board directly; exact validation still controls actionability.'
      ],
      key_tools: ['today', 'quick_screen', 'player_context'],
      pitfall:
        'tier/kaiCall/edge are signal-quality ratings, not win predictions. TIER 1 means sharp books agree — it does not mean the side will win.'
    },
    intermediate: {
      summary: 'For bettors who understand edge and tier.',
      prompt: [
        '1. Call today() for a one-call briefing (slate + your pending picks + stats).',
        '2. For deeper scanning: quick_screen({ leagues: [...], book: "NoVigApp", kaiCall: ["BET"], sortBy: "start", verbosity: "standard" }).',
        '3. Before recommending any play: validate_play({ league, gameId, playId, market, book }) — always pass playId from the screen row.',
        '4. Check player_context({ player, sport }) for injury flags on final picks.',
        '5. Optionally: find_best_price({ league, market, game, selection }) to line-shop.',
        '6. To bet: place_bet({ league, gameId, playId, selection, market, book, stake }). It validates first and rejects PASS plays.',
        '7. After games settle: resolve_pick({ id, result }) for each logged pick.'
      ],
      key_tools: [
        'today',
        'quick_screen',
        'validate_play',
        'player_context',
        'place_bet',
        'resolve_pick',
        'find_best_price'
      ],
      pitfall:
        'Always pass playId to validate_play — bare selection strings fail. Use league-specific market names (get_market_registry for the mapping).'
    },
    sharp: {
      summary: 'For sharp bettors who want full data and control.',
      prompt: [
        '1. Call today() for a one-call briefing.',
        '2. For full data: quick_screen({ leagues: [...], book: "NoVigApp", kaiCall: ["BET"], sortBy: "edge", verbosity: "full" }).',
        '3. Use quick_screen({ mode: "sharp" }) for multi-sharp-book confirmation.',
        '4. Use sharp_consensus({ league, market }) for multi-window movement analysis.',
        '5. Validate every play with validate_play — movementDisposition is the single field to trust.',
        '6. get_play_details({ league, gameIds: [...] }) for full line history on specific plays.',
        '7. staking_plan({ picks: [...] }) for Kelly sizing.',
        '8. place_bet + resolve_pick for tracking.'
      ],
      key_tools: [
        'today',
        'quick_screen',
        'sharp_consensus',
        'validate_play',
        'get_play_details',
        'staking_plan',
        'place_bet',
        'resolve_pick'
      ],
      pitfall:
        'movementDisposition is the single field to check: supportive_clean = BET, supportive_bouncy = CONSIDER, adverse = PASS. Do not cross-reference movementGrade + movementLabel separately.'
    }
  };

  const workflow = workflows[userType] || workflows.intermediate;
  // Always include a top-level reminder of the honest-scope caveat so an
  // agent that ONLY reads get_started (and skips individual tool
  // descriptions) still sees it. Tier and kaiCall are signal-quality
  // ratings, not win-probability predictions.
  const out = {
    ...workflow,
    honest_scope:
      'TIER 1-4, kaiCall (BET/CONSIDER/PASS), edge, and screenScore are quality ratings on what sharp books are doing — NOT predictions about which side will win. TIER 1 means sharp books agree; it does not mean the side will win. Use to inform handicapping, not to outsource decisions.',
    edge_cases: [
      'validate_play_no_match: If validate_play returns lookupStatus="lookup_failed" with verdict CONSIDER, the screen row could not be rehydrated — this is a stale snapshot, not a negative signal. Pass playId from the prior quick_screen call for exact matching. Do NOT treat this as PASS.',
      'soccer_markets: quick_screen with leagues=["Soccer"] uses Draw No Bet / Match Handicap / Total Goals by default. If you get 0 results, the book may genuinely not have soccer that day. Probe find_best_price with market="Draw No Bet" on a known fixture.',
      'tennis_start_time: validate_play may return stale start timestamps for tennis. Check verdictSummary.movementDisposition and gameContext — if surface/level resolve to a real tournament, the match is live regardless of the API start time.',
      'movement_disposition: validate_play.verdictSummary.movementDisposition is the single field to check: supportive_clean = BET, supportive_bouncy = CONSIDER, adverse_recent/adverse_full = PASS. Do not cross-reference movementGrade + movementLabel separately.',
      'empty_slate: If quick_screen returns 0 candidates across all leagues, run health_status first. If auth is valid, the slate is genuinely empty. Do not force recommendations.'
    ]
  };

  // Keep get_started static: today() fans out live network work and can outlive
  // a response timeout. Call today() separately when a live briefing is needed.
  out.today_briefing = createUnavailableTodayBriefing(
    userType,
    Object.assign(new Error('live today briefing is not run by get_started'), { code: 'TODAY_BRIEFING_SKIPPED' })
  );

  return out;
}

async function runCompositePlaceBet(ctx, args = {}) {
  if (!args.league || !args.selection || !args.market) {
    const error = new Error('league, selection, and market are required');
    error.code = 'VALIDATION_ERROR';
    error.category = 'validation';
    error.status = 400;
    throw error;
  }

  const validation = await ctx.handlers.validate_play({
    league: args.league,
    gameId: args.gameId,
    selection: args.selection,
    market: args.market,
    book: args.book
  });

  if (!validation || !validation.ok || !validation.verdict) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: `validate_play did not return a verdict: ${(validation && validation.error && validation.error.message) || 'unknown'}`
      }
    };
  }

  if (validation.verdict === 'PASS') {
    return {
      ok: false,
      error: {
        code: 'BET_REJECTED',
        message: `validate_play returned PASS — this play is not a bet. reasons: ${(validation.reasons || []).join('; ')}`
      },
      validation: {
        verdict: validation.verdict,
        tier: validation.tier,
        reasons: validation.reasons
      }
    };
  }

  const logged = await ctx.handlers.log_pick({
    game: validation.play && validation.play.game ? validation.play.game : args.gameId,
    league: args.league,
    market: args.market,
    selection: args.selection,
    odds: validation.play && Number.isFinite(validation.play.odds) ? validation.play.odds : args.odds,
    stake: args.stake,
    confidenceTier: validation.tier,
    kaiCall: validation.verdict,
    notes: args.notes
  });

  if (!logged || !logged.ok) {
    return {
      ok: false,
      error: {
        code: 'LOG_FAILED',
        message: (logged && logged.error && logged.error.message) || 'log_pick failed'
      },
      validation: { verdict: validation.verdict, tier: validation.tier, reasons: validation.reasons }
    };
  }

  return {
    ok: true,
    verdict: validation.verdict,
    tier: validation.tier,
    pickId: logged.pick && logged.pick.id,
    pick: logged.pick,
    validation: { verdict: validation.verdict, tier: validation.tier, reasons: validation.reasons },
    workflow: `Validated (${validation.verdict}), logged as pick ${logged.pick && logged.pick.id}. Settle with resolve_pick(id="${logged.pick && logged.pick.id}") after the game.`
  };
}

async function runCompositeToday(ctx, args = {}) {
  const leagues =
    Array.isArray(args.leagues) && args.leagues.length
      ? args.leagues
      : args.league
        ? [args.league]
        : Array.from(DEFAULT_LEAGUES);
  const book = args.book || 'NoVigApp';

  const [slateRes, pendingRes, statsRes, backtestRes] = await Promise.all([
    ctx.handlers
      .quick_screen({
        leagues,
        book,
        limit: args.limit || 100,
        targetTiers:
          Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'],
        // `today` is a bettor-facing card, not raw discovery. Exact-validate
        // every returned candidate and keep it to the local calendar day so
        // stale quotes and tomorrow's matches cannot masquerade as today plays.
        validate: true,
        cardWindow: 'today',
        includeResearch: false,
        lite: true,
        // Card-style query: bound the aggregate odds-history allocation. The
        // composite probes ~35 league×market pairs, and at the full share the
        // serialized odds-history gate congests and aborts pairs. Measured on
        // a 35-pair fan-out (default 1200-call share = 80 games/pair): 185s /
        // 102 plays; 300 (20/pair): 69s / 76 plays; 135 (9/pair): 49s / 48;
        // 90 (6/pair): 37s / 32. 300 keeps most of the card at ~1/3 the time.
        aggregateHistoryAllocation: Number(process.env.PP_TODAY_HISTORY_ALLOCATION) || 300
      })
      .catch((err) => ({
        ok: false,
        _error: true,
        error: `quick_screen: ${err?.message || String(err)}`,
        results: []
      })),
    ctx.handlers
      .get_pick_history({ status: 'pending', days: 1 })
      .catch((err) => ({ ok: false, _error: true, error: `history: ${err?.message || String(err)}`, picks: [] })),
    ctx.handlers
      .get_pick_stats({ days: args.statsDays || 30 })
      .catch((err) => ({ ok: false, _error: true, error: `stats: ${err?.message || String(err)}`, stats: null })),
    Promise.resolve()
      .then(() => getBacktestSummary({ days: args.statsDays || 30 }))
      .catch((err) => ({ ok: false, _error: true, error: `backtest: ${err?.message || String(err)}`, stats: null }))
  ]);

  const slate = (slateRes.results || []).flatMap((e) =>
    (e.candidates || []).map((c) => ({
      game: c.game,
      gameId: c.gameId,
      market: e.market || c.market,
      selection: c.selection,
      odds: c.odds,
      tier: c.confidenceTier,
      kai: c.kaiCall,
      edge: c.consensusEdge || c.edge,
      startCST: c.startCST || null,
      hoursUntilStart: c.hoursUntilStart ?? null,
      movementDisposition: c.movementDisposition || null,
      executionQuality: c.executionQuality || null,
      consensusBookCount: c.consensusBookCount ?? null,
      sharpBookMovementConfirmed: c.sharpBookMovementConfirmed || false
    }))
  );

  const pendingPicks = (pendingRes.picks || []).map((p) => ({
    id: p.id,
    selection: p.selection,
    league: p.league,
    market: p.market,
    odds: p.odds,
    stake: p.stake,
    status: p.status
  }));

  return ok({
    asOf: new Date().toISOString(),
    leagues,
    book,
    slate,
    pendingPicks,
    stats: statsRes.stats || null,
    backtest: backtestRes.ok ? backtestRes : null,
    summary: `${slate.length} sharp plays, ${pendingPicks.length} pending picks, ${statsRes.stats && statsRes.stats.winRate ? statsRes.stats.winRate : 'n/a'} lifetime win rate`
  });
}

async function runCompositeGetAlerts(ctx, args = {}) {
  const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : Array.from(DEFAULT_LEAGUES);
  const lookbackHours = Number.isFinite(Number(args.lookbackHours))
    ? Math.min(48, Math.max(1, Number(args.lookbackHours)))
    : 6;
  const minSteamBooks = Number.isFinite(Number(args.minSteamBooks))
    ? Math.min(5, Math.max(1, Number(args.minSteamBooks)))
    : 2;

  const checkpoint = readCheckpoint();
  const now = new Date().toISOString();
  const alerts = [];
  const errors = [];
  for (const league of leagues) {
    try {
      const defaultMarkets = getMarketsForSport(league);
      // Fan out across per-league default markets instead of Moneyline-only
      const allRows = [];
      for (const market of defaultMarkets) {
        const screenResult = await ctx.handlers.screen_ranked({
          league,
          market,
          limit: 20,
          includeAll: true,
          debug: false,
          compact: true,
          skipHistory: false,
          lookbackHours,
          is_live: false
        });
        const rows = Array.isArray(screenResult?.result) ? screenResult.result : [];
        allRows.push(...rows);
      }
      const rows = allRows;
      if (!rows.length) continue;

      const lastChecked = checkpoint.leagues[league];
      const lastCheckedMs = lastChecked ? new Date(lastChecked).getTime() : 0;

      // Steam moves (strict rule: 3+ books, 5-min window)
      const steamMoves = rows.filter((r) => r.steamMove && r.steamBookCount >= minSteamBooks);
      if (steamMoves.length) {
        alerts.push({
          type: 'steam_move',
          league,
          count: steamMoves.length,
          examples: steamMoves.slice(0, 3).map((r) => ({
            game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
            selection: r.selection || r.participant,
            market: r.screenMarket || r.market,
            direction: r.steamDirection,
            books: r.steamBooks,
            bookCount: r.steamBookCount
          }))
        });
      }

      // Significant CLV shifts (>= 2% CLV proxy)
      const clvShifts = rows.filter((r) => Number.isFinite(r.clvProxyPct) && Math.abs(r.clvProxyPct) >= 2);
      if (clvShifts.length) {
        alerts.push({
          type: 'clv_shift',
          league,
          count: clvShifts.length,
          examples: clvShifts.slice(0, 3).map((r) => ({
            game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
            selection: r.selection || r.participant,
            market: r.screenMarket || r.market,
            clvPct: r.clvProxyPct,
            direction: r.clvProxyPct > 0 ? 'supportive' : 'adverse'
          }))
        });
      }

      // New TIER 1 / TIER 2 plays
      const newPlays = rows.filter((r) => {
        if (!lastCheckedMs) return false;
        const rowTime = r.freshnessMs || 0;
        return rowTime > lastCheckedMs && (r.confidenceTier === 'TIER 1' || r.confidenceTier === 'TIER 2');
      });
      if (newPlays.length) {
        alerts.push({
          type: 'new_play',
          league,
          count: newPlays.length,
          examples: newPlays.slice(0, 5).map((r) => ({
            game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
            selection: r.selection || r.participant,
            tier: r.confidenceTier,
            edge: r.consensusEdge,
            clv: r.clvProxyPct
          }))
        });
      }
    } catch (err) {
      errors.push({ league, error: err?.message || String(err) });
    }
  }

  // Update checkpoint
  const updatedLeagues = {};
  for (const league of leagues) {
    updatedLeagues[league] = now;
  }
  writeCheckpoint({ lastCheckedAt: now, leagues: { ...checkpoint.leagues, ...updatedLeagues } });

  return {
    ok: true,
    totalAlerts: alerts.length,
    alerts,
    leaguesChecked: leagues,
    lastCheckedAt: now,
    ...(errors.length > 0 ? { errors } : {})
  };
}

async function runCompositeStakingPlan(ctx, args = {}) {
  const bankroll = Number.isFinite(Number(args.bankroll)) ? Number(args.bankroll) : 1000;
  const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : undefined;
  const markets =
    Array.isArray(args.markets) && args.markets.length ? args.markets : args.market ? [args.market] : undefined;
  const targetTiers =
    Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'];
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
  const recResult = await ctx.handlers.quick_screen({
    leagues,
    markets,
    targetTiers,
    limit,
    is_live: false,
    includeResearch: false,
    compact: Boolean(args.compact),
    fields: Array.isArray(args.fields) ? args.fields : undefined,
    include: Array.isArray(args.include) ? args.include : undefined,
    skipHistory: args.skipHistory === true
  });
  if (!recResult.ok || !recResult.totalCandidates) {
    return {
      ok: true,
      bankroll,
      totalStake: 0,
      playCount: 0,
      stakes: [],
      remainingBankroll: bankroll,
      warnings: ['No recommended plays found for the given criteria'],
      summary: 'No plays to stake'
    };
  }
  const allPlays = [];
  for (const league of recResult.leagues || []) {
    for (const play of league.plays || []) {
      allPlays.push({ ...play, league: league.league });
    }
  }
  const plan = suggestStakes({ bankroll, plays: allPlays });
  return {
    ...plan,
    bankroll,
    leagueBreakdown: recResult.leagues.map((l) => ({ league: l.league, count: l.count })),
    totalRecommended: recResult.totalRecommended,
    markets_queried: recResult.markets_queried,
    markets_alias_used: recResult.markets_alias_used
  };
}

function createCompositesHandlers(client, ctx) {
  return {
    ask: (args = {}) => runCompositeAsk(ctx, args),

    get_started: (args = {}) => runCompositeGetStarted(ctx, args),

    place_bet: (args = {}) => runCompositePlaceBet(ctx, args),

    today: (args = {}) => runCompositeToday(ctx, args),

    get_alerts: (args = {}) => runCompositeGetAlerts(ctx, args),

    staking_plan: (args = {}) => runCompositeStakingPlan(ctx, args),

    smart_bet: (args = {}) => runSmartBet(ctx, args)
  };
}

module.exports = { createCompositesHandlers };
