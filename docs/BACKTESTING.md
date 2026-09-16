# Backtesting the Tier System

This document explains how to validate that the SSB confidence tier
system (TIER 1 – TIER 4) actually predicts outcomes.

## Purpose

The tier system ranks plays by confidence:

| Tier   | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| TIER 1 | Green movement grade + low risk score (≤ 2). Strongest play. |
| TIER 2 | Green grade + moderate risk, or low risk without green.      |
| TIER 3 | Moderate risk score (3–7), no red flags.                     |
| TIER 4 | Red movement grade or PASS kai call. Avoid.                  |

The backtest script checks whether TIER 1 plays actually hit more often than
TIER 4 plays. If they don't, the tier methodology needs revision.

## Running the script

```bash
node scripts/backtest.js [league] [market] [days]
```

### Arguments

| Argument | Default     | Description                          |
| -------- | ----------- | ------------------------------------ |
| league   | `MLB`       | League name (e.g. `NBA`, `Tennis`)   |
| market   | `Moneyline` | Market type (e.g. `Spread`, `Total`) |
| days     | `30`        | Lookback window in days              |

### Examples

```bash
# Default: MLB Moneyline, last 30 days
node scripts/backtest.js

# NBA Moneyline, last 7 days
node scripts/backtest.js NBA Moneyline 7

# Tennis, all markets
node scripts/backtest.js Tennis Moneyline 14
```

## Understanding the output

```text
Backtesting MLB Moneyline for the last 30 days... (ILLUSTRATIVE — synthetic output)

Tier		Total	Wins	Losses	Push	Hit Rate
----		-----	----	------	----	--------
TIER 1		12	8	3	1	72.7%
TIER 2		24	14	9	1	60.9%
TIER 3		18	7	10	1	41.2%
TIER 4		6	1	5	0	16.7%

✓ Backtest complete.
```

> The table above is an **illustrative sample of the output format**, not a
> real result. It does not come from settled bets and says nothing about
> profitability. The `/screen` endpoint returns live odds, not resolved
> outcomes, so the metric fields (Wins / Losses / Hit Rate here) are only
> populated when you supply a resolved snapshot yourself — see
> "Scoring real outcomes" below.

## Limitations

### The screen endpoint returns current odds, not historical results

The SSB `/screen` endpoint is designed for live odds screening. It
does not expose a "settled bets" feed. When the script finds no resolved bets,
it exits with `reason: no_historical_data`.

This is expected behavior — the API is not a historical database.

### Workarounds

1. **Run periodically and persist snapshots.** Use `scripts/export-ranked-screen.js`
   to save daily snapshots, then resolve outcomes against a separate results
   feed (e.g. a sports data API).

2. **Use the screen-history module.** The `ssb-screen-history` module
   can persist line history. Combine it with a results resolver to build a
   local backtest dataset.

3. **Manual tracking.** Run the script daily, log the TIER assignments, then
   check outcomes manually after games settle.

## What to look for (on your own resolved data)

These thresholds apply once you have **real resolved outcomes** from snapshots
you tracked — they are NOT statements about the tool's profitability:

- **TIER 1 hit rate > 60%**: Your tracked sample differentiates well. The signal is doing its job as a quality rating.
- **TIER 1 hit rate ≈ TIER 3**: Tier system isn't differentiating in your sample. Review risk-score weights.
- **TIER 4 hit rate > TIER 2**: Red flags are wrong in your sample. Revisit movement grading.

> Profitability is **UNPROVEN**. No settled-results backtest has been published
> yet (a results pipeline is being built separately). Treat any hit-rate or
> ROI number as a candidate metric to validate yourself, not as proof of edge.

## Related files

- `scripts/backtest.js` — the CLI script
- `lib/ssb-risk-score.js` — tier calculation logic
- `lib/ssb-screen-utils.js` — row extraction
- `scripts/export-ranked-screen.js` — snapshot exporter for manual tracking
- `lib/ssb-backtest-metrics.js` — P&L / ROI / Sharpe / max-drawdown engine

## Scoring real outcomes (P&L / ROI / Sharpe / drawdown)

The synthetic script validates the _engine_. To score _real resolved
outcomes_, resolve a snapshot with per-play outcomes and run the metrics engine:

