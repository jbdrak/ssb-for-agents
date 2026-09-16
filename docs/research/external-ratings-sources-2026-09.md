# External Ratings Sources - 2026-09

Updated: 2026-09-16

This note records the third-party coverage, license/terms position, and parse
caveats for the external-ratings **benchmark** layer: Massey, Sagarin, Sasser,
and the locally-built tennis Elo snapshot. It is a source reference, not a
performance claim. The verified out-of-sample-style read for one NCAAF week
stays in `docs/research/sagarin-ncaaf-benchmark-2026-09-06.md`.

## Scope: shadow / benchmark only

These sources are **never wired into live `BET` eligibility**. Records attach to
candidate rows as additive context (`row.ratings`) and are scored for evaluation
only. The overlay changes zero ranking, tier, verdict, or score fields, and no
external probability becomes a live weight until chronological out-of-sample
evidence beats the de-vigged closing line. Fair & Oster found computer rankings
add no information on top of the Vegas spread, so the expected value here is
context and veto, not edge.

**Wiring status (as of 2026-09-16): the shadow overlay is wired into `pp scan`,
opt-in and default OFF.** `cmdScan` in `bin/pp-cli.js` calls
`applyScanRatingsOverlay`, which invokes `applyRatingsOverlay` only when
`--ratings-overlay` (or `SSB_RATINGS_OVERLAY=true`) is set; `--no-ratings-overlay`
forces it off, so a normal scan emits no `ratings` field. The overlay only ADDS
`row.ratings` and changes no `kaiCall`, tier, verdict, or score, so no external
rating reaches live BET eligibility. Rank-neutrality evidence stays module-level
(the two-run invariant test in `test/ratings-overlay.test.js`); the wired CLI path
calls that same module. A `ratings` key is whitelisted into the feature snapshot
in `lib/record-candidates.js`, so an overlay run survives into the ledger. The
snapshot store is wired too, via `scripts/refresh-ratings.js` and the read-only
`pp ratings` command.

## Module map

- `lib/ssb-ratings-contract.js` — the one normalized record shape and its
  fail-closed validation (`validateRatingRecord`).
- `lib/ratings-sources/massey.js`, `.../sagarin.js`, `.../sasser.js` — one pure
  adapter per source, each with an injected `fetchImpl` so no test path can reach
  the network.
- `lib/ratings-sources/tennis-elo.js` — the tennis Elo source adapter. It has no
  fetch: it normalizes a locally-built snapshot (see `lib/tennis-elo-data.js`)
  into the same contract, so there is nothing to reach the network with.
- `lib/ssb-ratings-snapshot.js` — versioned, hash-carrying snapshots in the local
  state dir.
- `lib/ssb-ratings-overlay.js` — additive `applyRatingsOverlay`, composite join
  key.
- `lib/ssb-external-ratings-evaluation.js` — `evaluateRatingSources` (per-source,
  no blend) and `evaluateMarketRelative` (vs the de-vigged close).
- `lib/ssb-ratings-evaluation-bridge.js` — `buildRatingEvaluationRows` joins
  adapter records to settled outcomes and recorded market closes to produce the
  rows the evaluator scores, and reports per-source probability availability
  (`published` / `derived` / declined with a reason).
- `scripts/refresh-ratings.js` — PP-free fetch + snapshot fan-out; `pp ratings`
  reads the snapshots back and never fetches.

## Per-source coverage

| Source     | Canonical leagues covered                                   | Data shape                                                                                   | MLB?                                                                                                   |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Massey     | `NCAAF`, `NFL`, `NBA`, `NCAAB`, `NHL`, `MLB`, `MLS`, `WNBA` | Per-team ratings table (`Rat` primary)                                                       | Yes — the only source with MLB **team** ratings                                                        |
| Sagarin    | `NCAAF`, `NFL`, `NBA`, `NCAAB`, `NHL`, `MLS`                | Per-game predictions with totals **and** the page's per-team RATINGS table (both normalized) | **No** — the baseball page publishes _player_ ratings, so it carries no team-rating table to normalize |
| Sasser     | `NCAAF` only                                                | Per-game projection overlay                                                                  | No                                                                                                     |
| tennis_elo | `TENNIS` only                                               | Per-player surface-aware Elo (moneyline)                                                     | No                                                                                                     |

