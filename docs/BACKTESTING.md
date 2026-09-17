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

External rating and prediction sources (Massey, Sagarin, Sasser, plus the
locally-built tennis Elo snapshot) live in a **shadow / benchmark layer** that is
deliberately never wired into live `BET` eligibility. Ratings are additive context for evaluation; they must not change
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
  `marketCurrent`, `modelWinProbability`, `modelWinProbabilityKind`, `coverage`,
  `matchStatus`, `unresolvedReason`). Validation is pure and fails closed: an
  unusable numeric becomes `null` and forces `coverage: 'partial'`; a missing
  `sourceUrl`/`sourceHash`/`fetchedAt` is an error; an `unresolved` record must
  carry a reason. `modelWinProbability` is the one field an evaluation needs, and
  it is always paired with its attribution (`published` = the source's own printed
  number, `derived` = computed by a documented conversion): a probability with no
  kind, a kind with no number, or a value outside `[0, 1]` is an error, so a number
  we computed can never be read as one a vendor published.
- `lib/ratings-sources/massey.js`, `.../sagarin.js`, `.../sasser.js` — one pure
  adapter per source, each with an **injected** `fetchImpl` (no test path can
  reach the network) and a pure `normalizeX`. Massey additionally has
  `lib/ratings-sources/massey-web.js`, the transport that gets past its host's
  bot wall (got-scraping) and de-obfuscates the page's export payload; the other
  two sources need no such layer.
- `lib/ratings-sources/tennis-elo.js` — the fourth source adapter. It has no
  fetch at all: it normalizes a locally-built snapshot (`lib/tennis-elo-data.js`)
  into the same contract, is **Moneyline-only**, and identifies a fixture by its
  two player names. See the coverage table below.
- `lib/ssb-ratings-snapshot.js` — versioned, hash-carrying snapshots in the local
  state dir, never the repo (see below).
- `lib/ssb-ratings-overlay.js` — additive `applyRatingsOverlay`: attaches
  `row.ratings = { <source>: … }`, one entry per source in the contract's
  `SOURCES` (massey, sagarin, sasser, tennis_elo), on the **composite**
  `(league, canonical game identity, market)` key, only adds (never clobbers a
  pre-existing `row.ratings`), and fails closed with `null` on any unresolvable
  team/league/matchup. Identity is not the only way a record can be wrong: the
  join is also gated **per row** on recency against that row's own event start,
  so an off-season snapshot cannot be attached as live context. Withheld records
  become an explicit marker (`records: []`, `withheld`, `stale`, `reasonKind`,
  `reason` naming both dates and the window) rather than silent context.
- `lib/ssb-ratings-recency.js` — the layer's **one** recency rule:
  `isBefore(asOf, cutoff)`, the same comparison `ssb-ratings-snapshot.js` already
  applied to a caller-supplied `asOfCutoff`. Callers differ only in the cutoff
  they supply: the store takes one from its caller, the overlay takes
  `eventStart - ATTACH_MAX_AGE_DAYS` (14) per row, the evaluation pipeline takes
  the settled game's timestamp minus the same window, and tennis Elo stays
  strictest (the prediction date itself, plus an optional caller floor).
- `lib/ssb-external-ratings-evaluation.js` — source-agnostic
  normalize → score → segment machinery. `scoreRatingRows` / `segmentRatingRows`
  delegate to `scoreEvaluationRows` / `segmentEvaluationRows`; `evaluateRatingSources`
  scores each source **independently** (no composite blend); `evaluateMarketRelative`
  is the gate that compares each source against the de-vigged close.
