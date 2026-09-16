# External Ratings Benchmark Layer Implementation Plan

> **For Hermes:** Implement only after James approves this plan. Keep SSB traffic manual-only.
> Do not commit or push. The worktree carries unrelated WIP (`lib/soccer-event-identity.js`,
> `lib/ssb-espn-resolver.js`, `bin/pp-cli.js`, `lib/tennis-fallback.js`, venue-order files) —
> stage only the files this plan creates or modifies.

**Goal:** Generalize the existing Sagarin-only benchmark adapter into one source-agnostic external-ratings layer (Massey, Sagarin, Sasser) that records dated snapshots, attaches them to candidate rows as shadow context, and evaluates each source independently against the closing market — without ever changing live ranking, tier, or verdict.

**Architecture:** One normalized record contract, N pure source adapters with injected fetch, versioned snapshots in the local state dir (never the repo), one additive shadow overlay, and one evaluation module that scores each source on its own. This mirrors the removed tennis-Elo shadow overlay (`7f4780b`) but drops the two things that killed it: bundled third-party data and a second mutable calibration file. Snapshots live under `~/.ssb-for-agents/ratings/`; evaluation reads the existing v2 ledger.

**Tech Stack:** Node.js CommonJS, native `node:test` (`npm test` = `node --test --test-concurrency=1 test/*.test.js`), ESLint, Prettier, `tsc` check mode.

---

## Non-negotiable constraints

- No startup prewarm, no scheduled polling, no watcher. Ratings refresh never calls PropProfessor, so it lands in the same schedulable category as `scripts/resolve-outcomes.js --espn` and `scripts/refresh-tennis-circuit.js`. Nothing that calls PP may be scheduled.
- No third-party dataset committed to the repo. Massey's terms reserve all rights. Store normalized derived fields plus a source hash; keep raw payloads, if kept at all, in the local state dir.
- Fail closed. Missing, stale, ambiguous, or unmatched ratings become `unavailable` / `unresolved`, never a guessed team or a backfilled value.
- Shadow only. Ratings must not alter `kaiCall`, `displayTier`, `confidenceTier`, `finalVerdict`, `consensusEdge`, `screenScore`, or `riskScore`.
- No promotion of external probabilities into a live weight before chronological out-of-sample evidence beats the de-vigged closing line.
- `lib/sagarin-external-evaluation.js` and `test/sagarin-evaluation.test.js` stay green throughout; generalize by extraction, not by deletion.

---

## Phase 0: Contract and snapshot store

### Task 1: Define the normalized rating record contract

**Objective:** One shape every source normalizes to, so nothing downstream knows which source it is.

**Files:**

- Create: `lib/ssb-ratings-contract.js`
- Test: `test/ratings-contract.test.js`

**Behavior:**

```js
// A normalized record. Unknown/unsupported -> explicit coverage, never a guess.
{
  source: 'massey' | 'sagarin' | 'sasser',
  method: string,            // e.g. 'overall', 'predictor', 'golden_mean', 'model_v1'
  league: string,            // canonical: 'NCAAF' | 'NFL' | 'MLB' | 'NBA' | 'NHL' | ...
  season: number,
  asOf: string,              // the source's own "through games of" date, ISO
  fetchedAt: string,         // our retrieval time, ISO (distinct from asOf)
  sourceUrl: string,
  sourceHash: string,        // sha256 of the raw payload
  eventId: string | null,    // null when only team ratings are published
  teamA: string, teamB: string,
  neutral: boolean | null,
  ratingA: number | null, ratingB: number | null,
  predictedScoreA: number | null, predictedScoreB: number | null,
  predictedTotal: number | null, predictedMargin: number | null,
  homeAdvantage: number | null,
  marketOpen: number | null, marketCurrent: number | null,
  coverage: 'full' | 'partial' | 'unavailable',
  matchStatus: 'matched' | 'unmatched' | 'unresolved',
  unresolvedReason: string | null
}
```