```bash
# 1. Capture a pre-game snapshot
node scripts/backtest.js --snapshot MLB Moneyline

# 2. After games settle, attach per-play outcomes to the snapshot file:
#    resolved.plays = [{ "participant": "Yankees", "odds": -140, "stake": 100, "result": "won" }, ...]

# 3. Score it
node scripts/backtest.js --metrics 2026-06-10-mlb-moneyline.resolved.json
```

`computeBacktestMetrics(plays)` returns:

| Field         | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `profit`      | Net P&L in dollars (sum of per-play profit)             |
| `roi`         | `profit / totalStaked * 100`                            |
| `winRate`     | Decided bets won / (won + lost)                         |
| `sharpe`      | Mean per-play return ÷ sample stdev (null if < 2 plays) |
| `maxDrawdown` | Largest peak-to-trough drop in the cumulative P&L curve |

> Profitability is **UNPROVEN** until the input contains real resolved outcomes.

### Segmented evaluation and leakage checks

Use `segmentEvaluationRows(rows, { dimensions, minSample })` from
`lib/record-evaluation.js` to keep sports, markets, books, and price bands
separate. The function reports wins, losses, pushes, decided hit rate, and an
`insufficientSample` flag. Do not use a pooled all-sports hit rate to change
ranking weights.

Use `validateDecisionTimeIntegrity(row)` before scoring a row. It flags outcome,
settlement, final-score, and payout fields leaked into the decision snapshot and
flags decision timestamps that are not before settlement. Closing odds belong in
an evaluation field, not in the model's decision-time feature set.

Keep Brier score, log loss, reliability bins, ROI, CLV, and drawdown together.
Accuracy alone cannot distinguish a calibrated near-even model from an
overconfident model that loses at bad prices.

Use `assessSportContext({ league, market, sportContext })` from
`lib/ssb-context-gates.js` as a pre-evaluation diagnostic. It fails
closed on missing context for tennis format, soccer competition/draw structure,
MLB pitcher/lineup/weather state, NHL goalies, football timing/line identity,
basketball availability/rest/pace, and UFC replacement/weigh-in/weight-class/
bout format. It reports `not_applicable` for uncovered leagues rather than
inventing a pass. This helper is intentionally not wired into ranking yet; its
first job is to make missing context visible without changing existing public
play responses.

### External-model benchmark adapters

Third-party rating and prediction sources (Massey, Sagarin, Sasser) live in a
**shadow / benchmark layer** that is deliberately never wired into live `BET`
eligibility. Ratings are additive context for evaluation; they must not change
`kaiCall`, `displayTier`, `confidenceTier`, `finalVerdict`, `consensusEdge`,
`screenScore`, or `riskScore`. The overlay's two-run invariant test proves it
leaves every one of those fields identical at the module level (see the wiring
note below).

Prefer these adapters over changing the live ranking path or the v2 ledger.

**One contract, N sources**

- `lib/ssb-ratings-contract.js` — the normalized record every source produces
  (`source`, `method`, `league`, `season`, `asOf`, `fetchedAt`, `sourceUrl`,
  `sourceHash`, `teamA/teamB`, `ratingA/ratingB`, `predictedScoreA/B`,
  `predictedTotal`, `predictedMargin`, `homeAdvantage`, `marketOpen`,
  `marketCurrent`, `coverage`, `matchStatus`, `unresolvedReason`). Validation is
  pure and fails closed: an unusable numeric becomes `null` and forces
  `coverage: 'partial'`; a missing `sourceUrl`/`sourceHash`/`fetchedAt` is an
  error; an `unresolved` record must carry a reason.
- `lib/ratings-sources/massey.js`, `.../sagarin.js`, `.../sasser.js` — one pure
  adapter per source, each with an **injected** `fetchImpl` (no test path can
  reach the network) and a pure `normalizeX`. See the coverage table below.
- `lib/ssb-ratings-snapshot.js` — versioned, hash-carrying snapshots in the local
  state dir, never the repo (see below).
- `lib/ssb-ratings-overlay.js` — additive `applyRatingsOverlay`: attaches
  `row.ratings = { massey, sagarin, sasser }` on the **composite**
  `(league, canonical game identity, market)` key, only adds (never clobbers a
  pre-existing `row.ratings`), and fails closed with `null` on any unresolvable
  team/league/matchup.
- `lib/ssb-external-ratings-evaluation.js` — source-agnostic
  normalize → score → segment machinery. `scoreRatingRows` / `segmentRatingRows`
  delegate to `scoreEvaluationRows` / `segmentEvaluationRows`; `evaluateRatingSources`
  scores each source **independently** (no composite blend); `evaluateMarketRelative`
  is the gate that compares each source against the de-vigged close.

