---
name: ssb-for-agents
description: 'SSB MCP: sports betting analysis for AI agents. Screens 39 books, ranks by sharp movement, validates with multi-window consensus. Multi-market (ML/Spread/Total), market aliasing, consensus strength scoring.'
version: 1.4.0
author: James Drake
tags: [sports-betting, mcp, odds-analysis, sharp-movement]
---

# SSB MCP — Agent Skill

## What It Does

SSB is an odds analysis engine for AI agents. It screens 39 sportsbooks, ranks plays by sharp-book consensus and multi-window line movement, enriches candidates with player-context research (news + tweets), and outputs tiered recommendations with Kelly-based staking. Supported leagues: NBA, MLB, NHL, WNBA, Tennis, UFC, Soccer, NCAAB, NCAAF, NFL.

## Mandatory Operating Rules

- SSB is manual-only. Call tools only on demand; never create cron jobs, scheduled workflows, polling loops, watchdogs, or background live scans. Public-only settlement or schedule refresh must not call SSB.
- Fail closed on incomplete evidence. Do not recommend rows that are unvalidated, skipped, unresolved, or history-degraded. Treat `lookupStatus: "lookup_failed"`, `validatedUnverified: true`, `status: "unresolved"`, `incomplete: true`, `movementDisposition: "unavailable"`, and missing line-history evidence as stale/unverified—not as a negative signal and not as a bet.
- Use standard main lines. Alternate spreads/totals and expanded Game Handicap lines are non-actionable; honor `altLineFiltered` and TIER 4/PASS. The requested execution book needs a playable price, not necessarily the best price.
- For NCAAF NoVig scans, use the local `today` window and scan Moneyline, Point Spread, and Total Points. The CLI uses bounded per-market recovery (80 rows per market, 700-row shortlist ceiling) to keep all-market scans inside the request deadline. A broad scan can still summarize unhydrated alternate rows; only exact rows with `matchedRows: 1`, `isLive: false`, a current NoVig quote, and usable movement history are actionable.
- During quick-screen validation, keep the named execution book first in `books`; comparison books can follow it for consensus context but must not become the requested execution identity.
- Preserve frontend Tennis tournament scope with exact `leagueName` when supplied. For Soccer, named frontend competitions such as EPL, La Liga, Serie A, Bundesliga, and Ligue 1 are `leagueName` filters over backend league `Soccer`; pass the generic backend league plus the exact competition scope. Tennis defaults are Moneyline / Total Games / Set Handicap; Game Handicap is explicit-only.
- For repository changes, run focused deterministic tests, `npm run install:verify`, `npm run lint`, `npm run check:types`, and relevant checker/format checks. Keep changes task-scoped, never run live SSB requests as tests, and use a conventional commit with the required co-author trailer only after verification.

## Quick Start

Pick the workflow that matches the user's sophistication.

### Casual bettor

```
get_started
  → quick_screen(books=[X], kaiCall=["BET"], sortBy="start", verbosity="minimal")
  → player_context(player=...)   # only if riskScore ≥ 7
```

Keep output to 2-3 sentences. Lead with the pick and odds. The `kaiCall` filter drops CONSIDER/PASS rows so the user only sees strong plays. `sortBy="start"` orders by game time (soonest first).

### Intermediate bettor

```
get_started
  → quick_screen(books=[X], kaiCall=["BET","CONSIDER"], sortBy="start", verbosity="standard")
  → player_context(player=...)   # for every TIER 1-2 candidate
  → find_best_price(league, market, game, selection)
```

Explain edge, movement grade, and where to shop the line. The two-tier filter drops PASS but keeps CONSIDER for users who want to see what sharp money is leaning toward.

### Sharp bettor

```
get_started
  → quick_screen(books=[X], kaiCall=["BET"], sortBy="riskScore", verbosity="full")
  → sharp_consensus(league, market, windows=[1,2,6,12,24,48])
  → quick_screen({ leagues=[...], targetBooks=[...], mode: "sharp", kaiCall=["BET"], sortBy="edge", sortDir="desc" })
  → staking_plan(bankroll=N, leagues=[...])
```

