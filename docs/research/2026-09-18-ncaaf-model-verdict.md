# Can an independent college football model beat the closing line?

**Date:** 2026-09-18
**Verdict: NO — but this is the closest thing to a signal the work has produced, and it is
still not enough to pay.**

A model built on public team scoring data (Pythagorean strength, walk-forward) beats the
**raw** price by nothing (z ≈ 0) and loses money at every threshold (ROI -0.67% to -2.20%).
It does show a small edge against the **de-vigged** line (+1.45 to +1.89 points, z = 2.25 to
2.55) that sits above the zero-information placebo range — but that edge is **smaller than
the vig**, so it still returns a loss. 0.0% of 2,000 bootstrap resamples are profitable.

Compare with MLB (`2026-09-18-mlb-model-verdict.md`), where the same methodology found
nothing at all. College football is genuinely less efficient — just not less efficient enough.

---

## Data

- **Source:** ESPN public API. Same two endpoints as MLB; the odds path needs the `leagues/`
  segment (`/v2/sports/football/leagues/college-football/events/...`), which is easy to miss
  because omitting it returns 404 for _every_ league and looks like "this sport has no odds".
- **Coverage:** 2021-2025, **3,025 games** with usable open+close moneylines
  (232 / 476 / 741 / 807 / 769).
- **A real limitation: ESPN's odds archive is sparse for older seasons** — 24% of 2021 games,
  49% of 2022, 77-84% for 2023-2025. The scoreboards are complete (~965 games/season), so
  this is archive coverage, not a collection failure.
- **And the missing games are not a random sample.** Games with no odds average a
  **31.9-point** margin; games with odds average **15.5**. ESPN's archive omits the blowouts
  (FBS-vs-FCS mismatches). The test therefore covers the competitive slice of the slate —
  which is the slice you can actually bet, but it is not representative of all CFB games.
- **Sanity-checked:** market calibration is sound (implied 0.553 -> actual 0.530; 0.645 ->
  0.680; 0.746 -> 0.753) and backing the favourite in every game returns **-3.47%** over 1,682
  bets. Note this hold is _thinner_ than MLB's (-6.39%), which matters below.

## Method

Identical to the MLB test, so the two results are directly comparable:

- **Model:** log5 on Pythagorean team strength (points scored/allowed, exponent 2.37,
  minimum 3 prior games) + a fitted home-field constant. CFB carries **no starting-pitcher
  data** (0 of 807 games have a starter id), so the starter term is correctly inert.
- **Walk-forward only.** Every input is knowable before kickoff; features are snapshotted
  before the game's own result is recorded.
- **Fit on one season, evaluate on the others** — all 20 ordered season pairs.
- **Benchmark:** the de-vigged closing line, plus the raw price for reference.
- **Controls:** placebo (matched disagreement spread, zero information), bootstrap, ablation,
  and a printed data-sanity check.

---

## Results

**Calibration — the model is worse than the market, badly.** It loses on Brier score in
**0 of 20** season pairs, by +0.021 to +0.040. Its probabilities are far too spread out
(disagreement sd 18.8 points).

**Betting, pooled out-of-sample at closing prices:**

| threshold | bets  | hit   | vs RAW price | z     | vs DE-VIGGED | z    | ROI        | CLV    |
| --------- | ----- | ----- | ------------ | ----- | ------------ | ---- | ---------- | ------ |
| 0.02      | 6,013 | 46.3% | -0.45pts     | -0.70 | +1.45pts     | 2.25 | **-0.86%** | -0.79% |
| 0.03      | 5,683 | 46.0% | -0.25pts     | -0.38 | +1.63pts     | 2.47 | **-0.67%** | -0.93% |
| 0.04      | 5,364 | 45.8% | -0.15pts     | -0.21 | +1.71pts     | 2.53 | **-0.76%** | -1.08% |
| 0.05      | 5,046 | 45.2% | -0.24pts     | -0.35 | +1.59pts     | 2.28 | **-2.11%** | -1.16% |
| 0.07      | 4,470 | 44.9% | +0.08pts     | 0.11  | +1.89pts     | 2.55 | **-2.20%** | -1.44% |

**Read the two edge columns.** Against the raw price — what you are actually paid — the model
has **nothing** (z ≈ 0). Against the de-vigged line it is genuinely positive, and unlike MLB
this survives |z| > 2 at every threshold.

**It still loses money.** The edge (+1.9 points at best) is below the hold, so ROI is
negative at every threshold. The CLV is negative throughout: the line moves _against_ the
model's picks, which is the opposite of what a sharp model does.

**Bootstrap (2,000 resamples of the 4,470 picks):** 0.0% profitable. Median ROI -3.45%.

### The control

Placebo models with the same disagreement spread but zero information:

| model          | vs DE-VIG    | z        | ROI        |
| -------------- | ------------ | -------- | ---------- |
| placebo draw 1 | +1.44pts     | 1.97     | -3.40%     |
| placebo draw 2 | +0.82pts     | 1.12     | -5.38%     |
| placebo draw 3 | +0.69pts     | 0.94     | -3.98%     |
| **real model** | **+1.89pts** | **2.55** | **-2.20%** |

**This is the honest nuance.** The real model's de-vigged edge (+1.89pts) sits _above_ the
placebo range (+0.69 to +1.44) — so there is a trace of real signal here that MLB did not
have. But the placebo itself is not centred on zero either (its mean is +0.98), so part of
the apparent edge is still an artifact of selecting on disagreement. And every placebo still
loses 3-5%, exactly as a no-information strategy should.

**Ablation:** full model and strength-only are identical (+2.00pts, z=2.69, ROI -2.56%),
confirming the starter term is inert as expected for CFB.

---

## Bottom line

**No, this does not make money.** It loses 0.67% to 2.20% per bet depending on how selective
it is, and no bootstrap resample is profitable.

What makes CFB worth recording is that it is the _only_ market tested so far where a
public-data model shows a de-vigged edge that clears |z| = 2 and sits above the placebo. That
is a real, if small, inefficiency. It is simply not large enough to overcome the vig — and
the model is simultaneously _worse_ than the market at forecasting, which is a strange
combination that argues the "edge" is partly a selection artifact rather than genuine
forecasting skill.

To become profitable it would need roughly **double** the current de-vigged edge. Whether
better inputs (returning production, recruiting ratings, transfer-portal movement, pace and
weather) could supply that is untested. Given that MLB's version of this exercise found
nothing at all, the honest prior is that they would not.

## Reproducing

```bash
node scripts/sport-collect.js --sport football --league college-football \
  --start 2024-08-24 --end 2025-01-21
node scripts/team-validate.js --league college-football \
  --seasons 2021,2022,2023,2024,2025 --exponent 2.37 --min-games 3
```
