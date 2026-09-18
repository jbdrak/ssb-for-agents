# Profitable sports betting — an evidence brief

**Date:** 2026-09-18
**Scope:** what actually makes money for a US retail bettor, and what makes a
quantitative system lose. Compiled from a source-cited literature search
(academic + operator filings), cross-checked against this repo's own measured
record.

> [!important] Bottom line
> **There is no documented retail edge in major pregame sides or totals.** The weak-form
> efficiency literature finds no statistically significant long-term odds-only strategy,
> and long-horizon studies find that apparent inefficiencies are _not persistent or
> systematic_ across leagues or seasons.
>
> The defensible targets are narrow, and none of them is prediction:
> **1) promotional value, 2) genuine cross-venue arbitrage, 3) information that arrives
> before the market reprices.** Everything else should be presumed no-edge until live,
> timestamped, out-of-sample results say otherwise.

Evidence quality notes use this scale: **High** (multiple independent/academic sources or
operator filings), **Moderate**, **UNVERIFIED** (only commercial/marketing claims found —
treat as marketing until independently shown).

---

## 1. Ranked strategies

### 1.1 Promotions — the strongest documented structural edge

**Evidence: High for the existence of +EV; UNVERIFIED for any universal annual figure.**

Acquisition bonuses and deposit matches are the clearest case because the bettor is paid
promotional value rather than trying to forecast outcomes. The correct measure is
**expected extractable value**, not the advertised headline: a free bet normally excludes
return of stake, and play-through/wagering requirements reduce the real value.
([academic overview](https://doi.org/10.31219/osf.io/3kytp),
[US revenue context](https://www.legalsportsreport.com/218449/2024-us-sports-betting-revenue/))

Recurring offers — free bets, profit boosts, odds boosts, bet-and-get, insurance,
referrals — are the same mechanism at lower magnitude. Operator filings document these
programs directly ([BetMGM FY24](https://www.betmgminc.com/wp-content/uploads/2025/02/BetMGM-FY24-RNS-vFinal.pdf),
[promo terms](https://sports.betmgm.com/en/blog/terms-conditions/)).

**What kills it:** expiry, state restrictions, market/payment exclusions, maximum stake
caps, non-withdrawable bonus bets, minimum odds, and books reducing offers after detecting
advantage behaviour.

### 1.2 Cross-venue arbitrage — the one genuine outcome-independent edge

**Evidence: High that arbitrage is mathematically +EV; Moderate/low for sustainable US
retail availability.**

The strongest quantitative finding located: a study of **11,933 matches** across Europe's
five largest leagues found **2,287 bookmaker/exchange inter-market arbitrage
opportunities with an average gross return of ~1.4%**, concentrated in higher-liquidity
matches ([source](https://www.unifr.ch/tim/en/assets/public/uploads/Publication%20list/2013/Franck_Verbeek_N%C3%BCesch_2013.pdf)).

This matters because it is the _only_ documented edge that does not require out-predicting
a market — it exploits a price disagreement _between_ venues. The exchange leg is the
important part: a sportsbook-vs-sportsbook pair is often just two quotes in the same
market. **Novig / Kalshi / Polymarket are structurally the exchange side of this trade**
(see §3 for what that implies for this repo).

**What kills it:** capacity. Stake limits, rejection/partial acceptance, line movement
between legs, differing settlement rules, palpable-error voids, and account limiting. The
available percentage is small and opportunities are short-lived.

### 1.3 Line shopping / best-price execution

**Evidence: High for the mathematical benefit; the widely quoted "adds 1-3% ROI" claim is
UNVERIFIED.** ([market efficiency](https://journals.sagepub.com/doi/full/10.1177/15270025231204997))

Taking the best available price lowers the break-even win rate and can move a marginal bet
from negative toward positive EV. But it is **loss reduction, not a profit source**: a
bettor with no probability edge still has no +EV strategy merely from shopping.

This repo now measures it (see §4) — measured at ~1.02% of EV given away on ~30% of
candidates, which is real but nowhere near sufficient alone.

### 1.4 Matched betting / hedged boost conversion

**Evidence: High for the mathematics; Moderate for US practicality.**

Hedging a bonus or boost against the opposite outcome at a good price reduces variance and
captures the subsidy. The value framework is _reward minus expected cost of required
wagering_. **US betting exchanges are not universally available**, which is precisely why
§1.2 matters here.

False claim to reject: hedged does **not** mean risk-free. Execution, settlement, and
account risks remain.

### 1.5 Model-based selection, angles, historical anomalies

**Evidence: Low to Moderate for persistent predictive profitability.**

Isolated anomalies are documented (favourite-longshot bias; promoted-team effects in
historical European football), but the strongest recent evidence is that such
inefficiencies are **not persistent or systematic**. A 14-season study across Europe's
five major leagues reproduced statistically significant "effects" **in simulated fully
efficient markets** — i.e. they arise by chance. ([source](https://journals.sagepub.com/doi/full/10.1177/15270025231204997))

Directly on point for this repo: the literature benchmark of ~36% beat-the-close and
~-0.5% mean CLV **does not demonstrate an edge**. That is the expected signature of paying
the vig with no information advantage.

---

## 2. Where an edge can exist — market structure

- **Winner: bookmaker ↔ exchange arbitrage.** Documented, mechanical, capacity-limited.
- **Major pregame sides/totals: efficient.** No odds-only strategy shows significant
  long-term profit ([weak-form study](https://myweb.ecu.edu/robbinst/PDFs/Weak_Form_Efficiency_in_Sports_Betting_Markets.pdf)).
- **Thin ≠ soft.** The WNBA averages under 1,200 bets/game vs ~10,000 for the NBA, yet
  simple strategies did **not** return reliable profits
  ([WNBA study](https://www.mdpi.com/2227-7072/2/2/193)). Do not label a market soft
  because it is thin.
- **Tennis main markets: efficient.** A **45,813-match / 18-year** study found the market
  _more_ efficient than earlier work suggested
  ([source](https://research-api.cbs.dk/ws/portalfiles/portal/66771737/1058968_Information_Efficiency_in_Tennis_Betting_Markets.pdf)).
- **Live/in-play:** real short-lived information asymmetries exist, but monetising them
  "would require rapid computer-assisted execution"
  ([source](https://ar5iv.labs.arxiv.org/html/2108.00821)). This is a latency edge, not a
  reason to bet live.
- **Props and alternate lines: UNVERIFIED.** Widely claimed soft, but the academic
  literature located does **not** establish a general prop/alt-line ROI advantage. Treat
  as a measurement target, not an assumption.
- **Sharp-book following / steam chasing: UNVERIFIED.** Use sharp books as a _reference
  price_, not an automatic pick signal.
- **CLV is a diagnostic, not proof.** A three-season NBA analysis found positive-CLV
  groups generally outperformed, but **most positive-CLV deciles still lost money** — only
  the top decile was profitable
  ([Whelan](https://www.karlwhelan.com/sportsbetting/the-truth-about-closing-line-value/)).

---

## 3. What this implies for this repo

**The scan is not an income source and cannot be made into one by tuning.** It derives its
"fair" from the same public prices it bets into; the literature calls this exactly what it
is (see failure mode F1 below). Our measurement agrees: 36.4% beat-the-close, mean CLV
-0.59%, robust to excluding every suspect close.

Three things follow, in priority order:

1. **Promotions are the money.** A profit boost is `S·(k−1)·(1−1/d)` — positive for any
   boost > 0, before knowing anything about the games. The repo's role becomes _maximising
   promo EV_, not finding edge. The sharp-anchored de-vig (§4) is the correct input for
   `product(devigged p) × boosted payout − stake`.
2. **Cross-venue arbitrage is the one in-reach mechanical edge** — and it needs the
   exchange side (**Novig / Kalshi / Polymarket**), not another sportsbook. The scan
   already carries two-sided per-book prices, so detection is a scan-time computation.
3. **Execution is a real but small leak** — measured at ~1.02% of EV on ~30% of
   candidates. Worth capturing, not a strategy.

---

## 4. Status of this repo against the checklist

| Failure mode                                                    | Status                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** Circular fair value (de-vigging the same market you bet) | **Diagnosed and addressed** — `marketFairProbability` averaged _all_ books incl. square prices; `sharpMarketFairProbability` now de-vigs the sharp set only, failing closed. Verdict still open.                              |
| **F2** Favourite-longshot bias                                  | **Reproduced live** — the EV-only gate passed 5 longshots resting on 0.5-1.1pp of margin. Fixed via an absolute fair-margin floor (`minFairMarginPts`).                                                                       |
| **F3** Confidence tiers are selected noise                      | **Confirmed** — TIER 1 beat the close 16.7% vs TIER 2's 39.5%; higher `signalQualityScore` performed _worse_. The labels carry no information.                                                                                |
| **F4** Small samples                                            | **Respected** — reports carry `insufficientSample` and 95% CIs; 44 closes was called a result only because it passed the pre-set 30 floor, and the CI (23.8-51.1%) still spans break-even.                                    |
| **F5** Multiple comparisons / false discovery                   | **Not yet guarded** — signal sweeps test many signals x thresholds with no FDR correction. Honest reading: treat any single "separating" signal as a discovery to confirm, never a finding.                                   |
| **F6** Mistaking market agreement for independent evidence      | **Not yet measured** — averaging N correlated books reduces dispersion without adding truth. "17 books" is not 17 independent sources. This is the strongest remaining structural criticism of the fair-probability approach. |
| **F7** Closing-line value as proof                              | **Already treated as diagnostic**, not proof — CLV is reported with CIs and never used alone to declare an edge.                                                                                                              |
| **F8** Lookahead / timestamp leakage                            | **Clean by construction** — closing prices are captured _before_ start by a scheduled sweep, and `clvPct` is null rather than falling back to open-to-current.                                                                |

---

## 5. Honest ceiling

None of this is quit-your-job money. With discipline, promotions run a few hundred to low
thousands a year; cross-venue arbitrage is capacity-limited and small; execution is worth
~0.3pp across a slate. Employment remains the income; this is a supplement, and the
research does not support treating it as anything more.

---

## Sources

1. https://doi.org/10.31219/osf.io/3kytp — inducement economics / expected extractable value
2. https://www.legalsportsreport.com/218449/2024-us-sports-betting-revenue/
3. https://www.betmgminc.com/wp-content/uploads/2025/02/BetMGM-FY24-RNS-vFinal.pdf
4. https://sports.betmgm.com/en/blog/terms-conditions/
5. https://www.unifr.ch/tim/en/assets/public/uploads/Publication%20list/2013/Franck_Verbeek_N%C3%BCesch_2013.pdf — 11,933-match bookmaker/exchange arbitrage study
6. https://myweb.ecu.edu/robbinst/PDFs/Weak_Form_Efficiency_in_Sports_Betting_Markets.pdf
7. https://journals.sagepub.com/doi/full/10.1177/15270025231204997 — 14-season, 5-league persistence study
8. https://www.mdpi.com/2227-7072/2/2/193 — WNBA thin-market study
9. https://research-api.cbs.dk/ws/portalfiles/portal/66771737/1058968_Information_Efficiency_in_Tennis_Betting_Markets.pdf — 45,813 tennis matches
10. https://ar5iv.labs.arxiv.org/html/2108.00821 — in-play informed trading / latency
11. https://www.karlwhelan.com/sportsbetting/the-truth-about-closing-line-value/ — CLV deciles
12. https://www.karlwhelan.com/Papers/EconomicaFinal.pdf — favourite-longshot bias
13. https://www.reading.ac.uk/web/files/economics/emdp201910.pdf — information sets / real-time testing
14. https://arxiv.org/pdf/1710.02824 — public-odds-only models
15. https://academic.oup.com/jrssig/article/18/6/22/7038278 — backtest overfitting
16. https://users.ssc.wisc.edu/~behansen/718/White2000.pdf — reality check / data snooping
17. https://www.math.tau.ac.il/~yekutiel/eBayes/bh_1995.pdf — Benjamini-Hochberg FDR
18. https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm — sample size determination
19. https://zenodo.org/records/7306177/files/ArbitrageBetting.pdf
20. https://theses-dissertations.princeton.edu/entities/publication/437f7731-67ad-4af7-a1e6-648c1d003d46 — live arb, FanDuel/BetMGM

_Claims marked UNVERIFIED were not supported by an independent source in this search and
should be treated as marketing until measured here. No tipster or capper prediction was
used as evidence._