CLI/frontend vocabulary `CFB`/`CBB` maps to the contract's canonical `NCAAF`/
`NCAAB`. Massey publishes a college-basketball page (`/cb/ncaa-d1/ratings`), the
massey adapter covers `NCAAB`, and the team-alias registry covers the live D1
table: all 365 rows of the 2026-09-16 Massey NCAAB export resolve, so a Massey
NCAAB row joins to a game instead of staying `unresolved`. The registry seeds
ESPN's 362-program D1 basketball roster plus the four programs that roster omits
while the live table prints them (Queens University, Lindenwood, Southern Indiana,
Saint Francis PA), keyed from the same ESPN teams family published under another
sport.

NCAAF is **not** FBS-only in that registry. The league's game universe is
whatever the board carries, and a live NoVigApp NCAAF scan on 2026-09-16
returned 142 teams of which 44 were FCS programs (`Monmouth @ Albany`,
`Villanova @ LIU`), so an FBS-only alias set left those games with a rating no
side could attach to. Sagarin's FCS printings are seeded from the same ESPN
`football/college-football` roster (its own published `location`), and the
FCS/FBS split is read from the `(AA)` marker the page prints on exactly its FCS
rows rather than assumed. Each seeding is an exact normalized match on one of
ESPN's own name fields; the handful that are not (`Miami-Ohio` -> `Miami (OH)`,
`LIU Post` -> `Long Island University`, `Washington Redskins` ->
`Washington Commanders`) are hand-mapped against the ESPN program they name and
pinned by tests in `test/ratings-team-aliases.test.js`.

A team the registry does not know still stays `unresolved` rather than getting a
guessed key, and because this table tracks current membership it drifts as
programs join or leave a division.

A league a source does not publish returns `coverage: 'unavailable'` with a reason
and is never fetched; an unsupported canonical league (names source and sport) is
kept distinct from an unrecognized code (a caller typo).

## License / terms notes

- **No third-party dataset is bundled in the repo.** Massey's terms reserve all
  rights. Only derived records plus a `sourceHash` (sha256 of the raw payload)
  are stored, and the snapshot store refuses any write whose resolved path is
  inside the repo.
- Snapshots land under `SSB_RATINGS_DIR` (default
  `~/.ssb-for-agents/ratings/`) as `<source>-<league>-<season>.json`
  (`schemaVersion: 1`), following the repo-wide state-dir override convention.
  The pre-rename `PP_RATINGS_DIR` is still read as a deprecated fallback (like
  `PP_RECORD_LEDGER` / `PP_SIGNAL_CALIBRATION_FILE`); `SSB_RATINGS_DIR` wins when
  both are set.
- Sagarin's pages are free legacy HTML; Sasser's is a free public model page. The
  same "derived-only, state-dir-only" rule applies to all of them.
- `scripts/refresh-ratings.js` imports no PropProfessor client and calls no SSB
  endpoint. Refreshing third-party pages is the allowed schedulable category
  (same as `resolve-outcomes.js --espn` and `refresh-tennis-circuit.js`); it
  installs no cron, watcher, or startup hook, and anything that calls SSB is not
  schedulable.

## Snapshot contract and the stale-heading trap

Each snapshot stores `source`, `league`, `season`, `method`, `asOf`, `fetchedAt`,
`sourceUrl`, `sourceHash`, and the records. Keep the source's **own** `asOf`
separate from our `fetchedAt`; never derive one from the other. The benchmark
snapshot proved the divergence is real: Sagarin's visible ratings heading said
"through games of August 29" while the rows beneath it were the Sep 3-6 slate.

The store also fails closed on read: a snapshot whose `sourceHash` does not match
its records is rejected, and one whose `asOf` predates a supplied cutoff loads as
`stale: true` instead of being silently accepted as current.

## Parse caveats

### Sagarin (`sagarin.com/sports/`)

- Free legacy fixed-width HTML, not JSON. Rows are anchored on the leading index
  and the numeric columns; a garbage line is skipped, not thrown.
- **A page carries three numbered sections, and the adapter normalizes two of
  them.** The whole-season RATINGS table (one row per team, with a
  college-football division letter between the team and `=`), its
  per-division/conference repeats, and the `EIGENVECTOR` table are all numbered
  too. The adapter reads the game-prediction block (the only section that can
  produce a game-scoped record) **and** the per-team RATINGS table (team-scoped
  records, with the repeats de-duplicated). The `EIGENVECTOR` and
  division-summary tables stay out of scope. A page's raw numbered-row count is
  still a **diagnostic**, never a parsing target: NBA's page shows 84 numbered
  rows for a 30-team league because every team is printed again in its division
  sub-table. `normalizeSagarin` returns `pageCandidateRows` (whole page),
  `blockCandidateRows` (prediction-block rows attempted), `teamCandidateRows`
  (distinct team rows, after de-duplication) and `candidateRows` (their sum, the
  coverage denominator) so that split is visible instead of being hidden behind
  a bare `coverage: 'full'`.
