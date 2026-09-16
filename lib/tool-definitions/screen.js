'use strict';

const { DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS } = require('../ssb-mcp-ranked-screen');

const VERBOSITY_PARAM = {
  type: 'string',
  enum: ['minimal', 'standard', 'full', 'bets'],
  description:
    'Output detail level. minimal: returns {summary: string, count: number, type: "plays"|"no_plays"} — a plain-English summary wrapped in a parseable JSON envelope. standard: structured rows with edge/tier/risk + brief rationale. full: all movement data, line history, debug payloads. Default: standard.'
};

/**
 * Filter the response by signal-quality tier (BET | CONSIDER | PASS).
 * Use `kaiCall: ["BET"]` to get only strong plays. Default: no filter
 * (return all rows). Missing/garbage kaiCall values are treated as PASS.
 */
const KAI_CALL_FILTER_PARAM = {
  type: 'array',
  items: { type: 'string', enum: ['BET', 'CONSIDER', 'PASS'] },
  description:
    'Optional filter by display tier (BET | CONSIDER | PASS). Default: no filter. Example: ["BET"] for "bets only" or ["BET", "CONSIDER"] to drop PASS rows. Missing/garbage kaiCall is treated as PASS.'
};

/**
 * Sort the response by a single field. Each field has a sensible default
 * direction; override with sortDir. Missing-field rows always land at the
 * end regardless of direction.
 */
const SORT_BY_PARAM = {
  type: 'string',
  enum: ['start', 'edge', 'tier', 'consensusBookCount', 'riskScore'],
  description:
    'Optional sort key. start = game time ascending (soonest first). edge = consensus edge descending (largest first). tier = TIER 1 first. consensusBookCount = most books first. riskScore = lowest risk first. Default: server-defined order (tier then edge). Missing-field rows always go to the end.'
};

const SORT_DIR_PARAM = {
  type: 'string',
  enum: ['asc', 'desc'],
  description: 'Optional sort direction. Overrides the per-field default. asc = ascending, desc = descending.'
};

const MIN_EV_PARAM = {
  type: 'number',
  description:
    'Optional minimum consensus edge percentage. Filters to +EV plays only (e.g. minEV=1.0 keeps plays with 1%+ edge). Default: no filter.'
};

const MOVEMENT_FILTER_PARAM = {
  type: 'array',
  items: {
    type: 'string',
    enum: ['supportive_clean', 'supportive_bouncy', 'insufficient', 'adverse_recent', 'adverse_full']
  },
  description:
    'Optional filter by movement disposition. Example: ["supportive_clean", "supportive_bouncy"] to see only plays where the line is moving the right direction. Default: no filter (all movement types). Note: adverse_* values only ever match tennis-fallback rows — non-fallback rows are dropped from the candidate pool before this filter runs, so an adverse filter is not a way to list what the scan rejected. Use `rank <league> --all-markets -j` for the full adverse board.'
};

function buildScanTool() {
  return {
    name: 'scan',
    description:
      'SCAN — simplified one-call Positive EV-first scanner. Preferred entry point for AI agents. Uses the paid Positive EV board first, then screen fallback, with exact validation gates. Pass `sport` instead of `league` for ergonomics (e.g. sport="tennis").',
    inputSchema: {
      type: 'object',
      properties: {
        sport: {
          type: 'string',
          description: 'Sport to scan: tennis, nba, mlb, nfl, ufc, soccer, etc. Maps to league automatically.'
        },
        league: {
          type: 'string',
          description: 'League name directly (e.g. "Tennis"). Overrides sport if both provided.'
        },
        book: { type: 'string', description: 'Execution book. Default: NoVigApp.' },
        market: { type: 'string', description: 'Market to scan. Default: all markets for the sport.' },
        markets: { type: 'array', items: { type: 'string' }, description: 'Multiple markets (overrides market).' },
        includeProps: {
          type: 'boolean',
          description:
            'When true, merge player prop markets (Player Points, Player Strikeouts, etc.) into the scan per league. Off by default because prop scans multiply the HTTP fan-out (each player x line) and hit backend rate limits faster. Manual use only — never schedule prop scans.'
        },
        minEdge: { type: 'number', description: 'Minimum edge % to include. Default: 0 (all).' },
        cardWindow: { type: 'string', enum: ['today', 'next', 'all'], description: 'Date filter. Default: today.' },
        verbosity: {
          type: 'string',
          enum: ['minimal', 'bets', 'standard', 'full'],
          description: 'Output detail. Default: bets.'
        },
        limit: { type: 'number', description: 'Max total results. Default: 25.' },
        kaiCall: KAI_CALL_FILTER_PARAM,
        movement: MOVEMENT_FILTER_PARAM
      }
    }
  };
}