**Step 1:** Write failing test — a valid record passes `validateRatingRecord`; a record missing `sourceUrl` or `sourceHash` fails; a record with `asOf` but no `fetchedAt` fails; a non-finite `ratingA` is coerced to `null` and forces `coverage: 'partial'`.

**Step 2:** Run: `node --test test/ratings-contract.test.js` — expected FAIL (module missing).

**Step 3:** Implement `validateRatingRecord(record)` returning `{ ok, record, errors }`, plus `SOURCES` and `supportedLeagues(source)`. No network, no I/O.

**Step 4:** Run again — expected PASS.

**Step 5:** `npx prettier --write lib/ssb-ratings-contract.js test/ratings-contract.test.js && npm run lint`

### Task 2: Snapshot store in the local state dir

**Objective:** Versioned, hash-carrying snapshots outside the repo.

**Files:**

- Create: `lib/ssb-ratings-snapshot.js`
- Test: `test/ratings-snapshot.test.js`

**Behavior:**

- Directory: `process.env.SSB_RATINGS_DIR || path.join(os.homedir(), '.ssb-for-agents', 'ratings')`, read through `resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR')` — the repo-wide state-dir override convention, with the pre-rename `PP_` spelling kept as a deprecated fallback (`SSB_` wins when both are set; same shape as the older `PP_RECORD_LEDGER` / `PP_SIGNAL_CALIBRATION_FILE` survivors).
- File name: `<source>-<league>-<season>.json` holding `{ schemaVersion: 1, source, league, season, method, asOf, fetchedAt, sourceUrl, sourceHash, records: [...] }`.
- `saveSnapshot`, `loadSnapshot(source, league, season)`, `listSnapshots()`.
- **Never** write into the repo. Tests point `PP_RATINGS_DIR` at a `mkdtemp` path and restore it in `finally` (deliberately exercising the deprecated alias; the canonical `SSB_RATINGS_DIR` is cleared in the same setup so it cannot decide the path).

**Step 1:** Failing test — save then load round-trips; a stale `asOf` older than a supplied cutoff is returned with `stale: true` rather than silently accepted; a snapshot whose `sourceHash` does not match its records is rejected.

**Step 2:** Run: `node --test test/ratings-snapshot.test.js` — expected FAIL.

**Step 3:** Implement the store. No network.

**Step 4:** Run again — expected PASS.

### Task 3: Team alias canonicalizer for cross-source joins

**Objective:** Match `Ohio St` (Massey), `Ohio State` (Sagarin), and `Ohio State` (Sasser) to one key.

**Files:**

- Create: `lib/ssb-ratings-team-aliases.js`
- Test: `test/ratings-team-aliases.test.js`
- Inspect only: `lib/ssb-espn-resolver.js` (alias source), `lib/ssb-venue-order.js` (untracked WIP — read, do not modify).

**Step 1:** Failing test — case/whitespace/punctuation-insensitive match; `St`/`State` suffix equivalence; ambiguous abbreviations return `null` rather than a best guess; unknown team returns `null`.

**Step 2:** Run: `node --test test/ratings-team-aliases.test.js` — expected FAIL.

**Step 3:** Implement `canonicalTeam(name, league)` reusing the ESPN resolver alias table where it exists, plus a small per-source abbreviation map.

**Step 4:** Run again — expected PASS.

---

## Phase 1: Sagarin adapter (generalize the existing module)

### Task 4: Extract shared evaluation, keep the Sagarin module green

**Objective:** Move the generic normalize/score/segment machinery out of the Sagarin-specific module without breaking `test/sagarin-evaluation.test.js`.

**Files:**

- Create: `lib/ssb-external-ratings-evaluation.js`
- Modify: `lib/sagarin-external-evaluation.js` (delegate; keep the same exports and behavior)
- Test: `test/sagarin-evaluation.test.js` (must stay green, unchanged)

**Step 1:** Run `node --test test/sagarin-evaluation.test.js` — record the passing baseline (7 tests).

**Step 2:** Extract `normalizeEvaluationRows(rows, { segments })`, `scoreRatingRows`, `segmentRatingRows` into the new module. `sagarin-external-evaluation.js` becomes thin delegations with `segments: ['segment']` and the FBS/FCS segment resolver.