- **The coverage gate spans both parsed sections.** `coverage: 'full'` requires
  that every candidate row in the prediction block **and** in the de-duplicated
  ratings table became a record AND that each record is complete. Any unreadable
  candidate row, or any parsed row that yields an incomplete record (no
  projected score, e.g. a lost home/away marker), demotes the envelope to
  `partial` with a `coverageReason` naming both sections and the shortfall; zero
  records in **both** is `unavailable`. An `unresolved` team row is deliberately
  NOT counted as incomplete - it carries its rating and is only missing a
  registry entry, which is the correct fail-closed outcome rather than a parse
  drift. Verified against live captures (2026-09-16,
  `test/fixtures/ratings/`): all six leagues produced **zero** unreadable
  candidate rows and **zero** incomplete records for every method, so the gate is
  silent today and fires the moment either column layout drifts.
- NBA and NHL show only their finals matchup in the prediction block (2 and 1
  rows) and NCAAB / MLS have no prediction rows at all - those pages are frozen
  final-ratings pages. That is a genuine short slate, not an under-read: all
  four leagues carry a full per-team RATINGS table, so their records come from
  that section instead (see the decision section below).
- The regular predictions block and the separate `EXPERIMENTAL NUMBERS INVOLVING
HOME-AWAY ADJUSTMENTS` block are **different methods**
  (`overall`/`predictor`/`golden_mean`/`recent` versus their `experimental_*`
  siblings). They are never merged.
- The heading date can lag the rows it sits above (see above). The `HMARG WIN%
MONEY` tail is printed on CFB/NFL but omitted on NBA/NHL, so it is optional.
- **The prediction block prints a win probability, and the adapter carries it.**
  The leading `WIN%` column (immediately after `MONEY`, before the `home away
TOTAL` scores) is the printed FAVORITE's win probability; `MONEY` beside it is
  the underdog's price "to 100". Verified on the six 2026-09-16 captures, 276
  prediction rows across both blocks:
  - the percent matches `round(100 * M / (100 + M))` for 274 rows and is one
    point off on two (Sagarin prints the percent independently of the rounded
    price), which is what pins the column order rather than the header text;
  - it follows the printed favorite, not the venue: CFB row 4 puts
    `Miami-Florida` (away) at 82%, and NBA prints the same two teams with a
    different favorite per row (Knicks 55%, Spurs 56%);
  - it is a whole-percent column (observed 50-98), so the carried value is
    `WIN% / 100` and never inflated with more digits;
  - the TRAILING `WIN%` of the optional `HMARG WIN% MONEY` tail is a different
    number for the page's home-margin line (signed negative when the home team is
    the underdog) and is deliberately never parsed.

  An out-of-range print (a scale or column change) is passed to the contract,
  which rejects the record: the row is skipped with its errors and the block
  drops from `full`. A page that stops printing the column at all makes every
  row unparseable, which the coverage gate already reports.

- A second numbered section (the EIGENVECTOR table) can follow the block and
  restarts at row 1; the parser stops there instead of reporting every one of its
  rows as skipped.
- **Staleness is printed by the refresh.** A source's own heading can be years
  behind the fetch (NCAAB 2023-04-03, MLS 2024-12-07 in the 2026-09-16 capture),
  so `scripts/refresh-ratings.js` reports `age=<n>d` per pair and `stale=true`
  past a 30-day window, mirroring the snapshot store's cutoff-based `stale` on
  read.
- **MLB is deliberately unsupported** and surfaces as `coverage: 'unavailable'`
  with a reason, never empty success.
- Verified pages: CFB `cfsend.htm`, NFL `nflsend.htm`, NBA `nbasend.htm`, CBB
  `cbsend.htm`, NHL `nhlsend.htm`, MLS `soccer.htm`.

### Sagarin per-team RATINGS table: decision and landed behaviour (2026-09-16)

**Decision: in scope - and implemented.** `lib/ratings-sources/sagarin.js`
normalizes the whole-season per-team RATINGS table, not only the
game-prediction block. This section records the decision, its rationale and its
constraints so the next reader does not re-open the question, and the constraints
below are now what the code does.