function buildQuickScreenTailProperties() {
  return {
    topPick: {
      type: 'boolean',
      description:
        'When true, return only the single highest-conviction BET-tier play with a "why" rationale string. Use for one-call all-in betting.'
    },
    lite: {
      type: 'boolean',
      description:
        'Token-light mode: returns only essential act fields (game, selection, odds, edge, clv, tier, kaiCall, startCST, movementDisposition, riskFlag). Avoids 200KB payloads. Implies compact.'
    },
    cardWindow: {
      type: 'string',
      enum: ['today', 'next', 'all'],
      default: 'today',
      description:
        "Card window filter. 'today' returns today's slate plus any next-day matches merged in (flagged via nextDayMerged in the response). 'next' returns only tomorrow. 'all' returns every upcoming match with no date filtering. Default 'today'."
    },
    maxPlaysPerGame: {
      type: 'number',
      minimum: 1,
      maximum: 50,
      default: 2,
      description:
        'Max plays shown per game in minimal verbosity (highest screenScore first). Default 2 to keep output scannable. Raise it (e.g. 10) when you want full coverage of a game without a second call. Standard verbosity always returns every candidate regardless of this value.'
    },
    parseable: {
      type: 'boolean',
      default: true,
      description:
        'When true (default), minimal verbosity includes a structured `plays` array alongside the summary string. Set to false for summary-only output.'
    },
    mode: {
      type: 'string',
      enum: ['recommended', 'sharp', 'tonight'],
      description:
        'Preset bundle that mirrors a retired standalone tool. Omit for the default broad screen. ' +
        "'recommended' = curated top-tier discovery across TIER 1 & TIER 2 (targetTiers default ['TIER 1','TIER 2'], validate:true) — the old recommended_bets behavior. " +
        "'sharp' = route to the multi-sharp-book-confirmed screening path (the old sharp_plays handler). " +
        "'tonight' = quick_screen with kaiCall:['BET','CONSIDER'], sortBy:'start', sortDir:'asc', includeResearch:true, limit default 5 — the old tonight_bets one-call bundle. " +
        'Any explicit arg always overrides the preset default.'
    }
  };
}