Surface line-history detail, per-window consensus counts, and Kelly fractions. `sortBy="riskScore"` (default asc) orders by cleanest signal first. `sortBy="edge"` with `sortDir="desc"` ranks by largest consensus edge.

## Quick Recipes

**Today's plays on a specific book, soonest first (most common):**

```
quick_screen(books=["NoVigApp"], kaiCall=["BET"], sortBy="start", verbosity="minimal")
```

**Only the strongest, soonest games (TIGHTEST list):**

```
quick_screen(books=["Fliff"], kaiCall=["BET"], targetTiers=["TIER 1", "TIER 2"], sortBy="start", limit=10, verbosity="standard")
```

**Largest edge across all books, no PASS rows:**

```
quick_screen(kaiCall=["BET","CONSIDER"], sortBy="edge", sortDir="desc", verbosity="standard")
```

**Lowest-risk plays on a single book:**

```
quick_screen(books=["NovigApp"], kaiCall=["BET"], sortBy="riskScore", verbosity="standard")
```

**Validate one play before betting (drill-down):**

```
validate_play(league="NBA", gameId="...", selection="...", book="Fliff")
```

## Key Concepts

**Tier System (TIER 1–4)**
Confidence bucket combining edge, movement, and consensus. TIER 1 = lock-grade, TIER 2 = strong, TIER 3 = speculative, TIER 4 = pass. Never recommend TIER 4 as a bet.

**KaiCall (BET | CONSIDER | PASS)**
Layered action label derived from tier + risk + edge. BET = place it, CONSIDER = strong but monitor, PASS = skip. Use `kaiCall: ["BET"]` on any screen tool to filter out CONSIDER/PASS rows.

**`sortBy` Field**
Available on every screen-family tool. Accepts `start` (game time), `edge` (consensus edge), `tier` (TIER 1 first), `consensusBookCount` (most books first), `riskScore` (lowest first). Each has a sensible default direction. Missing-field rows always go to the end.

**Risk Score (1–10)**
Player/injury/news risk from `player_context`. 1-3 = clean, 4-6 = monitor, 7-10 = downgrade or skip. Always surface scores ≥ 7.

**Movement Grade (green / yellow / red)**
Qualitative movement quality band. Green = all sharp books aligned (supportive, high quality, strong consensus, positive CLV). Yellow = some signals positive but not all. Red = adverse movement / bad execution / thin consensus. Green + TIER 1-2 is the sweet spot.

**Multi-Market Defaults**

`quick_screen` and `staking_plan` scan Moneyline, Spread, and Total by default. Pass `markets: ["Spread"]` to narrow. Market names are auto-aliased per league (e.g. "Total" → "Total Goals" for NHL, "Run Line" for MLB).

**Consensus Strength**

Each ranked row includes `consensusStrength`: `strong` (3+ books agree), `moderate` (2), `weak` (1), `none` (0). Use this to calibrate confidence — strong consensus + green movement = best signal.

**Verbosity Levels**

- `minimal` — essentials only (game, selection, odds, tier). For casual users.
- `standard` — adds edge, movement grade, kai call. Default.
- `full` — includes line history, score breakdown, full odds maps. For sharp users and debugging.

**Token Persistence**

Auth tokens are cached to `~/.ssb-for-agents/token-cache.json`. Reduces login frequency. If tools return auth errors, tell user to run `pp-query login`.

## Common Pitfalls

- **Don't bet TIER 4.** It's a pass. Recommending it erodes trust.
- **Always check `player_context` before TIER 1-2 plays.** A high risk flag (injury, trade, scratch rumor) can invalidate an otherwise clean screen.
- **Don't over-explain to casual bettors.** They want the pick and the odds, not a dissertation on Pinnacle closing-line value.
- **Auth expiry → tell the user to run `pp-query login`.** You cannot refresh tokens yourself. When tools return 401/auth errors, surface this immediately.
- **`ev_candidates` returning 0 rows is normal on quiet days.** It's not a bug — it means no +EV opportunities pass the threshold. Don't retry or apologize; explain and move on.
- **`compact=true` strips line history.** If the user later asks "why did this move?", you'll need to re-query with `compact=false` or call `get_play_details` with the game IDs.

## Resources

