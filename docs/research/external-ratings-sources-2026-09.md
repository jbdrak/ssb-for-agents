# External Ratings Sources - 2026-09

Updated: 2026-09-15

This note records the third-party coverage, license/terms position, and parse
caveats for the external-ratings **benchmark** layer: Massey, Sagarin, and
Sasser. It is a source reference, not a performance claim. The verified
out-of-sample-style read for one NCAAF week stays in
`docs/research/sagarin-ncaaf-benchmark-2026-09-06.md`.

## Scope: shadow / benchmark only

These sources are **never wired into live `BET` eligibility**. Records attach to
candidate rows as additive context (`row.ratings`) and are scored for evaluation
only. The overlay changes zero ranking, tier, verdict, or score fields, and no
external probability becomes a live weight until chronological out-of-sample
evidence beats the de-vigged closing line. Fair & Oster found computer rankings
add no information on top of the Vegas spread, so the expected value here is
context and veto, not edge.

**Wiring status (as of 2026-09-15): the shadow overlay is built and tested but
has no production call site.** `applyRatingsOverlay` / `canonicalGameKey` are
required only by `test/ratings-overlay.test.js`; nothing in `lib/`, `scripts/`,
or `bin/` invokes them, so a live scan does not emit a `ratings` field today. The
rank-neutrality evidence is module-level (the two-run invariant test in
`test/ratings-overlay.test.js`), not a proven live-path result. A `ratings` key
is whitelisted into the feature snapshot in `lib/record-candidates.js`, so an
overlay run would survive into the ledger; connecting the overlay to a
production path remains explicit follow-up work. The snapshot store _is_ wired,
via `scripts/refresh-ratings.js` and the read-only `pp ratings` command.

## Module map

- `lib/ssb-ratings-contract.js` — the one normalized record shape and its
  fail-closed validation (`validateRatingRecord`).
- `lib/ratings-sources/massey.js`, `.../sagarin.js`, `.../sasser.js` — one pure
  adapter per source, each with an injected `fetchImpl` so no test path can reach
  the network.
- `lib/ssb-ratings-snapshot.js` — versioned, hash-carrying snapshots in the local
  state dir.
- `lib/ssb-ratings-overlay.js` — additive `applyRatingsOverlay`, composite join
  key.
- `lib/ssb-external-ratings-evaluation.js` — `evaluateRatingSources` (per-source,
  no blend) and `evaluateMarketRelative` (vs the de-vigged close).
- `scripts/refresh-ratings.js` — PP-free fetch + snapshot fan-out; `pp ratings`
  reads the snapshots back and never fetches.

## Per-source coverage

| Source  | Canonical leagues covered                          | Data shape                             | MLB?                                                                                    |
| ------- | -------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| Massey  | `NCAAF`, `NFL`, `NBA`, `NHL`, `MLB`, `MLS`, `WNBA` | Per-team ratings table (`Rat` primary) | Yes — the only source with MLB **team** ratings                                         |
| Sagarin | `NCAAF`, `NFL`, `NBA`, `NCAAB`, `NHL`, `MLS`       | Per-game predictions with totals       | **No** — the baseball page is _player_ ratings, so there is no team rating to normalize |
| Sasser  | `NCAAF` only                                       | Per-game projection overlay            | No                                                                                      |

CLI/frontend vocabulary `CFB`/`CBB` maps to the contract's canonical `NCAAF`/
`NCAAB`. Massey does publish a college-basketball page, but no NCAAB adapter or
alias is seeded, so NCAAB is a stated adapter scope gap rather than a half-wired
source. A league a source does not publish returns `coverage: 'unavailable'`
with a reason and is never fetched; an unsupported canonical league (names source
and sport) is kept distinct from an unrecognized code (a caller typo).

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
  same "derived-only, state-dir-only" rule applies to all three.
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

- Expect **CSV from the ratings page's More -> Export action**, not JSON; there
  is no documented free API. `fetchMassey` accepts an explicit `exportUrl` and
  invents no undocumented endpoint.
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

## Evaluation requirements

Score each source **independently** — never blend the three. Compare against the
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