function buildQuickScreenTool() {
  return {
    name: 'quick_screen',
    description:
      'SCAN — one-call sharp-play scanner across leagues × markets. Returns ranked results with tiers, edge, movement, and validation. Current odds/targetBookOdds come from the on-demand screen lookup and are the execution quote. Movement-history age is separate diagnostic metadata; it is not quote age and should not be surfaced as a reason to manually check the app. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with books=["Fliff"].',
      properties: {
        books: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Target execution books, e.g. ["Fliff", "NovigApp"]. Defaults to ["NoVigApp"]. Use a single book for focused results or multiple books for comparisons.'
        },
        book: { type: 'string', description: 'Single target book shortcut (alias for books: ["BookName"])' },
        leagues: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Leagues to scan, e.g. ["MLB", "NBA"]. Defaults to every league the SSB backend supports: NBA, MLB, NFL, NHL, WNBA, NCAAB, NCAAF, Soccer, Tennis, UFC, NBASL.'
        },
        league: { type: 'string', description: 'Single league shortcut' },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Markets to scan, default ["Moneyline", "Spread", "Total"]. Overrides `market` if provided.'
        },
        market: { type: 'string', description: 'Single market shortcut, default "Moneyline"' },
        includeProps: {
          type: 'boolean',
          description:
            'When true, merge player prop markets (Player Points, Player Strikeouts, etc.) into the scan per league. Off by default because prop scans multiply the HTTP fan-out (each player x line) and hit backend rate limits faster. Manual use only — never schedule prop scans.'
        },
        limit: {
          type: 'number',
          description:
            'Total max candidates across all leagues/markets, default 100. Use maxPerMarket for per-market caps.'
        },
        maxPerMarket: {
          type: 'integer',
          description:
            'Optional per-league×market cap applied before the total limit. E.g. maxPerMarket=2 returns at most 2 plays per league/market pair.'
        },
        scanLimit: { type: 'number', description: 'Rows to scan per league/market before filtering, default 100' },
        lookbackHours: { type: 'number', description: 'Odds-history lookback window in hours, default 6' },
        targetTiers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tier filter, e.g. ["TIER 1"] to get only locks, or ["TIER 1", "TIER 2"] for recommendations. Defaults to no filter (return all tiers).'
        },

        includeResearch: {
          type: 'boolean',
          description: 'Run player_context research on each bet candidate. Default true.'
        },
        debug: { type: 'boolean', description: 'Include verbose movement debug payloads, default false' },
        verbosity: VERBOSITY_PARAM,
        validateTop: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          default: 0,
          description:
            'When > 0, runs validate_play on the top N candidates per league/market before returning, merging verdictSummary and gameContext data into each row. Defaults to 0 (off) — the condensed scan already returns tiers, movement disposition, and research. Set to 3+ when you want deep validation with re-fetched consensus counts.'
        },
        researchLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 50,
          description:
            'Max final plays to run player_context research on. Research is scoped to the returned (post-filter) plays, so this bounds payload size on large scans. Defaults to 50.'
        },
        validate: {
          type: 'boolean',
          default: true,
          description:
            'When true (default), run validate_play on EVERY returned candidate before returning — merging validatedTier, validatedConsensusBookCount, validatedMovementDisposition, validatedRiskFlags, and validatedActionableSummary into each row. Eliminates the need for a separate validate_play call. Set to false for max-speed scans. When false, validateTop can still cap validation to the top N per league/market.'
        },
        onlyBets: {
          type: 'boolean',
          default: false,
          description:
            'When true, return only candidates with finalVerdict === "BET" and finalConfidenceTier at or above minFinalTier. One-call "show me the bets". Use with targetTiers to narrow further (e.g. onlyBets:true + targetTiers:["TIER 1"] for locks-only). Requires validate (default on).'
        },
        minFinalTier: {
          type: 'string',
          enum: ['TIER 1', 'TIER 2', 'TIER 3'],
          default: 'TIER 1',
          description: 'Floor tier for the onlyBets gate. Default TIER 1.'
        },
        kaiCall: KAI_CALL_FILTER_PARAM,
        movement: MOVEMENT_FILTER_PARAM,
        minEV: MIN_EV_PARAM,
        sortBy: SORT_BY_PARAM,
        sortDir: SORT_DIR_PARAM,
        evFirst: {
          type: 'boolean',
          default: true,
          description:
            'Use the Positive EV board as the primary discovery source. Set false to use the odds screen only.'
        },
        ...buildQuickScreenTailProperties()
      },
      additionalProperties: false
    }
  };
}