- `lib/ssb-ratings-evaluation-bridge.js` — **the join between the two halves.**
  `buildRatingEvaluationRows({ records, outcomes, markets })` turns adapter records
  (the overlay's own input vocabulary) plus settled outcomes and recorded market
  closes into exactly the rows `evaluateRatingSources` / `evaluateMarketRelative`
  consume, and returns `{ rows, sources, skipped, counts }`. Each source declares
  where its probability comes from: **Sagarin** carries the page's own `WIN%`
  (`published`, whole-percent precision), **tennis Elo** carries its engine's own
  Elo expectation (`derived`, no fitted parameters), and **Massey** and **Sasser**
  are declined with a stated reason because neither publishes a win probability and
  no documented rating-to-probability conversion exists for Massey. That reason
  matters structurally: the evaluator omits a source with no rows from its own
  output, so without it a source that can never produce a number would read exactly
  like a quiet slate. Join rules are the layer's, not new ones: identity comes from
  the overlay's `canonicalGameKey`, recency from the shared `ATTACH_MAX_AGE_DAYS`
  window the evaluator applies, a market input must match the record's own market
  scope (a market-wildcard record is served only by a market-less input, so a win
  probability is never compared against another market's close), and a pairing two
  settled outcomes claim is refused as `ambiguous_fixture` rather than collapsed
  onto one game.

**Wiring status: wired into `pp scan`, ON by default.** `cmdScan` in
`bin/pp-cli.js` calls `applyScanRatingsOverlay`, which invokes `applyRatingsOverlay`
unless `--no-ratings-overlay` (or `SSB_RATINGS_OVERLAY=false`) disables it, so a
scan carries `row.ratings` unless it is asked not to; the explicit
`--ratings-overlay` flag is still accepted and now simply states the default. A
league a source does not cover still carries the key with a `null` entry per
source, so the presence of `ratings` is not itself evidence that a source
matched.
The overlay is pure enrichment: it only ADDS `row.ratings` and leaves `kaiCall`,
`displayTier`, `confidenceTier`, `finalVerdict`, `consensusEdge`, `screenScore`,
and `riskScore` untouched, so no external rating reaches live BET eligibility.
Rank-neutrality is proven **at module level** by the two-run invariant test in
`test/ratings-overlay.test.js`; the CLI path calls that same module, so no
separate live A/B neutrality run is claimed. A `ratings` key is whitelisted into
the feature snapshot in `lib/record-candidates.js`, so an overlay run survives
into the ledger.

**Running the evidence gate.** `pp ratings --evaluate` is the runnable form of
the two gates below. It reads the snapshot store and the tracker ledger and
prints, per source, the records seen, the rows joined, whether the source can
produce a probability at all (and why not when it cannot), and its sample before
any score; then the market-relative gate. The outcomes it scores against come
from settled **moneyline** bets in the ledger: a win probability is a moneyline
concept, and only a moneyline result names the game's winner, so run-line /
handicap / total settlements are never converted into one. The gate reports
`sample=0` until settled moneyline outcomes exist for a league a
probability-carrying source covers (Sagarin: NCAAF/NFL; tennis Elo: TENNIS).

**The de-vigged close.** A scan row now carries `marketFairProbability`: the
decision-time fair price for that side, derived in the candidate mapper
(`lib/screen-fair-probability.js`) from the market's own two-sided book prices
(`allBookOdds`), which survive to the mapper on every row shape. It is the mean of
each book's own de-vig, `p(own) / (p(own) + p(other))`, over the books that quote
BOTH legs; a one-legged book is skipped and an unresolvable side yields `null`
rather than the single-sided implied probability that still carries the hold. It
is a DECISION-time price, never a game-time close, and is never presented as one.
`--record-scan` writes it into the candidate feature snapshot, so the ledger
accumulates the closes the market-relative gate needs. Feeding those recorded
closes back into `--evaluate` automatically is deliberately NOT done yet: a market
input must match a record's own market scope, and the probability-carrying records
are market-wildcards, so pairing them is a scoping decision, not a wiring
shortcut. `--markets <file>` remains the explicit way to supply closes.

**Settling a source's own fixtures.** `pp ratings --evaluate` scores a source
against settled results, and until now those could only come from the tracker
ledger - that is, only from games someone chose to bet, which makes a source's
calibration depend on the bettor's picks. `node scripts/resolve-ratings-outcomes.js
--source sagarin --league NCAAF` settles a source's OWN fixtures from ESPN's
public college-football scoreboard and writes `cfb-outcomes-<LEAGUE>-<season>.json`
into the ratings state dir; `pp ratings --evaluate --outcomes <file>` feeds it to
the gate, and the file and the ledger are additive.

Matching uses the layer's own canonical identity on both sides, and it works only
because of which ESPN field is read: measured against a live 80-game slate,
`team.location` canonicalized on 160/160 teams, while `displayName`
("Pittsburgh Panthers") canonicalized on 0/160 and `shortDisplayName`
("Western KY") on 151/160. Anything that does not resolve - an unknown school, a
game ESPN lists twice in the window, an unfinished game, a tie - is counted and
skipped, never approximated, because a wrong winner would be scored as evidence
and would move a source's calibration.

**The window is explicit.** A ratings snapshot carries the source's own `asOf`
("through games of") but no per-fixture kickoff date, so the resolver never infers
one: `--from`/`--to` state the dates to search, defaulting to the ten days after
the snapshot's `asOf`. A snapshot of the CURRENT week predicts games that have not
been played yet, so `matched=0` is often the correct answer. That is a data truth,
not a bug.

**Known gap: snapshots are not retained.**
`<SSB_RATINGS_DIR>/<source>-<league>-<season>.json` has no date in its name, so
every refresh overwrites the previous snapshot. The predictions a settled result
would be scored against are therefore destroyed before the games are played, and
the evidence loop cannot close for any source until snapshots are kept per `asOf`.
Until then `--evaluate` scores whatever the current snapshot can be joined to
(usually nothing); the numbers it can report come from supplied outcomes.

The Sagarin-only helper `lib/sagarin-external-evaluation.js` is retained and now
delegates into that shared module (`normalizeSagarinRows`, `scoreSagarinRows`,
`segmentSagarinRows`, FBS/FCS segmentation) with its behavior unchanged. Keep
`test/sagarin-evaluation.test.js` green; generalize by extraction, not deletion.

**Per-source coverage (canonical repo league codes)**

| Source     | Leagues                                           | Notes                                                                                                     |
| ---------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Massey     | CFB→`NCAAF`, NFL, NBA, NCAAB, NHL, MLB, MLS, WNBA | The only source with MLB **team** ratings. NCAAB reads the NCAA D1 ratings table.                         |
| Sagarin    | CFB→`NCAAF`, NFL, NBA, CBB→`NCAAB`, NHL, MLS      | **No MLB team ratings** — Sagarin's baseball page is player ratings.                                      |
| Sasser     | CFB→`NCAAF` only                                  | A per-game projection overlay, not a rating (`ratingA/B` null, `coverage: 'partial'` by design).          |
| tennis_elo | `TENNIS` only                                     | A locally-built, Moneyline-only Elo (`lib/tennis-elo-data.js`); no fetch, and no totals/handicap pricing. |

Massey's NCAAB coverage reads the NCAA D1 ratings page, and the team-alias
registry covers the live D1 table: every row of the 2026-09-16 Massey NCAAB export
(365 teams) resolves, so its rows join to a game instead of staying `unresolved`.
The registry seeds ESPN's 362-program D1 basketball roster plus the four programs
that roster omits while the live table prints them (Queens University, Lindenwood,
Southern Indiana, Saint Francis PA), keyed from the same ESPN teams family
published under another sport. A team the registry does not know still stays
`unresolved` rather than getting a guessed key, and because this table tracks
current D1 membership it drifts as programs join or leave D1.

A league a source does not publish returns `coverage: 'unavailable'` with a
stated reason, and the refresh never fetches it — an empty ratings table and a
quiet slate must not look alike. Unsupported is kept distinct from an
unrecognized code: a real canonical league the source does not cover names the
source and the sport, while only a code outside the repo's league registry is a
caller typo.

**Snapshots live outside the repo**

Store every external snapshot separately from settled SSB bets, under
`SSB_RATINGS_DIR` (default `~/.ssb-for-agents/ratings/`), as
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
