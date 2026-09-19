# Can an independent MLB model beat the closing line?

**Date:** 2026-09-18
**Verdict: NO.** A model built on the public information available from ESPN's free API
(team run differential, starting pitcher, home field) does **not** beat the closing line.
It loses the vig. Measured over three full seasons, pooled out-of-sample, the edge is
**+0.16 points with z = 0.24** — indistinguishable from zero.

This was not the answer the first two runs of this backtest produced. Both of those runs
were wrong, and _how_ they were wrong is the most useful thing in this document.

---

## Why this was attempted

The scan had no edge and could never have had one: it de-vigged public prices and compared
them to public prices. That is circular by construction. The only path to an edge that does
not require private information is a model whose inputs are **independent of the price it is
compared against** — a real estimate of team and pitcher quality.

So: build one, and test it honestly.

## Data

- **Source:** ESPN's public API (no key). Scoreboard for teams/scores/probable starters;
  the core odds resource for **open and close moneylines**.
- **Coverage:** 2023, 2024, 2025 — **7,147 games** with usable open+close prices
  (2,278 / 2,318 / 2,280 after requiring both teams to have 10+ prior games).
- **Sanity-checked:** the market is well calibrated on this data (implied 0.547 -> actual
  0.531 in the 0.5-0.6 bucket, and calibrated in every other bucket), and blindly backing the
  favourite in every game returns **-6.39% ROI** over 6,876 bets, exactly the vig. The prices
  and the P&L arithmetic are correct. `npm run team:validate --league mlb` prints this check
  itself, so the verdict is self-validating.

## Method

- **Model:** Bill James log5 on Pythagorean team strength (runs scored/allowed, exponent
  1.83) + a starting-pitcher term + a home-field constant. Two fitted coefficients.
- **Walk-forward only.** A game may use only information knowable before first pitch.
- **Fit on one full season, evaluate on the others.** Every one of the six ordered season
  pairs. A single in-season split shares a market regime with itself; a different season
  does not.
- **Benchmark:** the de-vigged closing line. The bar is not "does it win money", it is
  "is it better than the price", which is a far harder bar.

---

## Leak #1 — end-of-season team strength (fabricated +11% ROI)

The first run reported **60.9% winners, +11.10% ROI, +3.5% CLV**. That is not a plausible
result for a Pythagorean model and it was not real.

`strength()` read live team state. Rows stored a _reference_ to the game object, and the
team-state map is only fully populated _after_ the loop — so every "prediction" was scored
against **end-of-season** team strength. The model was reading October's numbers in April.

Fix: snapshot strength onto the row at prediction time, before recording the game's result.
There is now a test asserting the first game of a season has `homeStrength === null` and
that a later game reflects only prior games.

## Leak #2 — ESPN serves the season-final ERA retroactively (fabricated +4.8% ROI)

After fixing leak #1 the result was still implausible: **+4.76pts edge, z = 7.75,
+4.83% ROI**, stable across all three seasons and monotone in the conviction threshold.
The placebo control was clean — zero-information models with matched spread gave ~0 edge and
-1% to -6% ROI — so the selection procedure was not the artifact.

The ablation gave it away:

| model                          | edge         | z        | ROI         |
| ------------------------------ | ------------ | -------- | ----------- |
| full                           | +4.76pts     | 7.75     | +4.83%      |
| **strength only (no starter)** | **+0.16pts** | **0.24** | **-4.37%**  |
| **starter only (no strength)** | **+6.62pts** | **9.95** | **+10.46%** |

The entire edge came from the starting-pitcher term. No model built on starting-pitcher ERA
beats an MLB closing line by 6.6 points.

**Root cause:** ESPN attaches the pitcher's **season-final ERA** to every game he started,
all season long. Verified across 705 pitcher-seasons:

- **705 showed an identical ERA on every start of the season. 0 varied.**
- Miles Mikolas: 36 starts, 2023-03-30 through 2023-10-01, every single one `4.78`.
- Gerrit Cole 2023: every start `2.63`.

On April 1 the model knew how the pitcher would perform through October.

