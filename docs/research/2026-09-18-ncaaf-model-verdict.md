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

---

# Part 2: the spread market (1.6x the data) — also no edge

The moneyline result was a near-miss, so the obvious next question was whether the **spread**
market — where ESPN carries prices for games that have no moneyline at all — behaves
differently. It reaches **4,784 priced games versus 3,025**, a 58% larger sample.

**It does not. The spread model has no edge, and the reason is stated more cleanly here than
anywhere else in this work.**

## The decisive check: is the model a better margin predictor than the line?

The line **is** a margin prediction. So before any betting simulation, compare mean absolute
error on the actual margin:

|                     | MAE               |
| ------------------- | ----------------- |
| model               | ~12.9 to 13.9     |
| **the line itself** | **~11.7 to 12.5** |

**The line beats the model on margin MAE in 20 of 20 season pairs, and the model beats it in 0.** It is worse by 0.7 to 1.4 points per game, consistently, in every direction.

That is a stronger and simpler statement than any ROI figure: a model that predicts margins
worse than the line already is cannot beat the line by thresholding, no matter where the
threshold is set.

## Betting results (pooled, all 20 season pairs, real prices)

| threshold | bets   | W-L-P         | hit   | ROI        | CLV (pts) |
| --------- | ------ | ------------- | ----- | ---------- | --------- |
| 1.0       | 10,930 | 5400-5386-144 | 50.1% | **-4.46%** | -0.60     |
| 2.0       | 9,294  | 4592-4581-121 | 50.1% | **-4.51%** | -0.69     |
| 3.0       | 7,849  | 3881-3878-90  | 50.0% | **-4.61%** | -0.76     |
| 4.0       | 6,443  | 3196-3183-64  | 50.1% | **-4.47%** | -0.83     |
| 5.0       | 5,233  | 2578-2602-53  | 49.8% | **-5.09%** | -0.92     |

**The hit rate is a coin flip at every threshold** — 49.8% to 50.1%, across ~8,000 bets. That
is the signature of a model with no information: it selects games where it disagrees with the
line, and lands on the right side of a 50/50 proposition exactly half the time.

- **Bootstrap: 0.0% of 2,000 resamples profitable.** Median ROI -5.10%.
- **CLV is negative (-0.60 to -0.92 points):** the line moves _against_ the model's picks.
- **Placebo:** zero-information draws return -5.44%, -8.79% and +1.29%. The real model's
  -4.61% sits inside that range.

## Verified, not assumed

Two things were checked before any of the above was trusted:

- **Spread sign convention.** ESPN reports a home-perspective spread, so `-37` means home is
  favoured by 37 and home must win by 37. Confirmed: home covers **49.1%** of games and the
  line correlates **0.620** with the actual margin. If this had been inverted, every result
  would have been silently reversed. `assertSpreadConvention` now enforces it.
- **Data sanity.** Backing the favourite against the spread returns **-2.57%** over 3,115
  bets. Negative and near the hold, as it must be.

**A bug worth recording:** the first extraction read `homeTeamOdds.open.spread`, which is the
**decimal price** (1.91 for -110), not the point line. The giveaway was CLV printing exactly
`0.00` at every threshold — plausible-looking values (1.91 -> 1.95) that silently destroyed
the metric. The line actually lives at `open.pointSpread.alternateDisplayValue`. After fixing
it, 1,869 of 2,864 games show a moved line with realistic values (`8.5 -> 7`, `-13 -> -16`).

## Part 2 bottom line

**No.** A coin-flip hit rate, -4.5% ROI, 0% bootstrap profitability, negative CLV, and — most
decisively — a model that predicts margins worse than the market's own line in every one of
20 season pairs.

## Part 3: totals (over/under) — same answer, and the closest of the four

The last market testable without new data: **4,363 CFB games already priced** for over/under,
no re-fetch needed. Same decisive check — the line _is_ a total prediction.

**Model beats the line on total MAE in 0 of 20 season pairs.** The line predicts totals better
than the model in every pair, consistently.

Data sanity is strong here: mean actual total **53.85** against a mean closing line of
**53.06**, and backing the OVER blindly returns **-4.03%** over 2,854 bets.