**Step 3:** Run `node --test test/sagarin-evaluation.test.js` — expected PASS, unchanged count.

### Task 5: Sagarin fetch + parse adapter

**Objective:** Parse Sagarin's legacy fixed-width HTML into contract records.

**Files:**

- Create: `lib/ratings-sources/sagarin.js`
- Test: `test/ratings-sagarin-source.test.js`

**Behavior:**

- `fetchSagarin({ league, fetchImpl })` returns `{ raw, sourceUrl, fetchedAt }`. URLs: CFB `cfsend.htm`, NFL `nflsend.htm`, NBA `nbasend.htm`, CBB `cbsend.htm`, NHL `nhlsend.htm`, MLS `soccer.htm`.
- `normalizeSagarin({ raw, league, fetchedAt })` returns contract records.
- Parse the **heading date** (the "through games of ..." line) into `asOf` **separately** from `fetchedAt`; the benchmark doc proved they diverge (heading said Aug 29 while rows were the Sep 3-6 slate).
- Preserve `method` (`overall` / `predictor` / `golden_mean` / `recent`); the regular block and the experimental home-away block are stored as different methods, never merged.
- **MLB is unsupported** — `supportedLeagues('sagarin')` excludes MLB and returns a clear reason; Sagarin's baseball page is player ratings.

**Step 1:** Failing test with a small fixture of the fixed-width block — asserts `asOf` from the heading differs from `fetchedAt`, method split is preserved, a garbage line is skipped without throwing, and `league: 'MLB'` returns `coverage: 'unavailable'` with a reason.

**Step 2:** Run: `node --test test/ratings-sagarin-source.test.js` — expected FAIL. Injected `fetchImpl` only; no live call.

### Task 6: Record the Sagarin snapshot with the verified benchmark

**Objective:** Turn `docs/research/sagarin-ncaaf-benchmark-2026-09-06.md`'s one-week result into a re-runnable fixture.

**Files:**

- Create: `test/fixtures/ratings/sagarin-ncaaf-2026-w2.json`
- Test: `test/ratings-sagarin-source.test.js` (extend)

**Step 1:** Failing test — feeding the fixture through the adapter and the Phase-4 evaluation module reproduces the benchmark doc's numbers (90 matched of 118, 81 correct, 28 unmatched) with `unmatched` excluded from the denominator.

**Step 2:** Run — expected FAIL until the fixture exists.

**Step 3:** Build the fixture from the benchmark doc's verified values.

---

## Phase 2: Massey adapter

### Task 7: Massey fetch + parse adapter

**Objective:** Parse Massey's per-sport export into contract records.

**Files:**

- Create: `lib/ratings-sources/massey.js`
- Test: `test/ratings-massey-source.test.js`

**Behavior:**

- Sports: CFB, NFL, NBA, NHL, MLB, MLS, WNBA (Massey is the only one of the three with MLB team ratings).
- Massey exposes an **Export to CSV** action per ratings page (`/cf/fbs/ratings` -> More -> Export) and documents its game-data CSV format at `scorehelp.htm`. Expect CSV, not JSON; no documented free API.
- Map `Rat`, `Pwr`, `Off`, `Def`, `HFA`, `SoS` -> contract fields. Keep `Rat` as the primary `ratingA/ratingB`; keep the rest only if a downstream consumer needs them (YAGNI until then).
- Abbreviations differ from Sagarin (`Ohio St`, `Hawai'i`) — route through Task 3's canonicalizer.

**Step 1:** Failing test from a small CSV fixture — asserts field mapping, `asOf` from the page's "Using games thru" line, and that a header-only CSV yields `coverage: 'unavailable'` rather than empty-success.

**Step 2:** Run: `node --test test/ratings-massey-source.test.js` — expected FAIL.

### Task 8: Massey per-sport coverage map

**Objective:** Fail loudly per sport instead of silently returning nothing.

**Files:**

- Modify: `lib/ratings-sources/massey.js`
- Test: `test/ratings-massey-source.test.js` (extend)

