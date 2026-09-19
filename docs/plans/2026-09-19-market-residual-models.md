# MLB + NCAAF Market-Residual Models Implementation Plan

> **For Hermes:** Use subagents for source/schema research and skeptical review. Implement locally only after verifying each data contract. Do not claim profitability unless every gate below passes.

**Goal:** Build leakage-safe MLB and NCAAF models that test whether genuinely richer, timestamp-safe inputs improve the closing market, then shadow-test any surviving signal against future closing prices.

**Architecture:** The sportsbook market is the baseline, not a competitor feature to discard. Each model predicts the market's residual error from information the old points-only models did not use. Research evaluates `market prediction + predicted residual` against the actual result on held-out seasons; deployment applies the correction to the current line and measures prospective CLV before any betting use.

**Tech stack:** Node.js 20 (`node:test`) for reusable model code and validators; DuckDB CLI for bounded parquet aggregation; cfbfastR parquet for NCAAF; Baseball Savant + MLB Stats API for MLB; existing ESPN odds JSON for prices/outcomes.

---

## Non-negotiable data rules

1. Every feature is snapshotted before the game. A game never updates its own feature row.
2. Games on the same date/time bucket cannot train one another.
3. No season-final or retroactively rewritten player statistics.
4. Closing lines may be used only as the research benchmark. Live predictions use the current line.
5. Every odds pair/line must preserve provider, market shape, side, and sign convention.
6. Each game appears once in every pooled test, bootstrap, and z-score.
7. Hyperparameters are selected inside the training seasons only.
8. Report every tested configuration. Never report only the best threshold.

## Hard evidence gates

A model is **research-only / NO-GO** unless all applicable gates pass:

- Improves the closing line's held-out MAE/Brier in at least 4 of 5 NCAAF seasons or 2 of 3 MLB seasons.
- Pooled improvement has a game-clustered 95% bootstrap interval entirely better than zero.
- Betting edge grows monotonically with model conviction.
- Held-out ROI is positive after actual quoted vig, with a clustered 95% interval not materially below zero.
- No single season supplies more than 50% of total profit.
- Prospective shadow picks produce positive median CLV before live model use.
- Placebo features with matched disagreement spread do not reproduce the result.
- Multiple-testing correction covers every sport × feature family × threshold attempted.

## Phase 1: Shared residual model

### Task 1: Define and test the residual contract

**Files:**

- Create: `lib/market-residual-model.js`
- Create: `test/market-residual-model.test.js`

**Tests first:**

- A market-only prediction is unchanged when all feature coefficients are zero.
- Feature standardization uses training rows only.
- Ridge fitting recovers known synthetic coefficients.
- Constant/unknown features are ignored rather than divided by zero.
- Prediction never reads outcome, close, or future state fields from a feature object.
- A held-out season is never included in its own fit.

**Implementation:** Minimal ridge regression for small dense feature vectors, training-only standardization, prediction, MAE/Brier helpers, and grouped bootstrap. No generic ML framework or model registry.

**Verify:**

```bash
node --test test/market-residual-model.test.js
```

Expected: all tests pass.

### Task 2: Add market-baseline diagnostics

**Files:**

- Modify: `lib/market-residual-model.js`
- Modify: `test/market-residual-model.test.js`

Add baseline-vs-corrected MAE/Brier, calibration, threshold table, unique-game assertion, per-season contribution, placebo, and clustered bootstrap. Fail loudly on duplicate game IDs or an impossible two-way price sum.

## Phase 2: NCAAF play-by-play model

### Task 3: Build the NCAAF feature extractor

**Files:**

- Create: `lib/cfb-pbp-features.js` (pure chronological state/snapshot logic)
- Create: `test/cfb-pbp-features.test.js`
- Create: `scripts/cfb-pbp-features.js` (DuckDB/parquet orchestration only)

**Inputs:**

- `~/.ssb-for-agents/data/cfbfastR/play_by_play_2021.parquet` through `2025.parquet`
- `~/.ssb-for-agents/data/college-football-2021.json` through `2025.json`

**Verified contract:** 1,240,089 plays; 362 columns; 2025 has 1,657 games; direct cfbfastR `game_id` to ESPN `eventId` overlap is 849/850; cfbfastR and ESPN both use home-perspective spread (`+13.5` means home is a 13.5-point dog). Historical opening-spread coverage is 0/0/450/858/848 for 2021-2025. Team form resets at every season boundary to prevent stale college rosters from carrying forward, so the timestamp-safe opener test uses 2023-2025 only; 2021-2022 remain useful for extraction/data-contract validation, not residual-model training.

**Feature families, all prior-game only:**