Why:

- **Adapter fidelity.** A Sagarin page publishes one rating row per team for
  every league, and the adapter already fetches that page. The Massey adapter
  normalizes the equivalent per-team table for all eight of its leagues, so
  discarding Sagarin's is an arbitrary asymmetry; reading it adds no network
  call, no new terms question and no new rate-limit exposure - only parser
  code.
- **The coverage claim was unhonorable without it.** `SUPPORTED_LEAGUES.sagarin`
  lists `NCAAB` and `MLS`, and with the prediction block alone the adapter could
  emit no record at all for either, because both are frozen final-ratings pages
  with no prediction rows. A listed league the adapter cannot serve is the same
  class of false claim the layer's docs were just corrected for.
- **It is what the layer is for.** `evaluateRatingSources` scores each source
  independently and deliberately has no composite block, which only means
  something with more than one source per league. Sagarin's table is a second,
  independently produced team-rating voice beside Massey in NBA, NHL, NCAAB and
  MLS.
- **No blockers.** The Massey-tennis decision stayed out of scope on three
  concrete unresolved blockers (the ATP/WTA tour split, the CSV-only tennis
  sourcing decision, and an unverified transport). Every constraint here was
  already verified against the committed captures.

Scope boundary, all verified against `test/fixtures/ratings/`:

- Per-division / per-conference repeats are de-duplicated: the same team is
  printed in the ranked table and again in each sub-table (NBA: 30 teams across
  60 printed rows), and only the first (ranked) occurrence is kept.
- The division / conference summary tables (`1 BIG 12 = 85.53 ...`) and
  Sagarin's `***UNRATED***` sentinel are not programs and are skipped; the
  `EIGENVECTOR` table stays out of scope. The sentinel carries a **real** row
  index (`267  ***UNRATED***        __ = -91.00 ...`), so the leading-index
  anchor does NOT exclude it - the label test does, and a test asserts that
  rather than assuming it.
- Team rows take the Massey shape - `teamA === teamB` with the value in
  `ratingA` - which `lib/ssb-ratings-overlay.js` already keys by the single
  canonical team.
- `method` names a ratings-table column (`overall` = `RATING`, `predictor` =
  `PREDICTOR`, `golden_mean` = `GOLDEN_MEAN`, `recent` = `RECENT`), so a team
  row's value is that column and the snapshot's single `method` field covers both
  populations. The `experimental_*` methods have no ratings-table equivalent and
  emit no team rows.
- NCAAB wraps its team rows in inline `<font>` tags, so the matcher strips tags
  per line. That strip is scoped to the team-table scan: stripping the whole page
  would turn tag-led lines into numbered rows and move the `pageCandidateRows`
  diagnostic. It is also load-bearing - removing it drops NCAAB to zero team
  records (verified by mutation; a committed test pins the un-stripped count at
  zero).
- The MLB reason string is retained and is now literally correct: every other
  league publishes a team-rating table, and only baseball publishes player
  ratings instead.
- Team rows carry the page's single listed `homeAdvantage`, the same value the
  envelope carries, so a consumer can turn a rating pair into a margin. On the
  NCAAB page that value is `null` because the page writes it inside a `<font>`
  run the existing reader does not reach - pre-existing behaviour, quoted here so
  the null is not mistaken for a team-row bug.

Consequences, as landed:

- `coverage: 'full'` now means "every candidate row in **both** parsed sections
  became a record", so the gate gained `teamCandidateRows` (distinct team rows
  after de-duplication) and `candidateRows` (block + team, the merged
  denominator). `blockCandidateRows` still means prediction-block rows. The
  per-league counts pinned in `test/ratings-sagarin-source.test.js` and the
  capture table in `test/fixtures/ratings/README.md` moved with it, and the
  row-semantics tests resolve a prediction row through an explicit game-scoped
  filter (`teamA !== teamB`).
- `NCAAB` and `MLS` no longer report `coverage: 'unavailable'`: they report 363
  and 29 records read from their ratings tables. Those carry the pages' own old
  `asOf` (2023-04-03 / 2024-12-07), so the shared recency gate withholds them
  from any current game - the correct fail-closed outcome, not live context, and
  not a reason to widen the window.
- Team-scoped records are overlay context only until the evaluator question is
  settled: a bare rating needs an explicit, documented conversion before
  anything can score it. They are the same shape Massey already emits and are
  consumed identically.