- [`AGENT_PROMPT.md`](./AGENT_PROMPT.md) — full agent prompt with tool-by-tool guidance
- [`README.md#Quick Start`](../README.md#quick-start) — setup, install, auth, MCP client configs
- [`MARKET-BOOK-AVAILABILITY.md`](./MARKET-BOOK-AVAILABILITY.md) — which books post which markets
- [`CHANGELOG.md`](../CHANGELOG.md) — version history

## Tool Reference

Full descriptions for each MCP tool. The schema descriptions are shortened for token efficiency; this section preserves the complete guidance.

### Screen Tools

**quick_screen**
The fastest way to find playable bets on ANY book in one call. Specifies a target book (or books), scans all leagues × markets for sharp plays with independent consensus confirmation, runs player context research on candidates, and returns ranked results with risk flags. The target book price does not need to be the best — just playable (not "bad" execution quality). Generic market names (e.g. "Total", "Spread") are auto-resolved per league. League-specific defaults: Soccer → Draw No Bet / Match Handicap / Total Goals (NOT Moneyline/Spread/Total). Tennis → Moneyline / Total Games / Set Handicap (Game Handicap remains explicit-only). UFC → Moneyline / Method of Victory. NFL → Spread / Total / Moneyline. Each candidate includes `movementDisposition` (supportive_clean/supportive_bouncy/adverse_recent/adverse_full/insufficient) and `displayTier` (BET/CONSIDER/PASS) — read these instead of cross-referencing grade + direction + label. `odds`/`targetBookOdds` are the current execution quote from the on-demand screen lookup. `lastPointAgeMs` and `movementHistoryAgeMs` describe movement-history evidence only, not quote age; keep them out of normal betting prose. The response also includes `activeSlate` (which leagues/markets have games) and `warnings` (e.g. stale data alerts). The `staleMovementWarning` field flags candidates where the condensed scan shows adverse movement but strong fundamentals (TIER 1-2, >=10 consensus books) — the movement snapshot may be stale; call validate_play for the full verdict. Equivalent to sharp_plays + player_context bundled. Use when asked "show me the best plays on [book]" or "what's good on Fliff tonight". Defaults to NoVigApp if no book specified. Use `targetTiers: ["TIER 1"]` to get only top-tier plays (or `["TIER 1", "TIER 2"]` for recommendations). Combine with `kaiCall: ["BET"]` for BET-only top-tier plays. Use `sortBy: "start"` to order by game time (soonest first). `sortBy` also accepts "edge" (largest first), "tier" (TIER 1 first), "consensusBookCount" (most books first), "riskScore" (lowest first). Missing-field rows always sort to the end.

**screen_ranked**
Query /screen and return hydrated ranked rows with consensus, movement, and freshness metadata for any market. This is the primary tool for getting tiered, ranked plays. Generic market names like Total or Spread are auto-resolved per league — e.g. NHL Total becomes Total Goals, MLB Spread becomes Run Line. League-specific defaults: Soccer → Draw No Bet / Match Handicap / Total Goals (NOT Moneyline/Spread/Total). Tennis → Moneyline / Total Games / Set Handicap (Game Handicap remains explicit-only). UFC → Moneyline / Method of Victory. NFL → Spread / Total / Moneyline. Each row includes `consensusStrength` (strong/moderate/weak/none). When aliases are resolved, `responseMeta.markets_alias_used` is set. Set compact=true to strip verbose payloads and return only essential fields per match — reduces response size by ~90%. NOTE: When you pass a single non-sharp book (e.g. NoVigApp), the tool auto-augments the query with the league's sharp book set (Pinnacle, BetOnline, Circa, etc.) so consensus and movement data populate. RELATED: `quick_screen` bundles screen_ranked + player_context in one call; use `quick_screen({ targetTiers: ['TIER 1', 'TIER 2'] })` for the filtered subset. Use `kaiCall: ["BET"]` to filter to strong plays, `sortBy: "start"` to order by game time.

**smart_bet**
One-call bet evaluation: given a player/team and book, returns the play details, validate_play verdict (movementDisposition, riskFlags, actionableSummary), best price across books, and staking recommendation. Equivalent to quick_screen + validate_play + find_best_price + staking_plan in one call. Use when the user asks "should I bet X on Y?" or wants a complete evaluation of a specific play.

**staking_plan**
Given a bankroll and optional play filter, return stake allocations across recommended bets. Uses fractional Kelly staking: TIER 1 = 2%, TIER 2 = 1% of bankroll. Generic market names (e.g. "Total", "Spread") are auto-resolved per league. Each play includes `consensusStrength` (strong/moderate/weak/none). When aliases are resolved, `responseMeta.markets_alias_used` is set. Includes total exposure, per-play stake dollars, and correlation warnings. Defaults to scanning Moneyline, Spread, and Total markets via `quick_screen`.

**ufc_card**
Query a UFC card and return a first-class shortlist response with official plays, best looks, passes, and summary metadata. Absolves the old per-league UFC shortcut.

### Validation Tools

**ev_candidates**
Query the sportsbook +EV endpoint and return candidate plays for enabled books. Secondary discovery only — use /screen for primary playable-bet selection. Set validated=true to run sharp-movement validation on candidates. Returns 0 rows on quiet days when no +EV opportunities exist — that is normal, not a bug.

**get_play_details**
Get full details (including line history, consensus, movement debug) for specific plays by game ID. Generic market names are auto-resolved per league. Each row includes `consensusStrength` (strong/moderate/weak/none). Use AFTER a `screen_ranked` or `quick_screen` call when you need the full raw payload for one or more specific gameIds — e.g. when `compact=true` or `fields=[]` hid the data you need. For confirming a play before betting, prefer `validate_play` (it bundles player_context + execution check). Returns full rows with all metadata. Use verbosity="minimal" for a plain-English summary string (no structured JSON), or verbosity="standard" to strip verbose payloads (lineHistory, scoreBreakdown, oddsMap) and return only structured rows with essential fields.

**validate_play**
Run all validation checks on a specific play in one call: re-fetch the latest screen data for the game, run player_context for injury/news, check execution quality on the requested book, and return a single verdict (BET / CONSIDER / PASS) with all supporting evidence. Use this after a screen_ranked or quick_screen result to confirm a specific play before placing the bet. Pass `playId` from quick_screen for exact matching — avoids selection-string comparison ambiguity. Equivalent to running get_play_details + player_context + a quick consensus check, but bundled so the agent doesn't have to chain three calls.

**find_best_price**
Line shopping: show every book's odds sorted best to worst with spread from best price. Generic market names like Total or Spread are auto-resolved per league — e.g. NHL Total becomes Total Goals, MLB Spread becomes Run Line.

### Context Tools

**player_context**
Get recent news, tweets, and a computed risk flag for a player. Returns up to 30 recent tweets mentioning the player from X plus a Google News RSS layer (with ESPN as tertiary fallback). Each item is scored 0-100 for source authority. USE THIS BEFORE PLACING A BET: if riskFlag === "high", downgrade or skip the play.

**mlb_game_context**
Get game-level context for an MLB game: starting pitchers (probable → confirmed), venue + park factor, hourly weather (wind speed/direction, temperature, precip probability) at first pitch, and lineup lock status. Returns a riskFlag of clean|low|medium|high for weather/park effects. Use BEFORE placing an MLB bet when the screen does not surface this. Automatically called by validate_play for league="MLB".

**sharp_consensus**
Analyze line history across multiple time windows (1h, 2h, 6h, 12h, 24h, 48h) to detect sustained sharp book consensus movement. Returns plays ranked by how many windows show ALL sharp books moving supportive. Use when you want to understand WHY a play ranks, not just WHAT ranks — `quick_screen` gives you ranked plays faster; `sharp_consensus` gives you the multi-window movement evidence underneath the ranking. Returns all ranked rows by sustained agreement, including rows that did not survive the strict filter on sibling tools.

**all_slates**
Query multiple active leagues at once and return a consolidated ranked list. Best for daily discovery: one call instead of 5-6 separate league screens. Returns ALL ranked rows regardless of tier; use quick_screen with targetTiers: ['TIER 1','TIER 2'] for the filtered shortlist. Generic market names (e.g. "Total", "Spread") are auto-resolved per league. Each row includes `consensusStrength` (strong/moderate/weak/none). When aliases are resolved, `responseMeta.markets_alias_used` is set.

**get_alerts**
Check for new sharp line movements, steam moves, and significant odds changes since you last checked. Uses the multi-window sharp consensus engine to detect fresh movement signals across all requested leagues.

### Picks Tools

**log_pick**
Log a bet you placed before tip-off. Records game, league, market, selection, odds, stake, and optional metadata. Use this to track your personal betting performance and compare against the system recommendations.

**get_pick_history**
View your logged betting history. Filter by status (pending/won/lost/push/all), league, recency, and limit. Returns most recent first.

**resolve_pick**
Mark a logged pick as won, lost, or push after the game ends. Updates your personal betting record for accurate stats. Call ONCE PER PICK after the underlying game finishes, before fetching updated stats via `get_pick_stats`. Required: the pick UUID from `log_pick` or `get_pick_history`, plus the result enum (won / lost / push).

**get_pick_stats**
Get your personal betting performance stats: win rate, profit/loss, breakdowns by league and confidence tier. Helps you see what strategies are working. Call for a SESSION OR WEEKLY RECAP — pass `days` to scope the window (default is all-time). For ROW-LEVEL history with status/league filters, use `get_pick_history` instead.

**manage_hidden_bets**
Manage bet visibility for the /fantasy table. action='list' returns all hidden bets, 'hide' requires bet, 'unhide' requires id, 'clear' removes all.

**clear_score_timeline**
Clear the score timeline cache used for tier trajectory tracking. Resets all historical tier data. Use when starting a new session or after config changes.

### Meta Tools

**ask**
Parse a natural language betting query into structured components (league, book, market, side, line, player), execute the routed tool on demand, and return `_executed` plus the result. It never schedules or polls future calls. Routes to the right tool: book queries → quick_screen, player queries → player_context, validation queries ("should I bet X?") → validate_play, general → quick_screen.

**get_market_registry**
Returns the list of markets available for a sport on a specific book. Use this BEFORE calling quick_screen to know which markets to query. The response has two keys: `markets` (main-line markets, with per-book market name mappings where applicable) and `propMarkets` (exact player/pitcher prop market names for supported leagues). Soccer uses Draw No Bet / Match Handicap / Total Goals (not Moneyline / Spread / Total). Tennis uses Moneyline / Total Games / Set Handicap (not Spread / Total). On `scan`/`quick_screen`, passing `includeProps:true` merges `propMarkets` into the result, but this is manual-only — it increases backend fan-out and rate-limit risk, so only opt in when you actually need props. RECOMMENDED WORKFLOW: (1) get_market_registry → (2) quick_screen(leagues, markets=[...]) → (3) validate_play on top candidates → (4) log_pick.

**get_started**
Get the recommended workflow based on use case. Call this first to understand which tools to use for quick situational checks, deeper signal analysis, or full raw data research. The "casual"/"intermediate"/"sharp" labels are about _data depth_, not about betting style — every level surfaces the same underlying signal feed, just with more or less aggregation.

**league_presets**
Show the current sport-specific ranking presets — which books count as sharp per league, the default market bundles, and the preferred execution book. Call BEFORE `screen_ranked`, `quick_screen`, or `validate_play` when you want to know which books/markets will be weighted highest, or when debugging unexpected ranking behavior. No arguments needed; result is informational only.

**health_status**
Check auth freshness and endpoint connectivity. Reports token persistence state: `persistedToDisk` (boolean), `refreshCount` (number of refreshes since startup), and `lastRefreshed` (ISO timestamp). Call FIRST THING on session boot to confirm the MCP server can reach the PropProfessor backend. If `persistedToDisk=false` or `lastRefreshed` is over 1 hour ago, expect auth failures on subsequent tool calls — surface `pp-query login` to the user. No arguments needed.

**fantasy_optimizer**
Query the Fantasy Optimizer for DFS-style player picks across fantasy apps (PrizePicks, Underdog, etc.). Returns fantasy plays with projected values, odds, and risk metrics. Requires a paid PropProfessor subscription with Fantasy Optimizer access.