| threshold | bets  | O-U-P        | hit   | ROI        |
| --------- | ----- | ------------ | ----- | ---------- |
| 1.0       | 9,577 | 4899-4606-72 | 51.5% | **-1.67%** |
| 2.0       | 7,635 | 3891-3679-65 | 51.4% | **-1.96%** |
| 3.0       | 5,807 | 2955-2797-55 | 51.4% | **-2.01%** |
| 4.0       | 4,347 | 2199-2107-41 | 51.1% | **-2.55%** |
| 5.0       | 3,108 | 1559-1515-34 | 50.7% | **-3.21%** |

**Bootstrap: 0.0% of 2,000 resamples profitable.** Median ROI -2.81%. Placebo draws return
-3.60%, -6.27%, -6.06% — the model's -2.01% sits at the _better_ end of that range but is
still a loss.

This is the **least bad** of the four markets (51.4% hit rate, -1.7% to -3.2% ROI), which is
worth noting only because it is still not profitable: at typical -110 pricing you need 52.4%
to break even, and the model delivers 51.4%.

## Part 4: weather — an external input, and the clearest demonstration yet

The challenge was fair: I'd said "point me at a data source" when finding one is my job. So I
went and got one — free, no API key:

- **ESPN venue data** — city/state plus an `indoor` flag (100% coverage; 263 domes)
- **Open-Meteo geocoding** — city → lat/lon
- **Open-Meteo historical archive** — hourly temperature, wind speed/direction, precipitation,
  averaged over the game window rather than sampled at kickoff

**4,117 of 4,521 outdoor games got weather (91%)**, plus 263 indoor games marked as
weather-immune so a dome never receives outdoor conditions.

### The test, and why it's the right one

The question is NOT "does weather affect scoring" — it obviously does. The question is
**does adding weather get the model's error below the line's?** If the market already prices
wind and temperature, the feature is worth nothing to a bettor.

### 1. Weather is real

| condition      | n     | mean actual total |
| -------------- | ----- | ----------------- |
| windy (≥15mph) | 95    | **50.17**         |
| calm (<10mph)  | 2,017 | **54.05**         |
| cold (<45°F)   | 340   | **52.05**         |
| warm (≥65°F)   | 1,106 | **54.47**         |

Wind suppresses scoring by **3.88 points**; cold by **2.42 points**. Both are genuine,
physically sensible effects.

### 2. The market already prices it — and then some

The closing line sits at a mean of **49.14** on windy games versus **53.23** on calm ones.
That is a **4.09-point adjustment**, against a **3.88-point** real effect.

**The market's wind adjustment is slightly LARGER than the actual effect of wind.** It is not
merely priced; it is fully priced, if anything over-adjusted.

### 3. Adding weather never beats the line

|                | MAE                       |
| -------------- | ------------------------- |
| base model     | ~13.0                     |
| base + weather | ~13.0 (marginally better) |
| **the line**   | **~12.5**                 |

**Weather beats the line in 0 of 20 season pairs.** The base model also beats it in 0 of 20.
Weather improves the model by a few hundredths of a point and does not come close to closing
a ~0.5-point gap.

### Bottom line

Weather is a **real** signal that is **fully priced**. This is the cleanest demonstration of
the whole exercise's thesis, because it quantifies both sides: the true effect of wind is
**3.88 points** and the market's adjustment is **4.09 points**. There is nothing left to
capture.

The lesson generalises, and it is why hunting for more data sources is unlikely to help:
**the market's closing line is already an excellent model of the public information.** Finding
a public input it has missed is not a matter of looking harder.

_(Reproduce: `npm run weather:join` then `node scripts/weather-test.js`.)_

## Four markets, one answer

| market        | games | decisive check                                  | ROI              | bootstrap |
| ------------- | ----- | ----------------------------------------------- | ---------------- | --------- |
| MLB moneyline | 6,876 | worse than the market on Brier, 6/6             | -4.37%           | 0.0%      |
| CFB moneyline | 3,025 | de-vigged +1.45 to +1.89pts, but below the hold | -0.67% to -2.20% | 0.0%      |
| CFB spread    | 4,784 | worse than the line on margin MAE, 20/20        | -4.46% to -5.09% | 0.0%      |
| CFB totals    | 4,363 | worse than the line on total MAE, 20/20         | -1.67% to -3.21% | 0.0%      |

**Nothing is profitable, and the cause is identical every time: the market's own line
out-predicts the model on the same public inputs.** For the two line markets the test is
direct — the line's MAE beats the model's in 40 of 40 season pairs combined. That is not a
tuning problem; it is the market already containing the information.