- Unresolved team rows are the CORRECT outcome for a name with no identity to
  key, not a defect: unresolved rows are excluded from the envelope's
  incomplete-record shortfall, so a registry gap cannot masquerade as a parse
  drift. Before the alias-registry card landed, the live captures left NCAAF
  133/266, NCAAB 43/363, MLS 6/29, NFL 1/32, NBA 1/32 and NHL 0/32 unresolved;
  seeding the source's own spellings against ESPN-published keys took those to
  NCAAF 1, NCAAB 2 and zero for the rest. The three that remain are the printings
  with no ESPN identity to seed at all - Sagarin's `UTRGV` (ESPN publishes no
  football team for UT Rio Grande Valley), `Hartford` (left D1) and
  `St. Francis-NY` (the Brooklyn program, athletics discontinued) - so they stay
  unresolved rather than getting a guessed key.

### Massey (`masseyratings.com`)

- **Transport (verified live 2026-09-15).** The ratings host sits behind a bot
  wall that answers plain HTTP - `node fetch`, with or without a real Chrome
  User-Agent - with HTTP 403 (`Just a moment...`), so the refresh uses the
  repo's existing `got-scraping` client. Passing the wall is not enough: the
  ratings page is a JavaScript shell, so `lib/ratings-sources/massey-web.js`
  reads the page's inline `stamp.obfu` / `stamp.jsonURL`, decodes the latter
  with the page's own cipher to the `/json/rate.php?...` export URL, and
  de-obfuscates the payload's numeric cells with the seed the page itself
  derives (`parseInt(obfu.slice(32), 10)`). This is a **reverse-engineered
  vendor contract** pinned to the current `inc/stamp.js` build, not an API: each
  step fails closed with a reason naming the step, and it must be re-verified
  when Massey ships a new bundle. `--export-url` stays a first-class operator
  seam that needs no browser - a URL returning the export CSV is passed through
  untouched and one returning the export JSON is decoded.
- Expect the ratings export as CSV from the page's More -> Export action, or as
  the JSON endpoint the page itself calls; there is no documented free API. The
  transport re-emits the payload in the adapter's documented CSV shape, folding
  each rank/value pair into one cell (`1 9.10`).
- Verified header (2026-09-15): `Team | Rec | Δ | Rat | Pwr | Off | Def | HFA |
SoS | SSF | EW | EL`; the title line reads `... Using games thru <date>`; a
  `Correlation` footer row is printed as a row and is skipped.
- `Rat`/`Pwr`/`Off`/`Def`/`SoS` cells print a leading rank (`6 8.94`) while
  `HFA` prints bare (`2.29`); the adapter reads the last numeric token.
- **A team-ratings row is not an event.** Massey publishes one rating per team
  with no opponent, so `teamA === teamB` and consumers key Massey by `teamA`
  (canonical) and must treat `teamB` as a structural placeholder, never an
  opponent. A header with no team rows is `coverage: 'unavailable'`, not an empty
  success.
- **The title line has two states, and only one of them carries a date.** Massey
  prints `... Using games thru Sun, Sep 13, 2026` in season and
  `... Using games thru Preseason` out of it. The second form names no date at
  all, so `asOf`/`season` cannot be derived, and
  `lib/ssb-ratings-snapshot.js` correctly refuses the write. The adapter
  therefore reports the **seasonal condition itself** rather than the
  snapshot-write refusal it causes: `coverage: 'unavailable'` with a reason
  quoting the page's own heading, e.g. `massey reports no games played yet
