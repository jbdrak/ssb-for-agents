# Project status and evaluation roadmap

SSB MCP is a manual-first research and recordkeeping tool. It discovers and ranks market signals; it is not presented as an already validated win-probability model.

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
