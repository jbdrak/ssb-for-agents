# Market-Residual Models: Final Verification Report (2026-09-19)

Plan: `docs/plans/2026-09-19-market-residual-models.md` (Tasks 1-6 complete; Task 7 shadow gate requires a historical pass).

## Verdict: NO-GO on both models — research-only, do not promote

Neither model clears the historical gates. Per the plan, a negative verdict is valid and tuning until green is not allowed. Task 7 (shadow snapshots) is NOT created — it is explicitly gated on a historical pass.

## NCAAF play-by-play spread residual (Tasks 3-4)

- Coverage: cfbfastR 2021-2025 (1,240,089 plays); opener test on 2023-2025 (2021-2022 lack historical opens).
- Join: 4,757 rows, 1,878 eligible; exclusions missing_opening_home_line=2,603, missing_core_matchup_features=276.
- Executable target: actual home margin minus opening home line; prediction = opener + predicted residual.
- MAE pooled: baseline 11.947, corrected 12.050, improvement -0.103. Seasons improved 0/2.
- Cluster bootstrap (game+week, 2000 iter): median -0.102, 95% CI [-0.212, +0.002], improved 2.7%.
- Placebo (matched spread): +0.020 / -0.067 / -0.140 — validator discriminates, model just loses.
- Closing diagnostic: closing MAE 11.793; model pointed with the move 51.4% of the time.
- `npm run cfb:pbp-validate` reproduces.

## MLB Statcast moneyline residual (Tasks 5-6)

- Coverage: Savant pitch CSV 2023-03-30 to 2025-11-01 (~1.5 GB raw, 131 chunks) + MLB Stats API schedules; 16,592 game-team feature rows.
- Join: eligible 3,976; exclusions missing_open=1,891 (all of 2023 — no archived opens, as the plan predicted), missing_statcast_rows=1,261, ambiguous_date_matchup=102, all_star=3.
- Testable seasons: effectively ONE (train 2024, test 2025). The plan's "2 of 3" gate is structurally unreachable with this archive — 2023 has no timestamped opens.
- Executable target: outcome residual vs de-vigged open; profit at the open's exact prices. Probability space (plan names log-odds, but true win prob is unobserved; documented in the script header).
- Brier/MAE pooled: baseline 0.4871, corrected 0.4880, improvement -0.0008. Seasons improved 0/1.
- Betting at open prices (every threshold): edge>0.02 ROI -3.84% (n=1590) / 0.03 -3.42% / 0.04 -3.06% / 0.05 -1.83% / 0.07 -5.22%. No monotonic conviction growth.
- CLV: model direction matched the close 48.2% (below coin flip).
- Cluster bootstrap (2000 iter): median -0.0008, 95% CI [-0.0037, +0.0022], improved 28.1%.
- Placebo: -0.0004 / -0.0007 / +0.0008 — null behaves like the model, as expected for no signal.
- `npm run mlb:statcast-validate` reproduces (flags: `--seasons`, `--bootstrap`).

## Every configuration tested

- CFB: ridge selected chronologically inside training seasons; pooled + per-season MAE; 3 placebo draws.
- MLB: same methodology; 5 edge thresholds (0.02-0.07) all reported; 3 placebo draws. No threshold cherry-picked.
- Shared: `lib/market-residual-model.js` (ridge, training-only standardization), `lib/cfb-residual-validation.js` (chronological selection, cluster bootstrap).

## Repo state

- `npm run verify`: green (tests, lint, circular deps, reachability, format).
- New: scripts/cfb-pbp-features.js, scripts/cfb-pbp-validate.js, scripts/mlb-statcast-collect.py, scripts/mlb-statcast-features.py, scripts/mlb-statcast-validate.js, lib/cfb-pbp-features.js, lib/cfb-residual-validation.js + tests.
- Data (outside repo): ~/.ssb-for-agents/data/statcast/ (raw CSVs, schedules, features.jsonl), cfbfastR parquets.

## Structural read

Two different sports, two genuinely richer feature sets (play-level EPA/havoc/pace; pitch-level xwOBA/starter/bullpen), same result: the market's own line out-predicts the residual model. Public-data team-strength modeling has no demonstrated edge here. Next attempts need inputs the market lacks (timestamped lineups, pregame forecast-vintage weather, softer books) — not more tuning on these features.