**Wiring status: the overlay is built and tested but not yet invoked from any
production call site.** `applyRatingsOverlay` / `canonicalGameKey` are required
only by `test/ratings-overlay.test.js`, and nothing in the scan path calls them,
so a live scan does not emit a `ratings` field today. The rank-neutrality result
is therefore **module-level** (the two-run invariant test in
`test/ratings-overlay.test.js` proves the overlay leaves every ranking/tier/
verdict/score field identical), not a proven live-path result. A `ratings` key is
whitelisted into the feature snapshot in `lib/record-candidates.js`, so an
overlay run would survive into the ledger, but wiring the overlay into a
production path is separate, explicit follow-up work.

The Sagarin-only helper `lib/sagarin-external-evaluation.js` is retained and now
delegates into that shared module (`normalizeSagarinRows`, `scoreSagarinRows`,
`segmentSagarinRows`, FBS/FCS segmentation) with its behavior unchanged. Keep
`test/sagarin-evaluation.test.js` green; generalize by extraction, not deletion.

**Per-source coverage (canonical repo league codes)**

| Source  | Leagues                                      | Notes                                                                                            |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Massey  | CFB→`NCAAF`, NFL, NBA, NHL, MLB, MLS, WNBA   | The only source with MLB **team** ratings. NCAAB is a deliberate adapter scope gap.              |
| Sagarin | CFB→`NCAAF`, NFL, NBA, CBB→`NCAAB`, NHL, MLS | **No MLB team ratings** — Sagarin's baseball page is player ratings.                             |
| Sasser  | CFB→`NCAAF` only                             | A per-game projection overlay, not a rating (`ratingA/B` null, `coverage: 'partial'` by design). |

A league a source does not publish returns `coverage: 'unavailable'` with a
stated reason, and the refresh never fetches it — an empty ratings table and a
quiet slate must not look alike. Unsupported is kept distinct from an
unrecognized code: a real canonical league the source does not cover names the
source and the sport, while only a code outside the repo's league registry is a
caller typo.

**Snapshots live outside the repo**

Store every external snapshot separately from settled SSB bets, under
`PP_RATINGS_DIR` (default `~/.ssb-for-agents/ratings/`), as
`<source>-<league>-<season>.json` (`schemaVersion: 1`). No third-party dataset is
bundled in the repo: Massey's terms reserve all rights, so only derived records
plus a `sourceHash` are kept, and the store refuses a write anywhere inside the
repo. The store also fails closed on read: a snapshot whose `sourceHash` does not
match its records is rejected, and one whose `asOf` predates a supplied cutoff
loads as `stale: true` rather than silently current.

Each snapshot records the source URL, retrieval time, prediction method, season,
`asOf`, and `sourceHash`. Keep the source's own `asOf` (its "through games of" /
"Using games thru" / "Updated" line) **separate** from our `fetchedAt`; the two
observably diverge. See `docs/research/external-ratings-sources-2026-09.md` for
the per-source caveats.

**Market-relative gate**

A one-week winner rate is descriptive only; it is not a betting edge. Compare
every external probability with the **de-vigged closing line** (CLV, ROI,
drawdown) alongside Brier score, log loss, and reliability, chronologically and
segmented by league, level (FBS/FCS), favorite band, and market. Report sample
and coverage before any score, and flag `insufficient_sample` below the
threshold instead of reporting a number. Restate the honest baseline in the
output: Fair & Oster found computer rankings add no information on top of the
Vegas spread, so the expected value here is **context and veto, not edge**. Do
not promote an external probability into a live weight before chronological
out-of-sample evidence beats the close.

`docs/research/sagarin-ncaaf-benchmark-2026-09-06.md` remains the verified NCAAF
snapshot (118 rows, 90 matched, 81 correct, 28 unmatched excluded) and its source
caveats.

**Refresh (PP-free, schedulable) and read-back**

```bash
node scripts/refresh-ratings.js --source massey,sagarin,sasser --league NCAAF
pp ratings --source sagarin --league CFB --show   # read snapshots, no fetch
```

