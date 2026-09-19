# Project status and evaluation roadmap

SSB MCP is a manual-first research and recordkeeping tool. It discovers and ranks market signals; it is not presented as an already validated win-probability model.

## ⚠️ Measured verdict: the scan has no demonstrated edge

**This is a result, not a caveat.** The record loop was built specifically to answer "does
this produce a betting edge?", and it answered.

    closes measured        186 (deduped)
    beat the close         38/186 = 20.4%   95% CI 15.3-26.8%
    mean CLV               -0.94%

A better price than the closing line about **1 time in 5**, paying roughly **1% worse** on
average. The confidence interval does not come close to 50%. This is not "insufficient
sample" and not "direction only" — it is large enough to be a verdict.

**It got WORSE as the sample grew, which is the signature of an artifact rather than an
edge.** At 44 closes the read was 36.4% beat / -0.59% CLV; at 186 it is 20.4% / -0.94%.
A real edge does not decay as you collect more of it.

The system's own confidence labels are anti-predictive, consistently:

|                           | beat the close | mean CLV |
| ------------------------- | -------------- | -------- |
| TIER 1 (the "best" label) | 16.7%          | -1.41%   |
| TIER 2                    | 20.8%          | -0.88%   |

The top tier performs **worst**. Raising the signal-quality score also lowers the beat rate.
These labels carry no information.

### What was ruled out before concluding

- **The fair probability was re-anchored.** `marketFairProbability` averaged the de-vig
  across _all_ books — square prices included — which made EV a contaminated line-shopping
  test and, worse, circular (deriving an edge from the same book population being bet into).
  A sharp-anchored variant was built and recorded alongside it. The verdict held.
- **Execution was measured separately.** ~1% of payout was being left on the table on ~30%
  of candidates. Real, but worth ~0.3pp across a slate — it narrows the gap and does not
  close it.
- **The external literature agrees independently.** Weak-form efficiency studies find no
  significant long-term odds-only strategy, and a 14-season five-league study reproduced
  statistically significant "effects" in _simulated fully efficient markets_. See
  `docs/research/2026-09-18-profitable-strategies.md`.

### What follows — and what does NOT

**Do not re-tune the gate.** A filter cannot fix a signal with no information in it. The
gate already rejects essentially everything (`pp card --no-gate` to inspect), and that is
the correct output, not a bug.

**The supported lanes are narrow and neither is prediction:**

1. **Promotions.** Structurally +EV before any game is known — a profit boost is worth
   `S·(k−1)·(1−1/d)`. Small per offer, but the edge is arithmetic.
   **Tool: `npm run promo:card`** (hands it a `pp scan -j` capture plus the offer terms and
   returns the best qualifying card, ranked on devigged probability, with the ceiling
   stated up front).
2. **Cross-venue arbitrage.** The one documented prediction-free edge, and `npm run arbs`
   finds real ones: measured live at **4 opportunities across 1,248 rows, 0.46–0.82%**,
   including the predicted bookmaker-vs-**exchange** shape (Polymarket against a book).
   Capacity-limited; a detection is a CANDIDATE to verify at both venues, never a guarantee.

**Treat any future proposal to "improve the scan" as requiring out-of-sample evidence
first.** The measurement is the asset. It is worth more than the plays were.

## Shipped and reproducible

- Local v2 ledger for scans, immutable decision-time candidate features, reviewed official bets, and settlements.
- Ledger-derived calibration and probability scoring. Reports can be rebuilt from the ledger instead of a second mutable calibration file.
- Offline settlement from caller-supplied result data with required provider/source provenance.
- External-ratings benchmark layer: one normalized contract, four source adapters (Massey, Sagarin, Sasser, and the locally-built tennis Elo snapshot), dated snapshots in the local state dir, an additive shadow overlay onto candidate rows, and per-source scoring against the de-vigged close. Shadow-only — it changes no `kaiCall`, tier, verdict, or score, so no external rating reaches live BET eligibility; the overlay only ADDS `row.ratings`. It is wired into `pp scan` and **ON by default** (`--no-ratings-overlay`, or `SSB_RATINGS_OVERLAY=false`, disables it), so a normal scan now carries a `ratings` key on every row. `pp ratings --evaluate` runs the layer's evidence gate over the snapshot store plus the tracker ledger's settled moneyline outcomes (see `docs/BACKTESTING.md`).
- Active documentation claim checks for registered tool count and retired tool names.

Run the complete offline lifecycle fixture:

```bash
node examples/record-settle-evaluate.js
```

It uses one synthetic bet and deliberately reports an insufficient-sample caveat.

## Hard limits

- Missing or ambiguous players produce unavailable coverage; names aren't guessed.
- Tiny samples don't support significance, calibration, or uplift claims. Reports must show sample and coverage before scores.
- No third-party tennis dataset is bundled. Local source data remains subject to its original license.
- Live scans stay user-triggered. Evaluation, examples, and tests are offline.

## Next evidence gates

1. Compare each source independently with Brier score, log loss, and calibration buckets — no composite blend. `evaluateRatingSources` scores each source on its own (Massey's ratings table and its games board are two separate sources, plus Sagarin, Sasser, and tennis Elo).
2. Run each source through the market-relative gate (`evaluateMarketRelative`) against the de-vigged closing line: report CLV, ROI, and drawdown alongside calibration on a chronological split, with sample and coverage shown before any score and `insufficient_sample` below the threshold. No external probability becomes a live weight until it beats the close out of sample.
3. Track coverage, CLV, and ROI only where the ledger contains the required decision and closing prices.