**Step 1:** Failing test — a league Massey does not publish returns `coverage: 'unavailable'` with the unsupported reason, not an empty `records: []` that looks like a quiet day.

---

## Phase 3: Sasser adapter

### Task 9: Sasser CFB adapter

**Objective:** Parse `davidsasser.com/cfb` into contract records.

**Files:**

- Create: `lib/ratings-sources/sasser.js`
- Test: `test/ratings-sasser-source.test.js`

**Behavior:**

- **CFB only.** `supportedLeagues('sasser') === ['NCAAF']`; everything else is `unavailable` with a reason.
- The page publishes, per game: both projected scores, the opening line, the current line, a projected line, and the model pick, plus a header record (straight-up and ATS record) and an "Updated ..." timestamp.
- Map to `predictedScoreA/B`, `predictedTotal`, `predictedMargin`, `marketOpen`, `marketCurrent`. `fetchedAt` from our clock; `asOf` from the page's "Updated" line.
- This is a per-game projection overlay, not a rating; set `ratingA/ratingB: null` and `coverage: 'partial'` by design.

**Step 1:** Failing test from a static HTML fixture — asserts the model record is captured, `asOf` comes from the "Updated" line, and a non-CFB league returns `unavailable`.

**Step 2:** Run: `node --test test/ratings-sasser-source.test.js` — expected FAIL.

---

## Phase 4: Shadow overlay

### Task 10: Additive overlay onto candidate rows

**Objective:** Attach ratings to candidate rows and feature snapshots without touching the ranking path.

**Files:**

- Create: `lib/ssb-ratings-overlay.js`
- Test: `test/ratings-overlay.test.js`
- Inspect only: `lib/record-candidates.js` (`buildFeatureSnapshot`, around line 87)

**Behavior:**

- Join key is the **composite** `(league, canonical game identity, market)`, case-normalized on every segment — the removed Elo overlay's documented lesson was that a name-only join bleeds one game's context onto another.
- Attach `row.ratings = { <source>: entry }`, one key per entry in the contract's `SOURCES` (each `null` when unavailable).
- **Only add.** Never clobber a pre-existing `row.ratings`.
- Add one whitelist line to the feature snapshot so it survives into the ledger.
- Invariant proof: two-run baseline (same fixture, with vs without the overlay) — assert `kaiCall`, `displayTier`, `confidenceTier`, `finalVerdict`, `consensusEdge`, `screenScore`, `riskScore` are **identical**; only `ratings` differs.

**Step 1:** Failing test — same-team-name-two-games bleed scenario (assert `row.ratings.sagarin.game === row.game`), a pre-attached `row.ratings` is not clobbered, and the non-overlay invariants hold.

**Step 2:** Run: `node --test test/ratings-overlay.test.js` — expected FAIL.

---

## Phase 5: Evaluation and the market-relative gate

### Task 11: Per-source evaluation

**Objective:** Score each source on its own, with no composite blend.

**Files:**

- Modify: `lib/ssb-external-ratings-evaluation.js`
- Test: `test/external-ratings-evaluation.test.js`

**Behavior:**

- Reuse `scoreEvaluationRows` (Brier, log loss, reliability) and `segmentEvaluationRows`, which the Sagarin adapter already delegates to.
- Segment dimensions: `league`, `level` (FBS/FCS), favorite band, `market`.
- `unresolved` and `unmatched` rows stay out of every denominator (already the Sagarin contract).
- Report `coverage` and sample size before any score.

**Step 1:** Failing test — a two-source fixture scored independently yields separate score blocks; a source with zero resolved rows reports sample 0 and no score, not a fabricated 0.5.

### Task 12: Market-relative comparison

**Objective:** The gate that decides whether a source is worth anything.

**Files:**

- Modify: `lib/ssb-external-ratings-evaluation.js`
- Test: `test/external-ratings-evaluation.test.js` (extend)

**Behavior:**