`scripts/refresh-ratings.js` fans out per source/league with an injected
transport and **never aborts the batch**: a throwing pair, an unsupported league,
or a page with no readable rows becomes its own result row (`error` /
`unsupported` / `unavailable`), and the process exits non-zero only when no pair
succeeded. It imports no PropProfessor client, calls no SSB endpoint, and
installs no cron/watcher/startup hook — refreshing third-party pages is the
allowed schedulable category (same as `resolve-outcomes.js --espn` and
`refresh-tennis-circuit.js`), while anything that calls SSB is not. `pp ratings`
is a read-only snapshot reader (CFB/CBB aliases map to NCAAF/NCAAB); it never
fetches.

## Daily snapshot + outcome-resolution pipeline (real P&L over time)

The hand-authored fixture validates the _engine_. To accrue _real_ metrics,
run the daily snapshot pipeline and resolve outcomes as games settle. This
writes a JSONL ledger (`data/snapshots.jsonl`) of every recommended play, then
attaches settled results so `computeBacktestMetrics` can score an ever-growing
history.

> **Manual-only.** Snapshot capture calls live PropProfessor endpoints, so it
> requires an explicit `--live` acknowledgment and must never run unattended.
> There is **no snapshot cron**: the dedicated `scripts/backtest-daily-snapshot.js`
> wrapper was removed, and no cron, scheduled workflow, watcher, or launch
> agent may call SSB on a schedule. Public-only operations that
> never call SSB — ESPN settlement (`resolve-outcomes.js --espn`)
> and Flashscore/tennis-circuit cache refresh (`scripts/refresh-tennis-circuit.js`)
> — are a separate, allowed category and may be scheduled.

### 1. Capture a daily snapshot (manual — `--live` required)

```bash
# Default provider = live handlers.quick_screen (recommended), writes data/snapshots.jsonl
node scripts/daily-snapshot.js --live

# Limit leagues / write to a custom file (also accepts --market)
node scripts/daily-snapshot.js --live --leagues NBA,MLB --out /tmp/snap.jsonl
```

Without `--live` the command refuses to run (exit 1, "manual-only" message)
before touching the ledger or any endpoint. The library path stays
deterministic: `takeDailySnapshot({ getPlays })` with an injected play source
needs no `--live` and no network.

Each line captures: `playId` (stable sha256 of gameId+selection+market+book),
`gameId`, `selection`, `market`, `league`, `book`, `odds`, `tier`, `kaiCall`,
`screenScore`, `timestamp` (ISO), and `result` (absent until resolved). The
script is **idempotent per UTC day** — re-running it in the same UTC day will
not duplicate a `playId` already snapshotted today. It is **mock-friendly**:
`takeDailySnapshot({ getPlays })` accepts an injected play source, so it is
fully testable without network access.

### 2. Resolve outcomes (CSV fallback — reliable, no live endpoint needed)

The PropProfessor API does **not** expose a settled-results feed, so the
pipeline is designed around a manual CSV you maintain:

```bash
# columns: playId,result  (result ∈ win|loss|push; optional odds,stake)
node scripts/resolve-outcomes.js --csv results.csv
```

The CSV's `playId` column must match the `playId` emitted by the snapshot.
Unresolved plays get `result` + `resolvedAt` written back into the ledger
_in place_. Plays whose `playId` is absent from the CSV stay unresolved.

> Optional live path: `--live` calls an injected `liveGetPlayResult(play)`
> resolver. There is no built-in client method for settlement today, so live
> resolution only runs when a resolver is supplied. The CSV path is the
> supported default.

### 3. Score the resolved history with the metrics engine

```js
const { computeBacktestMetrics } = require('./lib/ssb-backtest-metrics');
const { resolveOutcomes, ledgerToPlays } = require('./scripts/resolve-outcomes');

const { rows } = await resolveOutcomes({ inFile: 'data/snapshots.jsonl' });
const plays = ledgerToPlays(rows); // -> [{ odds, stake, result: 'won'|'lost'|'push' }]
const m = computeBacktestMetrics(plays);
// m.profit, m.roi, m.sharpe, m.maxDrawdown, m.winRate ...
```

`ledgerToPlays` translates the snapshot's canonical `win|loss|push` vocabulary
into the engine's `won|lost|push`. Run this after each resolution to watch
P&L / ROI / Sharpe / max drawdown accrue as your real settled results accumulate.

### Files

- `scripts/daily-snapshot.js` — JSONL snapshot capture (idempotent, mock-friendly)
- `scripts/resolve-outcomes.js` — CSV (and optional live) outcome resolution, in place
- `data/snapshots.jsonl` — the append-only play ledger (created on first run)
- `test/pipeline.test.js` — end-to-end test (mocked plays → CSV resolve → metrics)