function buildScreenRankedTool() {
  return {
    name: 'screen_ranked',
    description:
      'Query /screen and return hydrated ranked rows with consensus, movement, and freshness metadata. Auto-resolves league-specific market names. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with league="NBA", market="Moneyline".',
      properties: {
        market: { type: 'string', description: 'Odds screen market, for example Moneyline or Player Points' },
        league: { type: 'string', description: 'League such as NBA' },
        leagueName: {
          type: 'string',
          description: 'Optional competition or tournament name filter, for example US Open for Tennis'
        },
        games: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional game ids or identifiers to filter the query'
        },
        participants: { type: 'array', items: { type: 'string' }, description: 'Optional participant filters' },
        limit: { type: 'number', description: 'Max number of ranked rows to return' },
        books: { type: 'array', items: { type: 'string' }, description: 'Optional comparison books override' },
        historySportsbooks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional sportsbooks to fetch odds history for (overrides books for history enrichment only)'
        },
        includeAll: { type: 'boolean', description: 'Include rows even when consensus or movement data is missing' },
        maxAgeMs: { type: 'number', description: 'Treat rows older than this many milliseconds as stale' },
        lookbackHours: {
          type: 'number',
          description: `Odds-history lookback window in hours, default ${DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS}`
        },
        debug: {
          type: 'boolean',
          description:
            'Include verbose movement debug payloads such as filtered line history and dropped-point reasons, default false'
        },
        compact: {
          type: 'boolean',
          description:
            'When true, strip verbose payloads (lineHistory, scoreBreakdown, full odds maps) and return only essential fields per match. Reduces response size by ~90%. Default false. Does NOT affect history hydration — movement data is always fetched.'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of field names to return per row. Overrides compact when both are set. Example: ["game","selection","odds","edge","tier","kai"]'
        },
        skipHistory: {
          type: 'boolean',
          description:
            'When true, skip odds history hydration entirely. Use this to speed up screen calls when you only need current odds/edges and do not need movement data. Default false.'
        },
        includeResearch: {
          type: 'boolean',
          description:
            'Run player_context research on each recommended play and attach riskFlag, riskSummary, and topTweet to the result. Use this to validate plays before placing a bet. Default true (research runs unless you pass includeResearch:false). Caches aggressively in player_context (30-min TTL, 5-min for high-risk).'
        },
        riskDowngrade: {
          type: 'boolean',
          description:
            'When true AND includeResearch=true, plays with riskFlag="high" are removed from the recommendation. Without this, risk flags are just annotations and the plays stay. Default false.'
        },
        playableOnly: {
          type: 'boolean',
          description:
            'When true, keep rows where the user-requested book is within the normal market range (executionQuality != "bad") even when consensusEdge is negative or zero. Use this when you want to find plays on a specific book (e.g. Fliff) at executable prices, not just positive-EV opportunities. Rows where the requested book is wildly off-market are still dropped. Default false.'
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of top-level response sections to include. Values: "freshness", "warnings", "resultMeta", "league". Example: ["resultMeta"] to get only ok+result+resultMeta. Default: all sections.'
        },
        verbosity: VERBOSITY_PARAM,
        kaiCall: KAI_CALL_FILTER_PARAM,
        movement: MOVEMENT_FILTER_PARAM,
        minEV: MIN_EV_PARAM,
        sortBy: SORT_BY_PARAM,
        sortDir: SORT_DIR_PARAM
      },
      required: ['league'],
      additionalProperties: false
    }
  };
}

function buildSmartBetTool() {
  return {
    name: 'smart_bet',
    description:
      'ONE-CALL — evaluate a selection on a book. Returns play details, validation verdict, best price, and staking. For bulk scanning, use quick_screen. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with selection="Tatum", book="Fliff", league="NBA".',
      properties: {
        selection: { type: 'string', description: 'Player or team name. Required.' },
        book: { type: 'string', description: 'Target execution book (e.g. "Fliff", "NoVigApp"). Required.' },
        league: { type: 'string', description: 'League (e.g. "NBA", "MLB"). Helps narrow the search.' },
        market: { type: 'string', description: 'Market type, default "Moneyline".' },
        bankroll: { type: 'number', description: 'Bankroll in dollars for staking recommendation. Default 1000.' },
        verbosity: VERBOSITY_PARAM
      },
      required: ['selection', 'book'],
      additionalProperties: false
    }
  };
}

function buildStakingPlanTool() {
  return {
    name: 'staking_plan',
    description:
      'Given a bankroll, return stake allocations across recommended bets using fractional Kelly staking. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with bankroll=1000.',
      properties: {
        bankroll: { type: 'number', description: 'Total bankroll in dollars, default 1000' },
        leagues: {
          type: 'array',
          items: { type: 'string' },
          description: 'League filter, e.g. ["NBA", "MLB"]. Defaults to all supported leagues.'
        },
        limit: { type: 'number', description: 'Max plays per league, default 10' },
        market: {
          type: 'string',
          description:
            'Market type, default "Moneyline". Deprecated — prefer the canonical "markets" (plural array) param for multi-market scans. Still accepted for backward compatibility; the handler maps a single market to a one-element array internally.'
        },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Market types to scan. Default: ["Moneyline", "Spread", "Total"]. Overrides `market` if provided.'
        },
        targetTiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tier filter, defaults to ["TIER 1", "TIER 2"]'
        },
        compact: {
          type: 'boolean',
          description:
            'When true, strip verbose payloads (lineHistory, scoreBreakdown, full odds maps) and return only essential fields per match. Reduces response size by ~90%. Default false. Does NOT affect history hydration — movement data is always fetched.'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of field names to return per row. Overrides compact when both are set. Example: ["game","selection","odds","edge","tier","kai"]'
        },
        skipHistory: {
          type: 'boolean',
          description:
            'When true, skip odds history hydration entirely. Use this to speed up screen calls when you only need current odds/edges and do not need movement data. Default false.'
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of top-level response sections to include. Values: "freshness", "warnings", "resultMeta", "league". Example: ["resultMeta"] to get only ok+result+resultMeta. Default: all sections.'
        },
        verbosity: VERBOSITY_PARAM
      },
      required: ['bankroll'],
      additionalProperties: false
    }
  };
}

