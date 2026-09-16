# External Ratings Sources - 2026-09

Updated: 2026-09-15

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

**Wiring status: the shadow overlay IS wired, behind an explicit opt-in.**
`bin/pp-cli.js` calls `applyScanRatingsOverlay(res, flags)` after the tennis and
wallet overlays and before render, so the same rows feed both stdout and the
`--record-scan` ledger snapshot. It is enabled with `--ratings-overlay` or
`SSB_RATINGS_OVERLAY=true` and is **off by default**; when disabled the helper
returns before reading the snapshot store, so a normal scan pays no I/O cost and
emits no `ratings` field. A `ratings` key is whitelisted into the feature
snapshot in `lib/record-candidates.js`, so rated rows survive into the ledger.

Rank-neutrality is proven at two levels: the module-level two-run invariant in
`test/ratings-overlay.test.js`, and the CLI-level two-run test in
`test/pp-cli-ratings-overlay.test.js` (OFF is byte-identical across runs; ON
differs only by `ratings`, and stripping `ratings` from the ON run is
byte-identical to OFF). The snapshot store is wired via
`scripts/refresh-ratings.js` and the read-only `pp ratings` command.

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
- `scripts/refresh-ratings.js` — PP-free fetch + snapshot fan-out; `pp ratings`
  reads the snapshots back and never fetches.

## Per-source coverage

| Source     | Canonical leagues covered                                   | Data shape                               | MLB?                                                                                    |
| ---------- | ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Massey     | `NCAAF`, `NFL`, `NBA`, `NCAAB`, `NHL`, `MLB`, `MLS`, `WNBA` | Per-team ratings table (`Rat` primary)   | Yes — the only source with MLB **team** ratings                                         |
| Sagarin    | `NCAAF`, `NFL`, `NBA`, `NCAAB`, `NHL`, `MLS`                | Per-game predictions with totals         | **No** — the baseball page is _player_ ratings, so there is no team rating to normalize |
| Sasser     | `NCAAF` only                                                | Per-game projection overlay              | No                                                                                      |
| tennis_elo | `TENNIS` only                                               | Per-player surface-aware Elo (moneyline) | No                                                                                      |

CLI/frontend vocabulary `CFB`/`CBB` maps to the contract's canonical `NCAAF`/
`NCAAB`. Massey publishes a college-basketball page (`/cb/ncaa-d1/ratings`), the
massey adapter covers `NCAAB`, and the team-alias registry seeds all 362 ESPN D1
programs, so Massey NCAAB rows join to a game instead of staying `unresolved`.
ESPN publishes no team for Queens, Lindenwood, Southern Indiana or St. Francis
(PA), so those four rows stay `unresolved` rather than getting a guessed key.

A Massey `NCAAB` snapshot cannot be written until the college-basketball season
begins: Massey's page reports `Using games thru Preseason` instead of a date, so
`asOf` and `season` are null and the snapshot store refuses the write. That is
fail-closed behaviour working correctly, not a broken adapter - the page still
parses (365 rows); only the date is missing. Expect `massey NCAAB` to error with
`missing or invalid season/asOf` until the season starts (roughly November).

A league a source does not publish returns `coverage: 'unavailable'` with a reason
and is never fetched; an unsupported canonical league (names source and sport) is
kept distinct from an unrecognized code (a caller typo).

## License / terms notes

- **No third-party dataset is bundled in the repo.** Massey's terms reserve all
  rights. Only derived records plus a `sourceHash` (sha256 of the raw payload)
  are stored, and the snapshot store refuses any write whose resolved path is
  inside the repo.
- Snapshots land under `PP_RATINGS_DIR` (default
  `~/.ssb-for-agents/ratings/`) as `<source>-<league>-<season>.json`
  (`schemaVersion: 1`), matching the existing `PP_RECORD_LEDGER` /
  `PP_SIGNAL_CALIBRATION_FILE` override convention.
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
- The regular predictions block and the separate `EXPERIMENTAL NUMBERS INVOLVING
HOME-AWAY ADJUSTMENTS` block are **different methods**
  (`overall`/`predictor`/`golden_mean`/`recent` versus their `experimental_*`
  siblings). They are never merged.
- The heading date can lag the rows it sits above (see above). The `HMARG WIN%
MONEY` tail is printed on CFB/NFL but omitted on NBA/NHL, so it is optional.
- A second numbered section (the EIGENVECTOR table) can follow the block and
  restarts at row 1; the parser stops there instead of reporting every one of its
  rows as skipped.
- **MLB is deliberately unsupported** and surfaces as `coverage: 'unavailable'`
  with a reason, never empty success.
- Verified pages: CFB `cfsend.htm`, NFL `nflsend.htm`, NBA `nbasend.htm`, CBB
  `cbsend.htm`, NHL `nhlsend.htm`, MLS `soccer.htm`.

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
- `massey` — HTTP 403 from its ratings page (upstream bot-block); needs an
  explicit `--export-url` to the export link. The Massey failure did not abort
  the other two pairs.

Treat upstream availability as dated. Re-run a bounded refresh and read the
counts/per-pair status before trusting any coverage claim, and check the
vendor's current terms before scheduling anything.