Fix: the collector no longer stores the ERA at all (only the starter's ID), and the model
builds its starter signal from **this dataset** — runs allowed by his team in his prior
starts, knowable at first pitch. A test asserts the leaking field never reaches a row.

---

## Bug #3 — a lost-update race in the collector (silently dropped 2,463 games to 403)

Found by re-running the collector against a warm cache and getting a completely different
game count than the cold run.

```js
games = games.concat(await fetchDay(d)); // WRONG
```

JS evaluates the member expression `games` **before** the argument list, so the `await`
happens with the array reference already captured. Six concurrent workers each concat onto a
stale array and the last write wins. With a cold cache the fetches are slow enough that the
loss is small and easy to miss; with a warm cache the reads resolve in the same tick and the
loss is catastrophic.

Fix: each worker stores its own result and the accumulation happens once, after the pool
drains.

```js
const byDate = new Map();
await pool(dates, CONCURRENCY, async (d) => {
  byDate.set(d, await fetchDay(d));
});
const games = dates.flatMap((d) => byDate.get(d) || []);
```

The lesson generalises: **never accumulate into a shared binding from inside a concurrent
worker.** Mutating a shared _object_ is fine (the odds loop does that); reassigning a shared
_binding_ is not.

---

## The honest result

With both leaks closed, coefficients fit on one season and applied untouched to the others:

| holdout season | edge     | z     | ROI        |
| -------------- | -------- | ----- | ---------- |
| 2023           | +0.62pts | 0.53  | **-2.06%** |
| 2024           | +0.15pts | 0.13  | **-5.73%** |
| 2025           | -0.28pts | -0.24 | **-5.26%** |

Pooled out-of-sample, all six season pairs, at closing prices with real vig. Two benchmarks,
because they answer different questions:

| threshold | bets   | hit   | vs RAW price | z     | vs DE-VIGGED | z    | ROI        | CLV    |
| --------- | ------ | ----- | ------------ | ----- | ------------ | ---- | ---------- | ------ |
| 0.02      | 11,137 | 51.2% | -1.12pts     | -2.36 | +0.97pts     | 2.04 | **-2.10%** | -0.93% |
| 0.03      | 9,879  | 51.0% | -1.29pts     | -2.57 | +0.80pts     | 1.58 | **-2.62%** | -1.00% |
| 0.04      | 8,714  | 50.9% | -1.41pts     | -2.63 | +0.68pts     | 1.26 | **-2.98%** | -1.10% |
| 0.05      | 7,602  | 50.7% | -1.64pts     | -2.87 | +0.44pts     | 0.77 | **-3.48%** | -1.20% |
| 0.07      | 5,643  | 50.6% | -1.93pts     | -2.90 | +0.16pts     | 0.24 | **-4.37%** | -1.44% |

**Read the two edge columns carefully, because this is where a weaker analysis would have
declared victory.**

- Against the **raw price** the model loses (-1.1 to -1.9pts, z = -2.4 to -2.9). That is what
  you are actually paid against.
- Against the **de-vigged** market it is faintly positive at the widest threshold
  (+0.97pts, z = 2.04). A careless reading calls that significant.

**It still loses money.** The edge (+0.97pts at best) is _smaller than the vig_ (~2.2pts),
so ROI stays negative at every threshold. And the pattern is backwards for a real edge: it
**shrinks** as conviction rises (+0.97 -> +0.16pts), where a genuine edge should grow. The
CLV is negative throughout, meaning the line moves _against_ the model's picks. The ROI of
-4.37% at edge>0.07 is the market's hold, which is exactly what a strategy with zero
information returns.

Other checks:

- Bootstrap (2,000 resamples): **0.0% of samples profitable.** Median ROI -4.99%.
- Ablation: the starter term adds nothing — strength-only is identical to the full model.
- Calibration: the model is **worse** than the market on both Brier and log loss in
  **all six** season pairs (+0.007 to +0.009 Brier).
- The market on the model's own picks: perfectly calibrated on the games it does _not_ pick
  (-0.031pts) and miscalibrated only where the model disagrees — the signature of a model
  selecting on its own noise.

### The control that makes it unambiguous

Placebo models with the **same disagreement spread but zero information** (`p = market +
noise`), three independent draws:

| model          | vs RAW                 | vs DE-VIG             | ROI        |
| -------------- | ---------------------- | --------------------- | ---------- |
| placebo draw 1 | -2.72pts (z=-4.36)     | -0.64pts (z=-1.03)    | **-5.79%** |
| placebo draw 2 | -1.54pts (z=-2.48)     | +0.54pts (z=0.86)     | **-2.58%** |
| placebo draw 3 | -3.38pts (z=-5.41)     | -1.30pts (z=-2.08)    | **-6.31%** |
| **real model** | **-1.93pts (z=-2.90)** | **+0.16pts (z=0.24)** | **-4.37%** |

**The real model sits in the middle of the zero-information range on every metric.** Its
de-vigged edge (+0.16pts) is indistinguishable from noise, and its ROI (-4.37%) is between
the placebo draws' -2.58% and -6.31%. That is the whole finding stated as plainly as it can
be: this model performs exactly like a model with no information, because that is what it is.

## What would have to be true for this to work

1. **The inputs would have to be better than the market's.** Team run differential and a
   crude starter proxy are strictly _less_ information than a bookmaker's model. Losing to
   the close is the expected outcome, not a failure of effort.
2. **The inputs would have to be unavailable to the market, or available earlier.** This
   data is public, free, and old.
3. **The bar is the closing line, not the opening line.** The close is where the market's
   information has fully arrived. Beating the open is common and mostly means nothing.

## Limitations of this test (stated plainly)

- The starter signal is a proxy: runs allowed by his _team_ in his starts, which includes
  bullpen and defence. A model with genuine as-of-date pitcher quality (xFIP, K/BB, pitch
  counts) was **not** tested, because ESPN's free API serves that data retroactively and
  there is no clean walk-forward source wired up.
- The benchmark is **ESPN BET's** close (a retail book, ~4.4% hold), not Pinnacle's. A soft
  close is an easier bar than a sharp one, and the model still failed it.
- Moneylines only. Totals, run lines, and player props were not tested.

## Bottom line

The market prices this information. A retail model built on free public data loses the vig,
and the two runs of this backtest that said otherwise were both data leaks. **The honest
answer to "can the repo pick winners?" is no — not from public inputs.**

What the repo gained is the machinery to answer that question rigorously for any future
idea: walk-forward feature construction, cross-season validation, a placebo control, and
tests that make the two leaks impossible to reintroduce.