function buildUfcCardTool() {
  return {
    name: 'ufc_card',
    description:
      'Query a UFC card and return a shortlist with official plays, best looks, passes, and summary metadata. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with book="NoVigApp", market="Moneyline".',
      properties: {
        book: { type: 'string', description: 'Primary execution book for the UFC card query' },
        cardWindow: { type: 'string', description: 'Card window filter such as today, next, or all' },
        debug: { type: 'boolean', description: 'Include verbose movement debug payloads' },
        eventDate: { type: 'string', description: 'Restrict the shortlist to a specific card event date' },
        includePasses: { type: 'boolean', description: 'Include pass rows in the shortlist response' },
        limit: { type: 'number', description: 'Max shortlist rows to return per bucket' },
        market: { type: 'string', description: 'Primary UFC market filter' },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional UFC market bundle, with the first value used for ranked scanning'
        },
        maxHoursAway: { type: 'number', description: 'Maximum hours until start' },
        scanLimit: { type: 'number', description: 'Per league/market ranked rows to scan before shortlisting' },
        strict: { type: 'boolean', description: 'Whether to return only bet candidates from the shortlist' },
        targetBook: { type: 'string', description: 'Alias for book' },
        upcomingOnly: { type: 'boolean', description: 'Restrict results to upcoming UFC fights only' },
        verbosity: VERBOSITY_PARAM
      },
      additionalProperties: false
    }
  };
}

function buildSharpAlertsTool() {
  return {
    name: 'sharp_alerts',
    description:
      'ALERTS — only verified BET-tier plays, deduped so same plays arent re-alerted. Call when you want fresh sharp plays. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
    inputSchema: {
      type: 'object',
      usage_example: 'Call with books=["NoVigApp"], minFinalTier="TIER 1".',
      properties: {
        books: { type: 'array', items: { type: 'string' }, description: 'Target books. Default ["NoVigApp"].' },
        book: { type: 'string', description: 'Single book shortcut (alias for books:["BookName"]).' },
        leagues: { type: 'array', items: { type: 'string' }, description: 'Leagues to scan. Default all.' },
        league: { type: 'string', description: 'Single league shortcut.' },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Markets. Default ["Moneyline","Spread","Total"].'
        },
        market: { type: 'string', description: 'Single market shortcut.' },
        minFinalTier: {
          type: 'string',
          enum: ['TIER 1', 'TIER 2'],
          default: 'TIER 1',
          description: 'Floor tier for returned plays. Default TIER 1.'
        },
        sinceMinutes: {
          type: 'number',
          default: 2880,
          description: 'Only alert plays whose game starts within this many minutes (default 48h).'
        },
        storePath: {
          type: 'string',
          description: 'Dedup store path. Default ~/.ssb-for-agents/sharp-alerts-store.json.'
        },
        dedupWindowMinutes: {
          type: 'number',
          default: 360,
          description: 'Repeat window: same play alerted again only after this many minutes (default 6h).'
        }
      },
      additionalProperties: false
    }
  };
}

// @ts-expect-error
/** @returns {import('./types').ToolDefinition[]} */
function buildScreenTools() {
  return [
    buildScanTool(),
    buildQuickScreenTool(),
    buildScreenRankedTool(),
    buildSmartBetTool(),
    buildStakingPlanTool(),
    buildUfcCardTool(),
    buildSharpAlertsTool()
  ];
}

module.exports = { buildScreenTools, VERBOSITY_PARAM };