(heading: 'Using games thru Preseason')`, and **zero** records, because an
  undated table can never be persisted and must never be read as current. A
  readable table with no `Using games thru` line at all is the same shape with
  its own reason. `coverage: 'full'` never accompanies `records: 0` anywhere on
  this path - an empty result must not read as success.
- **Which leagues are out of season today (2026-09-16 capture).** `NBA`, `NHL` and
  `NCAAB` all carried the undated `Using games thru Preseason` heading and so
  report `coverage: 'unavailable'` right now. That is the calendar, not a
  coverage gap: all three resolve on their own once their season starts - **NBA**
  and **NHL** around October, **NCAAB** around November - and the pair then
  snapshots normally, exactly as the dated pages do today. Do not read a
  preseason `unavailable` as an adapter bug, a parse failure, or a reason to
  loosen the store's `asOf`/`season` guard.
- Only `Rat` (`ratingA/ratingB`) and `HFA` (`homeAdvantage`) have contract
  fields; `Pwr`/`Off`/`Def`/`SoS` are read for column-order safety but not carried
  until a consumer needs them.

### Sasser (`davidsasser.com/cfb`)

- A Next.js app: the model data is server-rendered inside the RSC flight stream
  (`self.__next_f.push([1, "<escaped stream>"])`), so there is **no HTML table**.
  The adapter decodes the flight chunks and reads the `week` object. Because the
  parser depends on a vendor's private payload shape, treat it as a maintenance
  liability: a fixture proves the decoder against today's bytes, only a live
  fetch proves it still works.
- Only the verified `/cfb` route is fetched; the site root is a personal
  portfolio and no sibling path is guessed.
- `CFB only`. Every other league is `coverage: 'unavailable'` with a reason.
- The page's "Updated <weekday>, <Month> <day>" line names no year, so the year
  comes from the page's `season`.
- This is a projection overlay, not a rating: `ratingA/ratingB` are `null` and
  `coverage: 'partial'` by design. It publishes no win probability, so none is
  derived from the projected scores.
- The page prints the favorite with a negative number, so a spread line naming
  the away team is negated to stay `teamA`-relative; the page's own
  `market.projected` is away-minus-home and equals `-predictedMargin`. The score
  projection is the source of truth.

### Tennis Elo (`lib/ratings-sources/tennis-elo.js`)

- Not a third-party fetch at all: the ratings are built locally from a
  user-supplied match CSV (`lib/tennis-elo-data.js`) and read back from a
  snapshot outside the repo. See `lib/tennis-elo-data/README.md` for the build
  step and the Sackmann/CC BY-NC-SA licence constraint.
- **Moneyline only.** Elo rates a head-to-head winner; it cannot price a total or
  a handicap. A non-moneyline market returns `unavailable` with a reason and
  reads nothing from the snapshot, and the emitted record is scoped to
  `market: 'Moneyline'` so the overlay never attaches it to a totals row.
- **Participants, not teams.** Tennis has no team registry, so the overlay
  identifies each side by the diacritic-folded, case-normalized player name.
  `teamA`/`teamB` are player names, and a lookup whose two sides resolve to the
  same player is refused (`same_player`) rather than emitted as an individual
  "event".
- **`teamA`/`teamB` are one fixture** — a resolved record carries both players,
  and the surface-aware rating is the engine's own blend rule (overall +
  `surfaceWeight × (surface − overall)`, applied to both sides only when both
  clear `minSurfaceMatches` on that surface).
- **Point-in-time is mandatory.** The caller supplies the prediction date
  (`asOf`); a snapshot whose manifest `asOf` is not strictly before it is
  refused. An optional `snapshotNotBefore` floor refuses a snapshot older than a
  date the caller will accept.
- Reason strings are distinct by cause: `unsupported_market`, `missing_asof`,
  `snapshot_unavailable` / `snapshot_invalid` / `snapshot_after_cutoff` /
  `snapshot_stale`, `missing_provenance`, `unknown_tour`, `unknown_player`,
  `ambiguous_player`, `same_player`, `unknown_surface`, `player_missing_rating`,
  `invalid_record`. Never collapse "player not in snapshot" with "snapshot not
  valid for this date" or "surface unknown".
- The snapshot must carry `sourceUrl` (built with `--source-url`); a manifest
  without it is `missing_provenance`, because the contract requires provenance
  and a fabricated URL would be worse than a refusal. The builder enforces the
  same rule at BUILD time: `scripts/refresh-tennis-elo.js` refuses a
  ratings-intended build without `--source-url` and names the missing field, so
  the gap cannot first appear as an `unavailable` row at scan time.
  `--engine-only` is the documented way to build a snapshot for the pure Elo
  engine that the ratings layer refuses by design.

## Evaluation requirements

Score each source **independently** — never blend them. Compare against the
**de-vigged closing line** (CLV, ROI, drawdown) alongside Brier score, log loss,
and reliability. The split is chronological, never shuffled, and segmented by
league, level (FBS/FCS), favorite band, and market. Show sample and coverage
before any score, and report `insufficient_sample` below the threshold instead of
a number. Keep `unmatched` and `unresolved` rows out of every denominator.

## Probability availability and the evaluation bridge

Recording a snapshot is not evaluation. The two halves of this layer are joined by
`lib/ssb-ratings-evaluation-bridge.js`, which turns contract records plus settled
outcomes (and optionally recorded market closes) into the rows
`evaluateRatingSources` / `evaluateMarketRelative` consume. `buildRatingEvaluationRows`
returns `{ rows, sources, skipped, counts }`: `rows` is a flat list (each row
carries its own `source`, so sources are still never blended), `sources` reports
per-source counts plus whether a probability is available at all, and `skipped`
counts every exclusion by reason.

**Every source declares where its probability comes from**, and the contract
carries the attribution with the number (`modelWinProbability` +
`modelWinProbabilityKind`: `published` | `derived`). A probability with no kind is
a contract error and the bridge refuses it, so a number we computed can never be
read as one a vendor published.

| Source     | Probability  | Where it comes from                                                                                                                                                                                                                                  |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sagarin    | `published`  | The prediction block's `WIN%` column, for the printed favorite (see the Sagarin caveats above). Whole-percent display precision.                                                                                                                     |
| tennis_elo | `derived`    | The local Elo engine's own expectation, `1 / (1 + 10^((ratingB - ratingA) / 400))`, over the surface-aware `ratingA`/`ratingB` already on the record. No vendor publishes it; the `derived` label is what keeps that readable. No fitted parameters. |
| Massey     | **declined** | It publishes a team rating (`Rat`) and a season expected-wins column (`EW`/`EL`), never a win probability, and no documented rating-to-probability conversion exists. Scoring it would mean inventing a mapping, so it is scoped out.                |
| Sasser     | **declined** | It publishes projected scores and a printed market line, not a win probability, and none is derived from the projected scores.                                                                                                                       |

A declined source is not a silent gap. The evaluator omits a source with no rows
from its own output, so an empty page and a source that cannot produce a number
look identical there; the bridge's `sources.<name>.probability.reason` is what
distinguishes them, and it is the only surface that says "Massey publishes no win
probability" instead of showing nothing.

**Join rules** (all fail closed):

- **Identity** is the shadow overlay's own `identity()` / `canonicalGameKey()`, so
  a record the overlay attaches to a candidate row and a record the bridge scores
  are keyed the same way. An unresolvable side means no key, and the record is
  reported (`identity_unresolved`) rather than guessed at.
- **Recency** is the layer's shared `ATTACH_MAX_AGE_DAYS` rule, applied by the
  evaluator: the bridge passes the source's `asOf` as the prediction timestamp and
  the settled outcome's start as the game timestamp, and a snapshot outside the
  window scores as `unresolved` instead of counting as evidence.
- **Market scope**: a market input's `market` must match the RECORD's own scope,
  and a market-wildcard record (Sagarin carries none) is served only by a
  market-less input. A carried probability is a win probability, so it must never
  be compared against another market's closing line - and the row's `market` is
  never taken from the market input, which would relabel a win probability as a
  spread opinion.
- **Ambiguity is refused, never collapsed.** A contract record carries no game
  timestamp, so when two settled outcomes resolve to the same pairing (the same
  teams on two dates, or a two-game series) there is nothing that can attribute
  one prediction to one of them: the key is marked ambiguous and the records on it
  are excluded (`ambiguous_fixture`). Two closes for one market of one fixture
  behave the same way (`ambiguous_market_for_fixture`), except that the
  prediction stays evaluable and only the market comparison is withheld.
- A resolved fixture with no settled outcome yet becomes the evaluator's
  `unmatched` bucket, which is never graded; a `winner` that names neither side,
  and a record with no probability, never become rows at all.

**Known coverage limit:** the contract record carries no competition level, so a
bridge-driven evaluation has a single `level` bucket - the FBS/FCS split in the
verified benchmark below is not available through this path until the record
carries a level. Segments that do work are `league`, `market`, `source`,
`favoriteBand` (model confidence), `marketFavoriteBand` (market-implied) and
`modelWinProbabilityKind`.

## Verified benchmark (quoted, unchanged)

From `docs/research/sagarin-ncaaf-benchmark-2026-09-06.md` (Sagarin's regular
`Predictions_with_Totals_and_Moneylines` block, final scores from ESPN's dated
college-football scoreboard feeds):

- 118 Sagarin rows; 90 matched to an independently verified final score; 28
  unmatched and excluded from the denominator.
- Winner predictions correct: 81 of 90, or 90.0%.
- Predicted-total mean absolute error: 12.6903 points.
- Per-team predicted-score mean absolute error: 10.2560 points.
- Daily: Sep 3 9-2, Sep 4 8-0, Sep 5 63-5, Sep 6 1-2 (Sagarin projected
  Wisconsin over Notre Dame and Louisville over Ole Miss on Sep 6).

This is descriptive. The 90% winner rate over one week is not a stable model
estimate, and it must be segmented by competition level and favorite size before
anyone reads it as skill.

## Dated live-refresh observation (2026-09-15)

One bounded refresh run recorded against live sources, for freshness context
only — not a stable contract:

- `sagarin` `NCAAF` — ok, `asOf` 2026-09-12, 119 records, coverage `full`.
- `sasser` `NCAAF` — ok, `asOf` 2026-09-14, 57 records, coverage `partial`.
- `massey` — HTTP 403 from its ratings page (upstream bot-block) **on that date**.
  Superseded by the 2026-09-16 run below: the same host serves fine through
  `lib/ratings-sources/massey-web.js` (the repo's `got-scraping` client), so a
  plain-HTTP 403 is a transport limitation, not a source outage, and the
  `--export-url` seam is for operator-supplied links rather than a required
  workaround. The Massey failure did not abort the other two pairs.

Treat upstream availability as dated. Re-run a bounded refresh and read the
counts/per-pair status before trusting any coverage claim, and check the
vendor's current terms before scheduling anything.

## Dated live-refresh observation (2026-09-16, sagarin all leagues)

One bounded `node scripts/refresh-ratings.js --source sagarin` run into a
throwaway `SSB_RATINGS_DIR`, for freshness context only:

| League | status | `asOf`     | records | coverage | age   |
| ------ | ------ | ---------- | ------- | -------- | ----- |
| NCAAF  | ok     | 2026-09-12 | 385     | `full`   | 4d    |
| NFL    | ok     | 2026-09-14 | 48      | `full`   | 2d    |
| NBA    | ok     | 2026-06-13 | 32      | `full`   | 95d   |
| NHL    | ok     | 2026-06-14 | 33      | `full`   | 94d   |
| NCAAB  | ok     | 2023-04-03 | 363     | `full`   | 1262d |
| MLS    | ok     | 2024-12-07 | 29      | `full`   | 648d  |

The 30-day freshness window makes the summary print `stale=true` for NBA, NHL,
NCAAB and MLS. The record counts are the merged population - prediction-block
records plus de-duplicated per-team RATINGS-table records - and they match the
committed captures exactly. NBA/NHL are finals pages and NCAAB/MLS are frozen
final-ratings pages, so their short prediction slate is the upstream page state,
not a parse gap; their records come from the ratings table instead. The earlier
reading of this table as "the parser under-reads every league" was a raw
whole-page numbered-row count being compared against a record count, which is not
the same thing (see the Sagarin caveats above).

## Dated live-refresh observation (2026-09-16, massey)

One bounded live capture through `lib/ratings-sources/massey-web.js`
(`got-scraping`), for freshness context only. The four leagues below were chosen
because three are out of season and one is in it:

| League | Page's own heading                                      | status before | status after  | records before → after |
| ------ | ------------------------------------------------------- | ------------- | ------------- | ---------------------- |
| NBA    | `Massey NBA Using games thru Preseason`                 | `error`       | `unavailable` | 30 → 0                 |
| NHL    | `Massey NHL Using games thru Preseason`                 | `error`       | `unavailable` | 32 → 0                 |
| NCAAB  | `Massey NCAAB : NCAA D1 Using games thru Preseason`     | `error`       | `unavailable` | 365 → 0                |
| NCAAF  | `Massey NCAAF : FBS Using games thru Sun, Sep 13, 2026` | `ok`          | `ok`          | 138 → 138              |

Before the fix the three undated pairs surfaced as
`error records=0 coverage=full` with
`reason=snapshot not written: missing or invalid season: null; missing or invalid
asOf` - a contradictory row (zero records beside full coverage) whose visible
cause was a store refusal rather than the seasonal condition that produced it.
The tables themselves parsed fine all along: instructing the same NBA capture
with an added date yields `coverage: 'full'` and 30 records, which is what pins
the drop to the missing date rather than to the parser. The three headings are
the undated shape, so they are captured in `test/fixtures/ratings/` (see that
directory's README).

`NCAAF` is the dated control: it still snapshots with `asOf` 2026-09-13. Expect
NBA/NHL/NCAAB to move into that column once their seasons start, with no code
change - a preseason `unavailable` is a calendar fact, not a coverage gap.