- Compare each source's probability against the **de-vigged closing line**, not raw odds. Output CLV, ROI, and drawdown alongside Brier/log loss.
- Chronological split only; no random shuffle. Flag `insufficient_sample` below the threshold rather than reporting a number.
- Restate the honest baseline in the output: Fair & Oster found computer rankings add no information on top of the Vegas spread, so the expected value here is context and veto, not edge.

**Step 1:** Failing test — a source that is accurate but loses to the close is reported as such; a source under the sample threshold returns `insufficient_sample` instead of an ROI.

---

## Phase 6: CLI, docs, verification

### Task 13: Refresh CLI (PP-free, schedulable)

**Objective:** Fetch and snapshot without any PropProfessor traffic.

**Files:**

- Create: `scripts/refresh-ratings.js`
- Test: `test/refresh-ratings.test.js`
- Modify: `bin/pp-cli.js` (add a `ratings` command — **this file has unrelated WIP; add only the dispatch case and its handler, do not reformat**)

**Behavior:**

```bash
node scripts/refresh-ratings.js --source massey,sagarin,sasser --league NCAAF
node bin/pp-cli.js ratings --source sagarin --league CFB --show   # read snapshots, no fetch
```

- Aggregates per source/league; a source that fails does not abort the others.
- Prints a summary: source, league, asOf, fetchedAt, record count, coverage. Never prints raw payloads or secrets.
- No PP client import anywhere in this path — assert that in a test by reading the source file.

**Step 1:** Failing test — `--source` fan-out calls each adapter's injected fetch once; one throwing adapter yields a partial-success summary; the module does not require `lib/ssb-api.js`.

### Task 14: Docs

**Files:**

- Modify: `docs/BACKTESTING.md` (extend "External-model benchmark adapters" to cover the three sources)
- Modify: `docs/STATUS.md` (add the layer to Shipped and to Next evidence gates)
- Create: `docs/research/external-ratings-sources-2026-09.md` (per-source coverage, licenses, parse caveats)

**Behavior:** Document that ratings are shadow/benchmark only, which sports each source covers, and the MLB gap in Sagarin.

### Task 15: Verification

Run, in order:

```bash
node --test test/ratings-contract.test.js test/ratings-snapshot.test.js test/ratings-team-aliases.test.js test/ratings-sagarin-source.test.js test/ratings-massey-source.test.js test/ratings-sasser-source.test.js test/external-ratings-evaluation.test.js test/ratings-overlay.test.js test/refresh-ratings.test.js test/sagarin-evaluation.test.js
npm test
npm run lint
npm run check:types
npm run check:circular
npm run check:claims:quick
npm run check:secrets
```

Then one bounded manual refresh against live sources (`node scripts/refresh-ratings.js --source sagarin --league NCAAF`) and one bounded `pp scan` diff to confirm the overlay changed nothing in the play output. Report upstream source degradation separately from local results. Do not commit or push.

---

## Acceptance criteria

- One normalized contract; three adapters that each normalize into it and nothing else.
- Sagarin's `asOf` heading date is stored separately from our fetch time.
- Sagarin MLB, and Sasser for every league except NCAAF, report `unavailable` with a reason rather than empty success.
- Snapshots land in `~/.ssb-for-agents/ratings/`; no third-party dataset is added to the repo.
- Ratings attach to candidate rows and feature snapshots and change **zero** ranking, tier, or verdict fields (two-run invariant proven).
- Each source is scored independently against the de-vigged close, with sample and coverage shown before any score.
- `test/sagarin-evaluation.test.js` still passes, unchanged.
- Nothing in the refresh path calls PropProfessor, and no schedule is added.
- `npm test`, `lint`, `check:types`, `check:circular`, `check:claims:quick`, `check:secrets` pass, or failures are reported honestly.

## Out of scope

- Any change to `kaiCall`, tiers, verdicts, `consensusEdge`, `scoreEvaluationRows` weighting, or the v2 ledger schema.
- Blending the three sources into a composite rating.
- Promoted basketball/hockey/soccer models or totals/handicap rating models.
- Any cron, watcher, or startup prewarm.
- Committing or publishing.