- Offense and defense EPA/play.
- Offense and defense success rate.
- Explosive-play rate.
- Early-down EPA/play and success rate.
- Passing-down EPA/play.
- Sack/turnover/havoc rates. Sack rate uses explicit dropbacks (pass attempts + sacks), never total plays or passing-down plays.
- Finishing-drives points per scoring opportunity.
- Pace (scrimmage plays per non-garbage minute).
- Recent form via fixed exponential decay.
- Games observed and uncertainty indicators.

Use raw per-play `EPA` and `success`; do not use cumulative-looking `home_EPA`/`away_EPA` as pregame features. Exclude non-scrimmage plays and define garbage time from pre-play state only.

**Extractor tests:** first game has null prior features; second game sees only first-game plays; same-kickoff games cannot see each other; one synthetic game's feature totals match hand calculation; game IDs and spread signs survive the join.

### Task 4: Fit the NCAAF spread residual

**Files:**

- Create: `lib/cfb-residual-validation.js` (pure feature-vector, expanding-season, and bootstrap logic)
- Create: `test/cfb-residual-validation.test.js`
- Create: `scripts/cfb-pbp-validate.js`
- Modify: `package.json` (`cfb:pbp-features`, `cfb:pbp-validate`)

**Primary timestamp-safe target:** `actual home margin - opening home line`, using the stored opening line as the frozen historical decision-time baseline. Rows without a coherent opening line are excluded from the executable historical gate.

**Prediction:** `opening home line + predicted residual`. The closing line is a later diagnostic only: compare the corrected opening prediction with the close and measure whether the model points in the same direction as subsequent movement. A separate market-information diagnostic may compare rich features with the close, but it cannot support an executable ROI claim.

**Validation:** leave one full season out; nested selection of ridge penalty inside training seasons; compare corrected MAE to both the opening line and the later closing line; measure direction/size of open-to-close movement; cluster bootstrap by game and week; print coverage and exclusions by season. Historical ATS ROI is not claimed unless an exact timestamped line **and its corresponding price** are both present.

**Verify:**

```bash
npm run cfb:pbp-features
npm run cfb:pbp-validate
```

## Phase 3: MLB Statcast model

### Task 5: Build a bounded historical MLB feature collector

**Files:**

- Create: `scripts/mlb-statcast-collect.py`
- Create: `scripts/mlb-statcast-features.py`
- Create: `test/mlb-statcast-contract.test.js`

**Sources:** Baseball Savant pitch-level CSV in bounded date chunks; MLB Stats API game feed for game IDs, starting pitchers, lineups, and pitcher usage. Cache raw source files outside the repo under `~/.ssb-for-agents/data/statcast/`; never cache failed responses.

**Minimum prior-game features:**

- Team rolling xwOBA/contact quality and K/BB profile.
- Starting-pitcher rolling strikeout, walk, barrel, hard-hit and pitch-quality profile.
- Bullpen workload over 1/3/7 days and reliever availability proxy.
- Park fixed effects and schedule context.

Confirmed historical lineups and archived pre-first-pitch forecast weather are **not MVP dependencies**: the free completed-game feed exposes the realized lineup retroactively, and no reproducible 2023-2025 forecast-vintage archive was verified. Add either only after a timestamped pregame archive exists. No season ERA, current roster, current-season aggregate, realized lineup, or observed postgame weather may be backfilled onto old games.

### Task 6: Fit the MLB moneyline residual

**Files:**

- Create: `scripts/mlb-statcast-validate.js`
- Modify: `package.json` (`mlb:statcast-collect`, `mlb:statcast-validate`)

**Primary executable target:** outcome residual in log-odds space relative to the earliest timestamped two-way market snapshot. Fit only on prior games/seasons and evaluate profit only at that snapshot's exact prices. Because the verified ESPN archive has no MLB opening lines for 2023, 2023 cannot enter the executable historical price test unless another timestamped source is added.

**Secondary information diagnostic:** use the de-vigged closing moneyline as an offset to ask whether Statcast features add outcome information beyond the close. Compare corrected Brier/log loss to the closing market, but do **not** call that an executable backtest. Report calibration, placebo, grouped bootstrap, CLV where a real earlier quote exists, and per-season contribution.

## Phase 4: Prospective shadow gate

### Task 7: Add prediction snapshots without betting automation

**Files:**

- Create only after a historical gate passes: `scripts/residual-shadow.js`
- Reuse the existing ledger/capture format rather than inventing a second tracker.

Freeze decision-time features, current price, predicted fair probability/margin, and threshold. Later attach the close and outcome. No automatic wager placement and no frequent polling.

**Promotion rule:** Historical pass plus positive prospective median CLV on a meaningful chronological sample. Outcome ROI alone cannot promote the model.

## Final verification

```bash
npm run verify
npm run cfb:pbp-validate
npm run mlb:statcast-validate
```

The final report must list data coverage, every tested configuration, baseline and corrected scoring metrics, ROI with uncertainty, CLV, placebo results, and an explicit PASS/NO-GO. A negative verdict is valid; tuning until one number turns green is not.
