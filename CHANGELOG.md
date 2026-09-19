# Changelog

## Unreleased

- fix: **the execution book is recorded, which unblocks the one hypothesis the scan had never tested.** `featureSnapshot.book` was `null` on **every** candidate even though the scan payload carried the book (as `targetBook`) and the scan was invoked with an explicit `-b`. The record therefore never said which book we would have bet — which made the sharp-move-lag question _"did we bet a book that had not repriced yet?"_ structurally unanswerable, because there is no way to ask it of a record that omits the bet's venue. `buildFeatureSnapshot` now reads `play.book ?? play.targetBook ?? block.book ?? null` (most specific first, never inventing a book), with the block threaded through from `normalizeRow` — the earlier attempt referenced `block` from a function that never received it, and **the LSP flagged it as an undefined name; dismissing that as a false positive broke 28 tests**, which is the lesson: a "cannot find name" diagnostic is a scope claim, not a style opinion. Verified live: 100/100 newly recorded candidates now carry `book`, where the previous batch recorded 0. **The hypothesis it unblocked is now testable and it FAILS** — 94 of 100 rows already satisfy the lag condition (`book !== movementSourceBook`), so the condition is near-universal rather than selective, and those rows beat the close at the same ~19% with the same negative mean CLV as everything else. That is a real result: riding a sharp move into a different book is not an edge at this book set, because the second book has usually repriced by the time the move is observable. The field is kept regardless — a record of a bet that cannot say where the bet would be placed is incomplete on its own terms, and every per-book question (execution, line shopping, venue softness) needs it.

- feat: **`npm run promo:card` — the promo lane is now a tool, not a bespoke analysis.** Promotions are one of only two lanes with evidence behind them (the scan was measured and has no edge), yet the card built for a real offer was assembled by hand in a scratch script — meaning every future offer repeats the same ad-hoc work and the same chances to get the arithmetic wrong. `lib/promo-eval.js` + `scripts/promo-card.js` make it a two-minute job and keep the traps in one tested place. **The two ways the arithmetic is easy to get wrong, both now guarded by test.** (1) A "40% profit boost" multiplies PROFIT by 1.4, so the factor is `k = 1 + pct/100`, NOT `pct/100` — reading it as 0.40 scales every answer down 100x. (2) The fair-price ceiling is `S*(k-1)*(1-1/d)`, which is why a stake-capped boost is nearly flat in parlay price: `(1-1/d)` is already 0.75 at +300 and only reaches 0.975 at +3900. A 10x longer card buys ~30% more EV while costing real win probability, so the tool **ranks on devigged probability and never on price** — the price is not the objective. It also enforces **one leg per game**, because legs within a game are correlated and a probability product across them overstates the chance of winning. **Validated against the real case:** handed the actual 2026-09-18 offer (40%, 10 stake, +300 floor, 4 legs) it reproduces the hand-computed card exactly — parlay +848, P(win) 8.6%, win +118.69, EV +1.07 — and reports the $3.00 ceiling. It prints the top alternatives rather than only the best, because the spread between them is cents and the reader should choose on leg quality. The closing note states plainly that the **matchup pass is NOT included** in the ranking: a total that ranked second-best there sat behind two starters carrying 5.40+ ERAs, which the price alone does not tell you. Also fixed a third instance of the `Number(null) === 0` coercion in a single session — a missing `--boost` would have silently become a factor of 1.0 and returned a plausible-looking zero-edge parlay; `boostFactor` now rejects null/empty BEFORE coercing, with the reason recorded in the docstring.

- docs: **the repo now states its own measured verdict, because the measurement produced one.** `docs/STATUS.md` and the README's honesty callout both said profitability was "UNPROVEN — no settled-results backtest has been published yet". That is now stale in the wrong direction: the record loop was built to answer exactly this question and it answered. Across **186 measured closing lines the ranking beat the close 20.4% of the time (95% CI 15.3-26.8%) with a mean CLV of -0.94%**, and the read **got worse as the sample grew** (36.4% beat / -0.59% CLV at 44 closes, 20.4% / -0.94% at 186) — the signature of an artifact rather than an edge. The confidence labels are anti-predictive in the same direction and consistently so: TIER 1, the "best" label, beat the close 16.7% against TIER 2's 20.8%. Both docs now lead with the measurement, record what was RULED OUT before concluding (the fair probability was re-anchored on sharp books and the verdict held; execution was measured separately at ~0.3pp per slate, which narrows the gap without closing it; the external literature agrees independently), and state plainly that **the gate should not be re-tuned** — a filter cannot fix a signal with no information in it, and the gate already rejecting essentially everything is the correct output, not a bug. The two supported lanes are named with their evidence: promotions (structurally +EV before any game is known) and cross-venue arbitrage (measured live at 4 opportunities / 1,248 rows, 0.46-0.82%, including the predicted bookmaker-vs-exchange shape). Any future proposal to "improve the scan" is now required to bring out-of-sample evidence first. The measurement is the asset — it is worth more than the plays were.

- feat: **the ESPN resolver now exposes probable starters and venue, so a matchup pass does not need a second ESPN path.** The scoreboard payload already carries `probables` on each competitor, but the parsed competition shape held only settlement fields (`homeTeam`, `awayTeam`, scores, `status`, `isFinal`, `winner`, `date`) — so anything needing a probable pitcher (a promo-card matchup pass, a game preview) had to bypass the resolver and hand-roll its own ESPN fetch. That is exactly what happened while building a promo card, which left the repo with two ESPN call paths where one would do. `fetchEspnScoreboard` now also returns `venue`, `homeProbable` and `awayProbable` (`{name, era, wins, losses}`). The addition is purely additive — existing consumers read named keys — and costs no extra request, with a test asserting the settlement fields are untouched. A starter ESPN has not announced parses as `null`, never a placeholder: "not announced" and "a pitcher whose name is unknown" are different facts, and a matchup read that cannot tell them apart is worse than one that admits it does not know. **Correction worth recording:** the initial report of this as a _date bug_ was WRONG. `fetchEspnScoreboard` returns an array of parsed competitions, not the raw payload, and the probe had read `board.events` off that array — the function was working correctly with and without `dates` all along.

- feat: **`find-arbs` — the full-market arbitrage sweep, and it finds real ones.** The previous slice recorded `arbMarginPct` per candidate, which could only ever see a biased subset: the scan ranks on movement and EV, not price disagreement, so an arb is filtered out before recording (measured: 138/138 candidates carried the field, 0 were arbitrageable). `scripts/find-arbs.js` instead sweeps the FULL ranked market via `pp rank <league> -j`, whose rows still carry `allBookOdds` (the per-book two-sided map that `pp scan`'s output strips). It reuses the existing CLI rather than reimplementing auth, retries, rate limiting and the screen parser, and needs no change to `bin/pp-cli.js` — which sits at its `max-lines` cap. `--from <file>` analyses a saved capture offline; a per-league failure is recorded and skipped rather than aborting the sweep, since the leagues are independent. **First live sweep: 1,248 rows across 10 leagues → 12 detections, 4 unique opportunities**, and crucially the pattern matches the literature's bookmaker-vs-EXCHANGE finding: `UFC Total Rounds | Polymarket -145 / theScore +150`. Also found: Sharaf +1500 (theScore) / Steveson -1329 (NoVigApp) at 0.75%, Austin Peay -6.5 (BetRivers) / West Florida +6.5 (NoVigApp) at 0.68%, Ferreira +178 (4cx) / Shahbazyan -174 (NoVigApp) at 0.53%. Margins are small (0.46-0.82%), which is what the literature predicts — arbitrage is real but capacity-limited, and a detection is a CANDIDATE that must be verified as live and accepted at both venues. Two bugs were caught by the first live run and are now regression-tested. (1) **`pp rank` emits ONE ROW PER SIDE of the same market**, both carrying the same two-sided map, so every opportunity was reported twice and the count inflated ~2x; `findArbs` now dedupes on market identity and `examined` means unique markets. (2) **Spread/total rows leave `selection1`/`selection2` null** and carry the real label in the nested `selections` map, so the report printed `None @ -108`; there is now a nested fallback that deliberately does NOT fall back to `participant`, which names only the row's own side and would print the same name twice. Parsing `pp rank -j` also needed a brace-balanced scan: the output carries progress lines with their own brackets ("Fetching ... [Cubs]...") both before and after the payload, so taking the first bracket lost the entire sweep, and the first version of the fix still broke on a trailing "Done in Ns".

- feat: **cross-venue arbitrage detection — the one documented prediction-free edge.** A source-cited literature review (see `docs/research/2026-09-18-profitable-strategies.md`) found that major pregame markets are efficient, no odds-only strategy shows significant long-term profit, and apparent inefficiencies are not persistent across leagues or seasons — matching this repo's measured record. The single retail-accessible edge the literature DOES document is arbitrage BETWEEN venues: a study of **11,933 matches** across Europe's five largest leagues found **2,287 bookmaker/exchange opportunities at ~1.4% average gross return**. The mechanism is arithmetic, not predictive: for a two-way market, backing side 1 at venue A and side 2 at venue B is risk-free when `impliedA + impliedB < 1` (equivalently `1/decimal(A) + 1/decimal(B) < 1`), which is why `lib/arb-scan.js` needs no decimal conversion — `americanOddsToImpliedProbability` already returns exactly `1/decimal`. `arbMarginPct` is now computed in the candidate mapper from `allBookOdds` and recorded on every candidate, so arbs are measurable without re-scanning; `arbReport` surfaces them in the `npm run evaluate` digest. Three traps are guarded by test. (1) **Two different denominators**: `marginPct` is `1 - sum(implied)` relative to the PAYOUT, so profit against the STAKE is larger — the exact relation is `return = stake / (1 - marginPct/100)`, not `stake*(1+marginPct/100)`. Asserting the wrong one reports a correct arb as broken. (2) **A broken row must not read as free money**: two sides at the same long price (both +500 implies 0.333, a "67% arb") is corrupt data, so margins above 10% are flagged `suspicious` and surfaced rather than dropped. (3) **Rows whose two sides name the same selection are not two-way markets** and are excluded. **Honest scope limit, measured live: 138/138 recorded candidates carry the field and 0 were arbitrageable.** That is expected rather than a null result — the scan ranks on movement and EV, not on price disagreement, so an arb is filtered out long before it becomes a candidate. The digest says so explicitly rather than implying the market had none. Finding arbs properly needs a full-market scan at the ranker output, before the card filter; that is the documented next step and is deliberately NOT bolted onto `bin/pp-cli.js`, which sits at its `max-lines` cap.

- feat: **execution is now measurable — and it immediately found ~1% of payout being left on the table.** Line shopping is the most reliable retail edge there is (taking the best available number for the same selection requires no prediction), and the ledger could not measure it: `executionQuality` recorded a GRADE (`best`/`playable`) but the graded PRICE was never carried, so "how much did we give up?" was unanswerable. `bestAvailableOdds` is computed by the expander and passed by the ranker, but `mapCandidateRow` never named it, so it was dropped before the snapshot and every candidate recorded `null`. Now carried as a number (never stringified, never defaulted to the taken price — a default would report a zero gap that was never observed, i.e. flawless execution that never happened). `shoppingGapReport` in `lib/gate-shadow.js` measures the gap and splits realised CLV by whether we held the best price, wired into the `npm run evaluate` digest. **First live read (121 candidates, 126/126 carrying a real value): 85 held the best price, 36 left value on the table, mean EV given away +1.02% when a better price existed.** Measured over a whole slate that is the difference between losing and break-even, and it needs no signal at all. One bug is worth recording because it inverted the headline: `bestAvailableOdds` is the best price across the COMPARISON books, which **exclude the target book** (`computeComparisonBooks` filters it out), so it can legitimately be WORSE than our own price. The first version tested `best !== odds`, which counted every row where we already held the best number as "value left on the table" and reported **115 of 121 (95%)** — the exact inverse of the truth. It now compares on DECIMAL value, guarded by a regression test that asserts a worse comparison price is not an opportunity. The lesson generalises: American prices are not linearly comparable, so any shopping/spread comparison must convert first.

- feat: **the fair probability is now sharp-anchored, so EV measures something real.** `marketFairProbability` — the number every EV is computed against — is the mean de-vig across EVERY book that quotes both legs. Averaging square books into a "fair" price drags it toward square pricing, so `EV = fair * decimal - 1` stops measuring value and starts measuring "is this price above the average of the books we already scanned": a line-shopping detector, contaminated by soft numbers, and circular, since it derives an edge from the same book population we bet into. That is the diagnosis behind the measured inversion — higher all-books EV performed WORSE (40.0% beat-the-close at EV>=0%, then 0.0% at EV>=1% and EV>=2%, mean CLV -1.06%) and -1.00% average CLV is what betting fair value and paying the vig looks like. No amount of gate tuning fixes a circular measurement. `sharpFairProbabilityForRow` / `sharpFairDetail` now de-vig the repo's sharp comparison set only (per league and market — the same set the ranker already uses for movement), so the resulting EV measures our price against the SHARP market, the defensible definition of +EV. It **fails closed and never falls back** to the all-books answer, because a silent fallback would reintroduce the exact contamination it exists to remove while looking handled. Both anchors are recorded on every candidate so they can be compared head-to-head: the raw per-book odds are NOT persisted, so neither can be recomputed after the fact, and recording both is what makes the comparison possible at all. `fairAnchorReport` sweeps both against realised closes and reports coverage separately, so a low sharp sample cannot read as "the sharp anchor found nothing". **The trap this walked into:** the mapper computed the value correctly and the ledger still recorded null on all 120 freshly scanned candidates, because the pipeline whitelists fields across several layers (mapper -> formatter keep-set -> recorder) and drops unknown ones silently — and a dropped field is indistinguishable in the ledger from a legitimately null one, so this could have read as "no data" forever while looking implemented. Fixed at the keep-set and recorder layers and guarded by `test/fair-anchor-propagation.test.js`, which asserts on the keep-set boundary; asserting on the mapper alone would have proven nothing. Measured: 120 candidates recorded null before the fix, **116 of 116 carry a non-null sharp fair** after it (sharp book counts 3x40, 2x27, 4x24, 5x13, 1x12). The comparison's verdict is still open and fills in as new scans close — what changes is that the number being measured can now actually decide whether this system can work, instead of one we invented.

- feat: **`check:reachability` — a guard against two silent-failure classes.** The audit found the repo currently CLEAN (0 unreachable production files across 202, and all 14 `ctx.handlers.X(...)` call sites provided — including `runTennisScreen`, the symbol a previous audit caught as a broken extraction, now correctly wired). A one-time audit decays, so it is now a permanent gate wired into `npm run verify` and CI. It catches: (1) a production file nothing requires, spawns, or documents — these still ship, since `package.json` includes `lib/`, and then rot; (2) a `ctx.handlers.X(...)` call site whose symbol no wired handler module provides, which throws `TypeError` on a real scan in production. The second class is the expensive one, and the lesson is that "unreferenced module" is not the same verdict as "safe to delete" — when call sites reference a symbol only the orphan provides, the fix is rewire, or delete module and call sites together. Building it exposed three false positives worth recording: the reference corpus must contain documentation CONTENTS, not filenames; the checker's own docstring mentioning `ctx.handlers.X` must not count itself; and a types-only module has no `require` at all, so JSDoc `import('./types')` must count as wiring. Each is proven by a test, including two that assert the guard actually fires — a guard nobody can prove fires is not a guard.

- feat: **`npm run verify` — the CI gate set as one command.** It mirrors what the `quality` CI leg actually runs, which turned out to include two gates that were never being run locally: `tsc -p tsconfig.strict-critical.json` (a second, stricter typecheck over critical runtime modules) and the project's `format:check`. Both are now covered, along with claims/secrets/lint/types/circular/package/audit and the full test suite. This exists because the same class of mistake shipped three times in one evening — a repo-wide lint run happening before the last new file was written, a `gh pr checks --watch | tail` hiding failures, and a formatting fix applied before the final CHANGELOG edit. `check:publish-tree` is deliberately NOT included (it requires a committed tree, so it runs after the commit).
- feat: **`signalSweepReport` — does ANY recorded signal separate winners from losers?** This is the question that decides whether the fix belongs in the gate or upstream in the signal. It sweeps six numeric signals (EV, fair margin, signal quality, open-to-current movement, consensus book count, consensus edge) across thresholds and three categorical ones (movement grade, tier, market), with a computed `separates` flag that requires two READABLE extremes agreeing on BOTH beat rate and mean CLV — so a single big win in a small band can never be reported as a finding. Wired into `npm run evaluate`. First read at 18 closes: **no signal separates**, and two of the system's load-bearing signals trend the wrong way (raising the EV floor lowers the beat rate; LARGER supportive movement does worse: 44.4% at ≥0.5% move down to 0.0% at ≥3%). `insufficientSample` — direction, not result.

- feat: **gate shadow — the instrument that can actually test the gate.** `lib/gate-shadow.js` (`gateShadowReport`, `gateSweepReport`) asks what the card gate WOULD have said about every candidate that has a close-relative CLV, then compares the outcomes of each side. This matters because `beatTheCloseReport` measures the RAW SCAN, which includes every play the gate rejects — so a low beat rate there is not evidence the card is broken and a high one would not be evidence it works. Measuring the scan and calling it a verdict on the card is the easiest way to reach a confidently wrong conclusion. First live read: the gate rejects **all 18** closed candidates, so a binary pass/fail split can never fill up; the threshold sweep is therefore the working instrument, and at 18 closes it shows the EV band getting _worse_ as the floor rises (EV≥0%: 2/5 beat, mean CLV -1.06%; EV≥1%: 0/2, -2.79%; EV≥2%: 0/1, -2.71%; nothing reaches EV≥3%). Flagged `insufficientSample` — this is a direction to watch, not a result. Wired into `npm run evaluate`, so the daily digest carries it.

- fix: the close-eligibility split ran BEFORE the duplicate collapse, so the closable bucket was overstated. Measured on the live ledger: 209 counted vs 158 actually distinct — a 24% overstatement of the rows that can still be measured, which is precisely the number the ~30-close target is compared against. Dedupe now happens first and the buckets are all deduped, with the raw count still reported alongside (`candidates 471 (400 unique)`). The honest live picture: 471 recorded, 400 unique, 18 closed, 158 still closable, 224 never closable — so the real measurement ceiling is 176 plays, not 471.

- feat: the beat-the-close report now separates candidates that can still be closed from those that never can. `validate_play` requires a gameId, and the 243 candidates recorded before `playId` was persisted carry neither a gameId nor a playId — and the scan records do NOT retain the raw plays, so they are unrepairable from the ledger. Reporting them inside `no close` made a structurally impossible close look like a failing sweep (and implied a 452-row backlog that was never a backlog). The report now reads `of the no-close rows: N still closable, M NEVER closable`, so the real measurement denominator is visible: on the live ledger, 471 candidates where only 227 are measurable at all.
- chore(deps): bump `prettier` and `@types/node` to their latest patch releases. `npm audit` reports 0 vulnerabilities.

- docs: reconcile the manual-only policy with the schedule the operator authorized on 2026-09-17. `docs/AGENT_PROMPT.md` and `README.md` (twice) absolutely forbade any scheduled work, while three measurement jobs now run. Left uncorrected, a future agent reading the policy would tear the schedule down as a violation, or refuse to maintain it. The rule is now stated as what it actually protects: no polling loops, no high-frequency scan poller, and never let automation place a bet. The single exception is bounded low-frequency measurement (a closing-price sweep every 30 minutes, a scan capture three times a day, a public-only settle/evaluate digest), with the rationale recorded — a closing price exists only in the minutes before a start, so an unassisted record can never accumulate the closes that decide whether the card has an edge. The architecture is unchanged: timers live in shims outside this repo, and `test/manual-only-gates.test.js` still forbids a tracked `scripts/*` executable that touches live SSB from carrying its own timing.
- fix: `pp --version` printed the help banner and no version at all, because `--version` set no positional so it fell through the `!positional[0]` branch into `printHelp`. It now prints the version from `package.json`.

- fix: **the official record could be silently zeroed by a settlement that decided nothing.** `settle-record` writes a `pending` row (reasonCode `no_event_match`) for every bet it cannot match, and a migrated bet carries its real outcome ON the bet with an unresolvable start (`eventDate: 'unknown'`). Three read paths then let that pending row SHADOW the decided outcome: `settledRows` took the settlement whenever one merely existed, `resolveStatus` in `review-record` returned `'pending'` outright (its docstring asserted a migration behaviour that is false for these rows), and `joinSettledBets` dropped the bet when the settlement normalized to null. Verified on the live ledger: `25 bets — 13W / 12L — -0.11u — ROI -0.4%` rendered as `25 bets — 0W / 0L — 0.00u — ROI n/a` once 25 such rows existed. Precedence is now: a DECIDED settlement, else the bet's own outcome, else pending. `solve()` additionally refuses to write a pending settlement over a bet that already records a decided outcome (an actual settlement or `--force` still wins), so the corruption cannot be re-created. `scripts/repair-shadow-settlements.js` (`npm run repair:settlements`) reports the rows a fixed read path makes inert; it is dry-run by default and takes a timestamped backup before any write.

- feat: `capture-close --quiet` prints nothing when it captured nothing, so a frequent sweep of it is silent instead of announcing "0 captured" every time — noise the reader learns to ignore, which is how a real alert gets missed. Failures still speak. Note the flag is deliberately described WITHOUT scheduling vocabulary: `test/manual-only-gates.test.js` scans every tracked `scripts/*` executable for scheduling language combined with live PP access, and it correctly failed the first version of this change for containing the word `schedule:`. That guard is load-bearing — the rule is that a script touching live PP must not also own a schedule, so the timer belongs in the untracked shim outside the repo and the repo script stays an on-demand tool. The guard catching this is the intended behaviour, not a false positive.

- fix: every recorded candidate had `gameId: null`, which made the whole live close capture a no-op. The scan row carries `playId` and NOT `gameId` — verified on a live slate, **129 of 129 rows had a playId and 0 had a gameId** — and `normalizeScanCandidates` only read `play.gameId`, so the fixture id was dropped at the record boundary. That mattered because `validate_play` REQUIRES a gameId ("gameId is required"), so the live close provider could not resolve a single price. `lib/record-candidates.js` now also records `playId` and derives `gameId` from it when the row has none, using the same `<League>:...:<gameId>::<Market>::<selection>` split that `bin/pp-cli.js`'s `cmdValidate` already applies. An explicit `gameId` still wins, and the derivation is identity-stable: a row recorded via playId hashes to the same `candidateId` as one recorded with the gameId spelled out. Measured effect on the live ledger: 243 candidates with 0 resolvable fixture ids became 129 with a derived gameId on the re-recorded scan.

- fix: the live close provider silently swallowed every failure, so a real capture run reported `unresolved 5` with no way to tell why. `defaultGetPrices` now records a reason per candidate (`no_game_id`, `no_price_in_response`, the vendor's own error message, or the thrown message) through an `ctx.recordFailure` callback, and `captureClose` carries it into `unresolvedDetail`. Verified live: the next run captured 6 closes with 6 close-relative CLV values and reported the remaining 14 precisely as `no_game_id` — legacy rows recorded before the playId fix, which are structurally un-priceable rather than mysteriously absent.

- fix: the beat-the-close report counted the same observation twice. `record-scan` is keyed on the SCAN record's content, so recording one scan file twice produces two scan ids and therefore two candidate ids for one play — and both rows carry the same close. The report now counts each `(fixture, market, selection, price)` once, so the beat rate is not computed over a denominator inflated by bookkeeping. A genuinely different observation of the same play (a re-priced re-scan) still counts, because its price differs.

- fix: the price gate required an EV floor alone, and an EV-only test structurally manufactures longshot "value". Found on the first real slate it ran against (2026-09-17): of 122 rows the scan labelled BET, the gate passed 5 — and every one was a plus-money longshot (+182 to +809) whose entire edge was **0.5 to 1.1 percentage points** of fair probability. That is inside the noise of a de-vig averaged across books, because a longshot price is quoted coarsely: a 16% price moves in whole percentage points. A small ABSOLUTE error in the fair probability becomes a large RELATIVE error in EV as the price lengthens, so an EV floor lets noise in at the long end while correctly rejecting it at the short end. `priceGate` now requires an absolute fair-probability margin as well (`minFairMarginPts`, default 2pp, exposed as `pp card --min-margin`), which makes the bar scale the right way round: 2pp at -110 is about +3.8% EV, while 2pp at +545 is about +13% EV. The two failures are reported separately — `ev_below_floor` (the EV is small) and `margin_too_thin` (the EV is large but rests on a margin too thin to trust) — because they are different findings. Re-run against the same slate, the honest answer is 0 of 122, and the five former survivors now fail as `margin_too_thin`. Regression fixture uses the real rows.

- fix: the structured `odds` field is a PRICE again, instead of sometimes being a display string. `lib/ssb-formatter.js` overwrote `odds`, `targetBookOdds`, `bestAvailableOdds`, `openingOdds` and `currentOdds` with `oddsValueForDisplay(...)` — which renders a NoVig-family price as an implied-probability percent (`'49.0%'`) — in `formatBetCompact`, `formatBetStandard` and `formatQuickScreenMinimal`. Every JSON consumer of those shapes therefore read a probability where the schema promised a price, and because `--record-scan` records the assembled scan row, `'49.0%'` is what reached the ledger: **64 of 90 recorded decision prices were unusable**, which is why no EV, P&L or CLV could be computed from them. Prices now stay numeric and the display convention travels in a new `oddsDisplay` field. This is a contract change for anyone reading `.odds` off those payloads; `bin/pp-cli.js`'s own `formatExecutionOdds` already converted a numeric price to a percent for display, so CLI output is unchanged (its string-passthrough guard existed precisely because of this clobber). Two tests that asserted the old behaviour were asserting the bug and now assert that `odds` is numeric and `oddsDisplay` carries the percent.

- feat: `--min-ev`, `--max-bets` and `--no-gate` on `pp card`: a play is only a BET if the price is on the right side of the market. `lib/card-gate.js` computes EV from the price and the decision-time de-vigged fair probability (falling back to the sharp-consensus edge), caps the card (default 2), and labels any play from a bucket with fewer than 30 decided bets `UNPROVEN`. This gate alone removes most of the 2026-09-17 card: it was 13 plays, 12 of them losers, nearly all priced -133/-135. Break-even at -135 is 57.1%, and the repo's own docs put the tier that produced them at ~50-54% on outcomes — so the card was negative-EV before the first pitch, and 13 negative-EV coin flips losing in aggregate is the expected shape, not bad luck. A row with no price reference at all (movement only) becomes a LEAN rather than a BET, because movement is a hypothesis and the close is what tests it. `No plays on today's <league> card — all N BET(s) failed the price gate` is now a legitimate output.

- feat: `npm run evaluate` reports the record that actually exists. `lib/record-metrics.js` produces, from `ledger.bets` + `ledger.settlements` + recorded closes: hit rate with a 95% Wilson interval, stake-weighted ROI, and mean close-relative CLV, split by tier / market / league / price bucket, plus a separate beat-the-close report over recorded CANDIDATES rather than only bets (the leading indicator, and far cheaper in samples than win rate). Three honesty rules are enforced by test: a bucket under 30 decided outcomes is flagged `insufficientSample`; mean CLV is `null` (printed `unmeasured`) when no close has been captured, never `0`, because "we never looked" and "we broke even against the close" are different claims; and a row whose price is a probability string contributes 0 to ROI but is counted in `unpricedRows` rather than silently averaged in. On an empty ledger everything reports insufficient sample instead of zeros that read like results.

- feat: `npm run fetch:results` produces the settlement results file that nothing produced before, which is why the ledger held **0 settlements**. `lib/results-provider.js` maps real sources into the flat event shape `lib/record-settlement.js` consumes, reusing the existing ESPN resolver (Akamai 403 fallback host and cache included) rather than adding a second fetcher, plus Flashscore for tennis. One rule is load-bearing: **tennis events never carry `homeScore`/`awayScore`.** Flashscore reports SETS, and `settleTotal` grades a total as `homeScore + awayScore`, so publishing sets as scores would settle `Under 21.5 games` off `2 + 0 = 2` — a silent, confident wrong answer. The score fields stay null, which makes `settleTotal` fail closed to `pendingResult('final scores missing from supplied result data')`; set counts ride in `setsHome`/`setsAway` for a human and moneyline still settles off `winner`. Top-level `provider`/`sourceUrl` are derived from the events actually present, so the header can never name a source that contributed nothing, and an event that is not final is still emitted (so a postponement stays visibly pending rather than silently absent). `scripts/flashscore-results.py` is restored from the attic as a tracked script: it was parked over the 100-day Elo backfill it cannot do, but as a same-day tennis result source it is the only working one, and it is verified against the live DOM.

- fix: `settlementStatus` now reads Flashscore's `'Finished'` as final. It only matched `final`, so every completed tennis match mapped to `unknown` and nothing tennis-side could settle. Caught by a test against the real scraper's stage label, not by inspection.

- feat: `clvPct` — closing line value that is actually close-relative. `lib/record-quality.js` gains `impliedFraction` and `beatTheClose`, and `capture-close` stamps `clvPct` (plus a `clvReason` when it cannot) the moment a close lands. It is deliberately separate from `clvProxyPct`, which is the move from the OPENING price to the CURRENT one and says nothing about beating the close. New consumers should read the honest name `openToCurrentPct`, which is now emitted alongside the old key (kept so stored scans keep loading and existing readers keep working) — a full rename would have touched 61 call sites across the ranking math for a label change with no behaviour difference, so the alias is additive instead. CLV is computed only when both sides are usable and is `null` otherwise, never assembled from a proxy.

- fix(docs): `docs/METHODOLOGY.md` and `README.md` already said the truth about this system and it was not read: tier/kaiCall/edge/screenScore are signal-quality ratings, NOT win-probability predictions, and profitability is unproven. The front page now also carries the arithmetic that makes it concrete — the break-even win rate for the prices this system tends to recommend, against the ~50-54% the tier is documented to hit.

- feat: a closing price can now be captured at all, and the record's usability can be audited. Nothing in this repo had ever recorded a CLOSE — `bin/pp-cli.js` said so outright ("No producer writes these yet") — while the cards ranked every play on `clvProxyPct`, which is the move from the OPENING price to the CURRENT one. Those are different quantities: an open-to-current move has already happened to the reader, and a close-relative number is the one that measures beating the market. `scripts/capture-close.js` closes that gap: it selects candidates due for a close (`lib/record-close.js`), resolves a quote through an injectable provider (`--prices <file>` for the deterministic path, `--live` with a per-candidate `validate_play` call for the real one, sequential on purpose), and stamps the result onto the ledger row in place. Two properties are load-bearing. The close is stored as whatever it actually IS: for a NoVig-family book the structured `odds` field is a display string (`'49.0%'`) because `lib/ssb-formatter.js` overwrites it via `oddsValueForDisplay`, so such a close is recorded as `closeImpliedProbability` with `closeIsPrice: false` and `closeOdds: null` rather than converted into a price — turning a one-sided implied probability into a price means inventing a de-vig, which is the derivation this repo refuses. And a `candidateId` is never recomputed: it is the decision-time identity `pp record-card` joins on, so rehashing a row after adding a close would orphan every bet linked to it. `closeKind` separates a genuine `'pregame'` quote from a `'post_start'` one taken inside the grace window, because a post-start quote is not a close.

- feat: `lib/record-quality.js` audits whether a ledger row is usable, and reports gaps instead of repairing them. Measured against the live ledger on 2026-09-17 (90 candidates across 3 scans): **26 of 90 recorded decision prices are actually priced** (`implied_pct: 64`), **90 of 90 candidates carry no `gameId`**, 26 of 90 carry no machine-readable `start` (only the yearless display string `startCST`), and 90 of 90 carry no capture timestamp. `npm run capture:close -- --audit` prints that breakdown. The classifier deliberately keeps `'49.0%'` (an implied probability), `-110` (an American price) and `1.91` (a decimal price) in separate fields and never converts between a probability and a price, so an EV computed downstream cannot silently mix the two. `0%` and `100%` are refused rather than recorded as certainties.

- fix(docs): the README's `pp-query` block told readers to run a command that does not exist. It listed `pp-query recommended`, which the query CLI has not carried since it was replaced by `quick_screen(mode: 'recommended')` — the CLI's own inventory lists 27 commands and that is not one of them, so a reader copying the block got an error on their first try. Replaced with the CLI's own documented form, `pp-query sharp-plays --leagues NBA,MLB --market Moneyline`. (The FAQ's `pp doctor` was NOT a defect: it is a deprecated alias that redirects to `health`, accepted but deliberately absent from `--help`.)

- feat(claims): `check:claims` now verifies that every CLI command the active docs reference exists in its own entrypoint — `pp-query` against the query CLI's exported `getCommandInventory()`, `pp` against the `pp-cli.js` dispatch table plus its `OLD_CMD_MAP` of deprecated aliases. Only code spans and fenced blocks are read: a bare `pp <word>` in prose is English, not a command reference, and matching those yields nothing but noise. Two things this got wrong first and now does not: it read `--help` for the `pp` command set, which omits accepted deprecated aliases and so cried wolf on the README's own `pp doctor` line, and it checked both entrypoints against one list when `pp` and `pp-query` are separate binaries with separate command sets. Verified: it fails on the pre-fix README naming exactly `recommended (pp-query)` and passes on the current docs.

- feat(claims): `check:claims` now verifies that the ratings docs cover every source in the contract, so the next source cannot go undocumented. Adding `massey_games` left four stale claims behind (a source count, a `SOURCES` enumeration, a missing coverage-table row, and an ordinal), all of which had to be found and fixed by hand - which is the signal that the check belonged in the script rather than in a reviewer's attention. It asserts each id in `lib/ssb-ratings-contract.js` `SOURCES` is both NAMED in `docs/BACKTESTING.md` and has a row in its per-source coverage table, matching `massey` with a word boundary so the `massey_games` that contains it cannot satisfy it, and matching the table case-insensitively because the table uses display names (`Massey`) while the ids are lowercase (`massey`). Verified in both directions: it fails on the pre-fix doc naming exactly `massey_games (not named)`, fails on a doc that names a source without giving it a table row, and passes on the current docs. Like every other check here, a missing doc warns rather than fails; a present doc that is missing a source is a failure.

- docs: the README's TIER 1 number was stale, and Sasser's "no probability" decision is now recorded as verified rather than assumed. The README's front page claimed a TIER 1 hit rate of "51.4% over N=296 simulated samples"; the synthetic run that claim describes is seeded (42) and currently produces **53.7% over 873 plays**, so the published figure came from an older board size. Confirmed identical across two runs before quoting it. Separately, `lib/ratings-sources/sasser.js` documented that the source publishes no win probability; that is now verified against the WHOLE reconstructed payload rather than only the fields the adapter maps - the `week` object carries just `season`, `week`, `label`, `dateRange`, `updatedAt`, `intro`, `modelRecord` and `games`, and a game carries no probability, confidence, edge or winProb field anywhere. The one model-accuracy datum the page does publish is its own season record (`modelRecord`: straight-up and ATS W/L), which is page-level and cannot be scored per game. Recorded so the next person does not re-probe it: giving Sasser a probability would mean inventing a conversion, which is the thing this layer refuses.

- fix(docs): `docs/openapi.json` had drifted from the tool surface, so the spec an agent reads was wrong for three tools. `scan`, `quick_screen` and `screen_ranked` all advertise a `movement` filter, and the committed spec listed four enum values where the code accepts five — `adverse_recent` was missing, so a caller following the spec would treat a valid filter value as invalid. The description was stale in a way that matters more: it omitted that `adverse_*` values only ever match tennis-fallback rows, because non-fallback rows are dropped from the candidate pool before the filter runs. That is the caveat that stops an empty result being read as "the scan rejected nothing". Regenerated from the generator, and `npm run docs:openapi` now runs prettier on its own output: the old command wrote an unformatted file that immediately failed `prettier --check`, so following the documented regeneration path left the repo in a state its own format gate rejected. The regenerated spec is byte-identical on a second run, so the command is idempotent.

- fix(ratings): a source id containing an underscore was invisible to every read path. A snapshot's filename was matched with `[a-z]+` for the source segment, so `massey_games-<league>-<season>.json` never matched the pattern - and an unmatched file is not merely unlisted, it is invisible to `listSnapshots`, `loadSnapshot` and the overlay's loader alike. The new games-board source therefore loaded zero records and read exactly like a source with no data, in a layer whose whole job is to say which sources have data. Two contract sources carry an underscore (`massey_games`, `tennis_elo`), so the segment is now `[a-z_]+` in both the latest-file and the retained-history patterns, with a regression test that round-trips a `massey_games` snapshot through save → list → load → history.

- docs(ratings): the benchmark docs now describe the source set the code actually has. Adding a source left four claims stale: `STATUS.md` still said `evaluateRatingSources` scores "each of the four sources", `BACKTESTING.md` enumerated `SOURCES` as `(massey, sagarin, sasser, tennis_elo)`, its per-source coverage table had no games-board row, and its adapter list called tennis Elo "the fourth source adapter". Each now names `massey_games` and the leagues it covers. The dated plan doc under `docs/plans/` is left alone: a plan records what was planned, so it is not a claim about the current tree.

- fix(claims): the tier-ordering check no longer attributes a claim to the README that the README does not make. It warned that the README's "TIER 4 > TIER 2 inversion fixed in v1.5.1" claim was suspect, but that claim is gone - the README now carries an explicit "profitability is UNPROVEN" scope note instead - so the message sent a maintainer looking for a sentence that no longer exists. The check's behaviour is unchanged (same warning, same conditions); only the wording now describes what it verifies: tier ordering regressed in this run, on a small TIER 2 sample, and not a release blocker.

- feat(ratings): Massey's per-sport GAMES board joins the layer as its own source, `massey_games`, so Massey can carry a win probability at all. `massey` reads Massey's per-sport RATINGS table, which is one row per team with no opponent - and the shared contract is matchup-shaped, so every one of its records was dropped by the evaluation bridge as `team_scoped_record`. Massey is also the only source in the layer with MLB ratings, so MLB could not be scored by anyone. Massey's games board is the table that fixes this: one row per fixture carrying its own predicted score for both sides and a printed `Pwin`. The probability is therefore the vendor's PUBLISHED number (`kind: 'published'`), not a conversion this layer invented - which is the distinction the contract exists to police, and the reason the ratings adapter's "no documented rating-to-probability conversion" decision is left exactly as it was. Verified live 2026-09-17 on all eight covered leagues (MLB, NFL, NBA, NHL, WNBA, NCAAF, NCAAB, MLS); the board decodes to the numbers the page renders (MLB Brewers @ Pirates -> Pred 5/4, Pwin 61/39). Three things the board made explicit and this adapter pins: the second side is printed `@ Home` and is the contract's `teamA` (so the probability, scores and margin are all home-relative); only `Scheduled` rows are emitted, because a `Final` row's result is already known at fetch time and scoring it would mark the model against information it could not have had; and the `O/U` column is NOT the sum of the two predicted scores on every row (NFL Buffalo/Detroit: 24 + 27 = 51 against an O/U of 55), so the predicted scores stay the source of truth and `MOV`/`O/U` are not carried. It is a separate source, not a second method on `massey`, because a snapshot path carries source and league but NOT method - a games refresh under the `massey` name would have overwritten the ratings snapshot, and the layer's standing rule is that two different models are never blended. Same transport as the ratings table (one shared `stamp.obfu` / `stamp.jsonURL` chain, now factored into `fetchMasseyPayload`), so only the column plan differs; the plan is built by column TITLE and fails loudly if a required title or its numeric companion is missing.

- fix(ratings): the team spellings Massey prints on its games board now resolve. The board prints bare city names where the ratings table prints nicknames - `Buffalo`, not `Buffalo Bills` - so Massey's NFL records were 32/32 unresolved and WNBA 15/15, both at 100% and both invisible as anything but "unmatched". NBA and NHL had the same defect (9/9 and 12/12 unresolved), and MLS printed a `USA/` country prefix that also failed. The registry now carries the city form for every NFL, NBA, NHL and WNBA team plus the four MLS spellings that were missing, and the board reader strips the leading `@` and a `COUNTRY/` prefix explicitly instead of relying on the normalizer to absorb the punctuation. Measured across the runtime snapshots: unresolved records fell from 52 to 9, and 364 records now carry a win probability. The nine that remain are name-coverage gaps of the same class the layer already reports honestly (FCS and non-D1 opponents on the college boards, plus Sagarin's McNeese State vs UTRGV), not silent drops.
- change: the external-ratings shadow overlay is now **ON by default** in `pp scan` (`--no-ratings-overlay`, or `SSB_RATINGS_OVERLAY=false`, disables it; `--ratings-overlay` is still accepted and simply states the default). The overlay is pure enrichment and rank-neutral, so the default now reflects that its context is cheap to carry: the two-run invariant test already proved `kaiCall`, `displayTier`, `confidenceTier`, `finalVerdict`, `consensusEdge`, `screenScore` and `riskScore` are untouched either way. Two consequences worth knowing: every scan row now carries a `ratings` key, and a league no source covers carries that key with a `null` entry per source, so the key's presence is not itself evidence that a source matched. Scan suites that asserted an untouched payload now pin `--no-ratings-overlay`, and the scan suites pin a hermetic snapshot store instead of reading the user's real one.

- feat: `pp ratings --evaluate` runs the ratings layer's evidence gate. It joins the snapshot store's records with the tracker ledger's settled outcomes through `buildRatingEvaluationRows` and prints, per source, the records seen, the rows joined, whether that source can produce a probability at all (with the stated reason when it cannot), and its sample before any score — then the market-relative gate, and every exclusion reason when nothing joined. Read-only and network-free. Outcomes come from settled **moneyline** bets only: a win probability is a moneyline concept, and only a moneyline result names the game's winner, so run-line/handicap/total settlements are never converted into one (a -1.5 side can lose its bet and still win the game). The gate reports `sample=0` today because the ledger holds no settled NCAAF/NFL moneylines — the leagues the only probability-carrying sources cover — and it says exactly that rather than letting a quiet slate read as a bad model. An optional `--markets <file>` supplies de-vigged closes; scans now record them (see the next entry).

- feat: a scan row now carries `marketFairProbability`, the decision-time de-vigged fair price for that side. It is derived in the candidate mapper (`lib/screen-fair-probability.js`) from the market's own two-sided book prices (`allBookOdds`) - the one place the two legs of a market are still both present at the candidate layer - as the mean of each book's own de-vig, `p(own) / (p(own) + p(other))`, over the books that quote BOTH legs. A one-legged book cannot be de-vigged and is skipped, and an unresolvable side yields `null` rather than the single-sided implied probability that still carries the hold: publishing the OPPOSITE side's price as this side's fair price would be worse than publishing nothing. Deriving it once at the candidate mapper, rather than computing it in the expander and threading it through, is deliberate - the scan pipeline whitelists fields at five separate layers, so a value computed early is silently dropped by whichever layer does not know it. `--record-scan` writes it into the candidate feature snapshot, so the ledger accumulates the closes the market-relative gate needs. It is a DECISION-time price, not a game-time close, and is never presented as one.

- feat: the evidence gate can be scored from a source's OWN fixtures, not only from the tracker ledger. `node scripts/resolve-ratings-outcomes.js --source sagarin --league NCAAF` settles a source's fixtures from ESPN's public college-football scoreboard, and `pp ratings --evaluate --outcomes <file>` feeds the result to the gate, additive with the ledger. Until now the only settled results available were games someone had chosen to BET, which made a source's calibration depend on the bettor's picks. Matching is by the layer's own canonical identity on both sides, and it works only because of which ESPN field is read: on a live 80-game slate `team.location` canonicalized 160/160, against 0/160 for `displayName` and 151/160 for `shortDisplayName`. An unknown school, a pairing ESPN lists twice in the window, an unfinished game or a tie is counted and skipped, never guessed, because a wrong winner would be scored as evidence and would move a calibration. The search window is explicit (`--from`/`--to`, defaulting to the ten days after the snapshot's `asOf`) because a snapshot carries no per-fixture kickoff date - and a snapshot of the current week predicts games that have not been played, so `matched=0` is the correct answer today. Verified as plumbing end to end: supplying five outcomes moved `joined` 0 -> 5 and the gate returned Brier / log loss / a 4-bucket calibration table for them. That check used placeholder winners, so it is a wiring result and is not evidence about Sagarin.

- feat: snapshots are RETAINED per `asOf`, which is what makes the evidence loop closeable at all. `<SSB_RATINGS_DIR>/<source>-<league>-<season>.json` has no date in its name, so every refresh overwrote it — and a prediction cannot be scored until AFTER its game is played. The predictions a settled result would be scored against were therefore destroyed before that result existed, so no source could ever be scored from live data. `saveSnapshot` now also writes `history/<source>-<league>-<season>-<asOf>.json`, and both halves of the loop read it: `scripts/resolve-ratings-outcomes.js --as-of <date>` resolves a retained week, `pp ratings --evaluate --as-of <date>` scores it, and `pp ratings --history` lists what is retained. On either side `--as-of` means the RETAINED copy and never the current file — a date with no retained copy reads as zero records rather than quietly falling back, so this week's predictions can never be scored as if they were that week's. The retention write happens BEFORE the latest file is updated, so a failed refresh reports itself as unsaved rather than updating the current file while dropping the copy that makes the week scoreable later. `listSnapshots` is unchanged and still answers only "what is current"; retained copies never appear in it. Verified end to end against a REAL result: a retained snapshot whose fixture was Texas vs Ohio State (played 2026-09-12) resolved to a real winner through ESPN and scored in the gate, after a later refresh had overwritten the current file.

- feat: `scripts/ratings-weekly-evidence.{js,sh}` is the weekly turn of the evidence loop, built for `no_agent` cron at zero token cost — the numbers are deterministic, so no model is involved. It refreshes the snapshots (which is also what RETAINS the week), scores every retained week whose games have since been played, and prints a compact report. Stateless by design: the same retained snapshots and the same ESPN results always produce the same numbers, so a missed week is picked up on the next run rather than needing a cursor to stay consistent. A week under 2 days old is skipped because its games may still be in progress, one over 35 days old is dropped because nothing new can settle, and a sample below 30 is labelled a small sample rather than presented as if it settled something. Verified end to end: driving the real cron entrypoint from an unrelated cwd ran refresh + score in ~5s and exited 0, and a retained week built from six genuinely played 2026-09-12 fixtures settled 6/6 with Brier 0.2500 / log loss 0.6931 — the exact values a 0.5 placeholder prediction must produce, which is what makes it a mechanism check rather than evidence.

- fix(ratings): the outcome resolver was counting TEAM-RATING ROWS as fixtures, so the denominator was wrong and the weekly report carried a permanent "2 unresolved" that was never a failure. A source's payload is not all games: Sagarin carries its team ratings table beside its game predictions (a rating row reads `teamA === teamB`) and Massey carries ONLY ratings. So `massey NCAAF records=138` was never 138 fixtures — it is 138 rating rows and **0 games** — while sagarin is 119 fixtures + 266 rating rows and sasser 57 fixtures. A same-side record is now classified `not_a_fixture` and counted apart from `unmatched`, and both the resolver and the weekly report print the honest fixture count with the rating-row count beside it. A real fixture whose side cannot be canonicalized still fails closed as `record_identity_unresolved` — on the live Sagarin snapshot that is now the single genuine case (McNeese State vs UTRGV, an FCS program the alias registry does not carry). Practical consequence worth knowing: Massey contributes ratings but can never produce settled evidence, so a zero against it is structural and not a bad week.

- feat: `pp ratings --evaluate` now takes the market closes from the ledger's own `--record-scan` candidates, so the market-relative gate has a close without a `--markets` file. It reads the ledger's MONEYLINE candidates and emits ONE market-less close per fixture carrying the FAVOURITE's fair probability, because the gate's band is the market_favourite_size band. Market-less is what makes it safe: every probability-carrying record is a market-wildcard, and the bridge serves a wildcard only from a market-less input, so a win probability can never be compared against a totals close. A candidate recorded before the de-vig producer landed is skipped as `no_fair_probability`. (Two parts of this were corrected within the hour — the field location and the one-sided-record handling — see the entry below.) The candidate's own `odds` is deliberately NOT passed: it is a decision price, not a close. `--markets <file>` still ADDS closes for a run.

- fix(ratings): the market gate was reading the wrong field, so it saw almost nothing. `--record-scan` writes the de-vigged price onto each candidate's IMMUTABLE `featureSnapshot`, not the mutable top-level row, so `marketFairProbability` was always undefined and every candidate was skipped as `no_fair_probability`. It now reads the snapshot first and falls back to the top level. A real NCAAF scan then exposed the second half of the problem: a scan records only the side it considers playable, usually the UNDERDOG, so refusing a sub-0.5 record discarded most fixtures. The two sides of a two-way de-vig sum to 1 by construction - each book's pair sums to 1, and both sides are averaged over the same set of books - so the favourite's number is `max(recorded, 1 - recorded)`. That is an identity, not an estimate. Verified live on a real NCAAF scan: **9 closes reached the gate, up from 3**, with only the 9 pre-de-vig candidates skipped. The report now exposes the closes it used as `marketCloses`, so an empty market gate is answerable without re-deriving the inputs by hand.

- docs: record why `tennis_elo` cannot produce settled evidence — and it is not the reason previously assumed. Its adapter exports a per-matchup `lookupMatch`, where the snapshot builder needs the `fetch*`/`normalize*` pair a league-table source provides, so `refresh-ratings.js --source tennis_elo` reports "unknown ratings source". A snapshot source publishes a table; a lookup source answers a question on demand; the evidence gate scores snapshots. So it is outside the snapshot path STRUCTURALLY, whatever data exists. That is separate from the also-true fact that its upstream archive is gone (`JeffSackmann/tennis_atp` no longer exists; that account now carries only the Grand Slam charting repo, and the reachable mirrors hold both tours only through mid-2026). A local ATP-only Elo snapshot (asOf 2026-08-14) is nonetheless built and available for the lookup path.

- feat: external-ratings benchmark layer. One normalized record contract plus four pure, injected-fetch adapters — `massey` (MLB, MLS, NBA, NCAAB, NCAAF, NFL, NHL, WNBA), `sagarin` (NCAAF, NFL, NBA, NCAAB, NHL, MLS), `sasser` (NCAAF) and `tennis_elo` (Tennis, Moneyline only) — with dated snapshots held in the local state dir (`~/.ssb-for-agents/ratings/`, `SSB_RATINGS_DIR`) rather than the repo, and an additive shadow overlay that attaches matching records to scan rows as `row.ratings` (ON by default; `--no-ratings-overlay` or `SSB_RATINGS_OVERLAY=false` disables it — see the entry above). Shadow-only by design: it changes no `kaiCall`, tier, verdict or score, and no external rating reaches live BET eligibility. Per-source scoring compares each source separately (never blended) against the de-vigged close, because a computer ranking adds no information on top of the spread — the number is only ever confirmation, context or veto.

- feat: the external-ratings benchmark layer can now actually be scored. The record contract carries `modelWinProbability` **with its attribution** (`modelWinProbabilityKind`: `published` | `derived` - a probability with no kind, a kind with no number, or a value outside `[0, 1]` is an error), and the new `lib/ssb-ratings-evaluation-bridge.js` joins adapter records to settled outcomes and recorded market closes into exactly the rows `evaluateRatingSources` / `evaluateMarketRelative` consume. Previously the evaluation half had no reachable input at all: the contract had no probability field, so `evaluateMarketRelative` could only ever be driven by hand-built rows. Sagarin now carries its page's own `WIN%` for the printed favorite (`published`, whole-percent display precision, cross-checked against the printed `MONEY` column on all six captured pages), tennis Elo carries its engine's own Elo expectation (`derived`, no fitted parameters), and Massey and Sasser are **declined with a stated reason** because neither publishes a win probability and no documented rating-to-probability conversion exists for Massey. A declined source is reported explicitly rather than left absent, because `evaluateRatingSources` omits a source with no rows from its own output - so a source that can never produce a number would otherwise read exactly like a quiet slate. The join reuses the layer's existing rules (the overlay's `canonicalGameKey` identity, the shared `ATTACH_MAX_AGE_DAYS` recency window) and fails closed on everything else: an unresolvable side, an unattributed probability, a market the record does not claim, and - new - two settled outcomes claiming one pairing (`ambiguous_fixture`), which a record with no game timestamp cannot be attributed between, so they are refused rather than collapsed onto one game.

- fix: a team-sport ratings snapshot can no longer be attached to an event it cannot describe. `loadSnapshot` computed `stale` only when a caller supplied `asOfCutoff`, and the scan join supplied none, so the guard sat inert and a snapshot at `asOf 2026-06-13` was attached to a 2026-10-25 event with nothing blocking it. The comparison now lives once in `lib/ssb-ratings-recency.js` (`isBefore`, `staleCutoff`, `ATTACH_MAX_AGE_DAYS` = 14) and is shared by the snapshot store, the overlay, the evaluation pipeline and tennis Elo, which differ only in the cutoff they supply. The overlay withholds per row against that row's own event start and emits an explicit marker (`records: []`, `withheld`, `stale`, `reasonKind`, `reason` naming both dates and the window) instead of silently passing stale context, and the evaluator marks such a row `unresolved` with reason `stale-snapshot` so it is never scored as evidence. Verified against the real state-dir snapshot: the Knicks/Spurs 2026-10-25 case withholds at 134 days, and an in-window event still attaches. Tennis Elo keeps its stricter point-in-time rule unchanged.

- fix: Massey's out-of-season pages now report the seasonal condition instead of a snapshot-write error, and `coverage: 'full'` can no longer sit beside zero records. A preseason page reads `Using games thru Preseason` with no date, so `asOf`/`season` were null and the write was refused with `missing or invalid season: null; missing or invalid asOf` — an opaque error that read like a broken adapter and shipped next to `coverage: 'full'` with 0 records. The adapter now keeps the literal heading fragment, returns `coverage: 'unavailable'` with `records: []` and a reason quoting the page (`massey reports no games played yet (heading: 'Using games thru Preseason')`), and `refresh-ratings` demotes a refused-snapshot row the same way so the contradiction cannot recur on any path. The store's `asOf`/`season` guard is untouched. Affects Massey NBA/NHL/NCAAB until their seasons start; correct, not broken.

- fix: Sagarin coverage is block-scoped and honest. The adapter reported `coverage: 'full'` with no denominator, so a parse that read a handful of rows looked identical to a complete one. It now exposes `pageCandidateRows` (a whole-page diagnostic) distinct from `blockCandidateRows` (the rows this adapter targets), returns `coverage: 'partial'`/`unavailable` with a `coverageReason` naming the shortfall when a block cannot be read, and per-league tests assert the parsed count against that league's own candidate rows. Parser tests are now driven by six captured vendor pages (`test/fixtures/ratings/sagarin-*-2026-09-16.html`) rather than synthetic fixtures shaped to the parser, because a hand-built fixture agrees with the parser by construction and that is exactly where a column-shape bug hides.

- fix: NCAAB team-alias coverage completed. The registry seeded all 362 ESPN-published D1 programs, but four recent additions (Queens NC, Lindenwood, Southern Indiana, St Francis PA) are absent from the ESPN teams family, so their live Massey rows stayed `unresolved` — a parsed row that cannot resolve is the same as no row. Added with ESPN-published canonical keys rather than invented names. Ambiguous fragments are pinned deliberately: `Miami FL` -> `Miami` while `Miami OH` -> `Miami (OH)`, and `Georgia` vs `Georgia St`, so distinct programs never collapse onto one key; `St. Francis Brooklyn` stays `unresolved` rather than collapsing into `Saint Francis`.

- test: `pp ratings`. The read-only listing command had no coverage at all: its league aliases (`CFB` -> `NCAAF`, `CBB` -> `NCAAB`), `--source`/`--league`/`--season` filters, `--show`, empty state and `-j` output were unverified. Added 26 hermetic tests, including a negative control (a module that does call `fetch`) proving the never-fetches assertion can actually fail rather than passing vacuously.

- fix: the ratings layer can now actually be evaluated, and it says which sources it cannot score. The adapters produced ratings while `evaluateRatingSources` / `evaluateMarketRelative` scored a `modelWinProbability` the contract had no field for, so the evaluator could only ever be driven by hand-built rows - the two halves were never joined, and the layer could not produce a number about any source however much data accumulated. The contract now carries `modelWinProbability` with its **attribution** (`modelWinProbabilityKind`: `published` | `derived`; a probability with no kind, a kind with no number, or a value outside [0,1] is an error), and `lib/ssb-ratings-evaluation-bridge.js` turns adapter records plus settled outcomes plus market closes into exactly the rows the evaluator scores. Sagarin is scored on its own published `WIN%` (checked against an independent reader across six captured pages, with the favourite-vs-home attribution pinned by tests), and tennis Elo on its engine's Elo expectation explicitly labelled `derived`. **Massey and Sasser are declined rather than scored on an invented mapping** - Massey publishes a rating and an expected-wins column but no win probability and no documented conversion, and Sasser publishes projected scores and a printed line - and the reason is reported explicitly, because the evaluator silently omits a source it has no rows for. The join reuses the overlay's identity and the layer's shared recency window, and fails closed on anything unattributable, including an `ambiguous_fixture` refusal when two settled outcomes claim one pairing (a rating record carries no game timestamp, so collapsing them would be a guess).

- docs: corrected shipped claims that contradicted the code — the adapter count and the overlay's wiring status in `docs/STATUS.md`, and the rating-layer description in `docs/BACKTESTING.md`.

- fix: `pp today` no longer overspends the shared odds-history allocation: it now passes `aggregateHistoryAllocation` (default 300 calls, env `PP_TODAY_HISTORY_ALLOCATION`) instead of taking the full aggregate share, because at the full share the serialized odds-history gate congests and pairs abort. Measured on the ~35-pair composite fan-out: full share = 185s / 102 plays / aborted scopes; 300 = 69s / 76 plays / none; 135 = 49s / 48; 90 = 37s / 32. Set `PP_TODAY_HISTORY_ALLOCATION=1200` for the full-depth slate, or lower it when you want the card fast. `pp scan` is unchanged.

- fix: `pp scan` no longer reports real TIER 1 plays as TIER 2. `mapCandidateRow` dropped the ranker's `confidenceTierLive`, so the scan-sourced validation echo used the hysteresis-smoothed `confidenceTier`, which goes stale across an aggregate scan's probe / discovery / hydrated passes (observed `confidenceTier=TIER 4` with `confidenceTierLive=TIER 1` on the same row). `validate_play` echoed the stale tier back and `applyFinalVerdict`'s contradictory-tier clamp (BET + TIER 4 → TIER 2) then shipped every TIER 1 play one tier down, silently emptying `pp scan --tier 1` while `rank` / `game` / `validate` reported TIER 1. The mapper now carries `confidenceTierLive` and the validation args echo the live tier. Verified: `scan mlb -b Fliff -m Moneyline -t 1 -B` went 0 → 2 plays, and a mixed Fliff scan went 1/18 → 17/33 TIER 1.

- fix: tennis fallback tiers no longer award TIER 1 for adverse CLV. `assignTierFromClv` graded on `|CLV|`, so a line that moved against the play (CLV -4) returned the lock tier while its verdict was CONSIDER. Negative CLV now maps to TIER 3, matching the verdict ladder.

- feat: compact `quick_screen` / `pp scan` rows now expose tier provenance (`riskScore`, `screenScore`, `confidenceTier`, `validatedConfidenceTier`, `conflictFlag`, `conflictWith`, `consensusFloorApplied`, `altLineFiltered`), and `SSB_DEBUG=true` traces the validation args and the returned tier, so a tier drop is explainable from the scan output without instrumenting the pipeline.

- **BREAKING: renamed `propprofessor-mcp` → `ssb-for-agents`.** The repository, npm package, module layout, and runtime state directory are renamed to remove a third-party product name from the project. There is no intended behavior change, but several consumer-visible identifiers moved:
  - **Package / repo:** npm and GitHub are now `ssb-for-agents` (`jbdrak/ssb-for-agents`). The old GitHub URL redirects.
  - **Command names:** `ssb`, `ssb-query`, `ssb-mcp`, `ssb-backtest` are now installed as canonical names. The existing `pp`, `pp-query`, `pp-mcp`, `pp-backtest` names still work and are unchanged.
  - **Modules:** `lib/propprofessor-*.js` → `lib/ssb-*.js`. Deep imports such as `lib/propprofessor-api.js` must be updated to `lib/ssb-api.js`.
  - **Environment variables:** `PROPPROFESSOR_*` → `SSB_*`. The `PP_*` variables are unchanged.
  - **State directory:** `~/.propprofessor` → `~/.ssb-for-agents`. Existing installs should `mv ~/.propprofessor ~/.ssb-for-agents` (permissions are preserved by a move) or re-run `pp-query login`.
  - **Deliberately unchanged:** the upstream API hosts (`app.` / `backend.` / `screen.` / `slipgen.propprofessor.com`) and the `pp` / `PP_*` CLI and env names.

- feat: exact selection-scoped **price history can now qualify movement** when historical line fields are absent. `resolveHistoryForEntity` records `priceHistoryUsable` / `priceHistoryScope` / `priceHistorySource` / `priceHistoryPointCount`, and `movementHistoryUsable` is now distinct from `lineHistoryUsable`: odds-only points feed movement while `lineHistoryUsable` stays false, so rows with a real price trail but no historical line values stop collapsing to `insufficient`. Provenance survives ranking (`rankingProvenance`), the candidate mapper, the compact field set, and the formatter, and is stripped from suppressed exact-line rows.

- fix: the ranker no longer throws when `movementHistoryUsable` is true and `clvProxyPct` is null — a legitimate state for a single or flat line-less sharp series (`movementLabel: 'insufficient_history'`). `buildScreenRankingReason` interpolated `clvProxyPct.toFixed(2)` unguarded, which raised a `TypeError` and aborted the entire call, discarding already-completed markets in `rank --all-markets`. The CLV suffix is now `Number.isFinite`-guarded.

- fix: SharpOdds event matching now separates a **coverage gap** from a genuine identity conflict. When no event matches but a candidate shares both participants the result stays `event_mismatch`; when nothing on the board shares the participants the provider returns `event_not_covered` instead of implying a league/time conflict. The time tolerance is never widened.

- fix: `get_play_details` resolves the **exact nested side and line** for the odds matrix (`findExactNestedSide` / `buildExactOddsMatrix`) instead of taking the first nested quote, which can belong to an alternate line or the opposite side. `sportsbookData` is used only to fill a book the nested selection did not supply. Tennis start times are corrected before history hydration so the SharpOdds event matcher observes the corrected start.

- fix: the tennis fallback normalizes non-`game_data` response envelopes and object-keyed row maps, queries `ALL_SCREEN_BOOKS` and filters the requested execution book locally, and reports `screenRows` / `targetBookSelections` alongside the existing hydration counters so upstream book coverage is separable from local extraction failures.

- feat: `PP_SCAN_TIMING=1` emits per-phase scan timings to stderr (`[scan-timing] <phase>=<ms>`). Default-off and hermetic; used to attribute scan wall clock across probe / hydrate / card-window / validate / research / tennis-fallback / render.

## 2.10.0

- fix: scan-sourced validation trusts the screen snapshot for fast Novig markets. The validation re-fetch confirms the line is still there instead of re-grading it: consensus wobbles, exec-quality flips, and movement-label flips between two fetches seconds apart no longer downgrade a screen BET. Only material changes downgrade — line gone (lookup_failed) or a big price move (30+ pts American, 5+ pts NoVig percentage → CONSIDER). Direct `validate_play` calls without a screen snapshot keep the legacy strict behavior. Validated prices now carry `quoteAsOf` + `liquidityUsd` so every quote has an age — confirm the live number in-app at tap time.

- fix: competition-scoped Soccer rows now verify official home/away order and venue through ESPN schedule data; generic or unresolved rows remain explicitly unverified, and lookups are cached with a bounded timeout.

- fix: NCAAF NoVig scans now use the local today window, scan the standard Moneyline/Point Spread/Total Points markets without forcing Moneyline-only, and use bounded per-market recovery (80 rows per market with a 700-row shortlist ceiling). Exact validation keeps NoVigApp first in the book list so comparison-book data cannot make a valid NoVig line appear missing. Unresolved alternate rows remain explicitly non-actionable.
- change: browser fallback order in `fetchAccessToken()` is now `got-scraping` → **ego-browser** → **CDP** (ego-browser is the default first browser fallback; CDP is tried only when ego-browser fails). Env gates and injection points are unchanged: `PP_NO_EGO_FALLBACK=1` / `enableEgoFallback:false` skip ego and go straight to CDP; `PP_NO_CDP_FALLBACK=1` / `enableCdpFallback:false` keep CDP disabled. Combined-error shape (`TOKEN_REFRESH_FAILED_BOTH_PATHS`, JWT-redacted details, `err.cause.{gotErr,cdpErr,egoErr}`) is unchanged; the message now lists `ego:` before `CDP:`.
- fix: auth refresh — `fetchAccessTokenViaCDP()` now honors `SSB_CDP_VERSION_URL` (default stays `http://127.0.0.1:9222/json/version`), and a freshly created CDP tab waits (bounded by the runtime timeout) for `app.propprofessor.com` to load before the in-page fetch — fixes the opaque-origin `Failed to fetch` race. `scripts/pp-token-watchdog.js` reads the same env var instead of hardcoding port 9222.
- fix: ego fallback default task space is now the named space `pp-token-refresh` (ego creates it on first use) instead of numeric `7`, which only matched an existing space and failed when none existed. `SSB_EGO_TASK_SPACE` overrides (positive integer server-assigned id) and validation are unchanged; the ego script opens/reuses a same-origin tab before `browserFetch`.
- fix: mapCandidateRow now recomputes movementDisposition via computeMovementDisposition instead of copying a pre-tag stamp, so the sharp-confirmation upgrade (insufficient -> supportive_bouncy) actually applies in quick_screen / screen output. Previously the disposition was stamped before sharpBookMovementConfirmed was set, leaving sharp-backed thin-history plays as "insufficient".
- fix: movementDisposition now upgrades `insufficient` to `supportive_bouncy` when `sharpBookMovementConfirmed` is true (independent sharp book moved on the side) — previously sharp-confirmed plays on thin-history slates were mislabeled "can't tell". Adverse dispositions are untouched.

**cardWindow timezone fix + agent-access hardening.**

### What changed

- **`cardWindow:'today'`/`'next'` now use local timezone (America/Chicago), not UTC.** Previously the date key was built from `toISOString()` (UTC), so any game tipping after the UTC midnight flip (≈7pm CT) got a _next-day_ UTC key and was silently filtered out of `today`. A live Tier 1 could vanish from the scan. Fixed in both the `screen` tool path and the `quick_screen` aggregate path (incl. the next-day merge) via a new `localDateKey(ms, tz)` helper in `lib/mcp-runtime-config.js`.
- **`get_play_details` accepts a singular `book` alias.** Agents (and the skill docs) pass `book` (singular); the schema only allowed `books` (array) and rejected it with `VALIDATION_ERROR`. The handler now coerces `book` → `books:[book]`. Both forms work.
- **`today()` slate rows now include `gameId`.** The one-call briefing omitted `gameId`, so an agent couldn't chain straight into `validate_play` (which requires it). Rows now carry `gameId` for direct chaining.

### Tests

- `test/local-date-key.test.js` — `localDateKey` timezone math (late-night local game stays on same local day).
- `test/card-window-timezone.test.js` — replicates the fixed filter predicate contract.
- `test/get-play-details-book-alias.test.js` — `book` schema gate + coercion.
- `test/today-gameid.test.js` — `gameId` passes through `today()` → slate.

**Tool consolidation (33→30) + response cache + agent self-documentation.**

### What changed

- **Tool consolidation.** `recommended_bets`, `sharp_plays`, `tonight_bets` folded into `quick_screen` mode presets (`mode: 'recommended'|'sharp'|'tonight'`). 33→30 registered tools. All stale references removed from README, docs, tests, and handlers.
- **Response cache.** `quick_screen` now caches aggregate responses — repeat calls with identical args return instantly (<5ms) instead of re-fanning out across leagues. Validation bypasses cache.
- **Self-documenting tools.** Top 5 tools now include `PITFALL` hints in their descriptions so agents learn footguns from `tools/list` without a pre-loaded skill.
- **`get_started` overhaul.** Replaced 120-line static prose workflows with concise numbered agent prompts (4-8 steps per user type) + a `pitfall` field. Preserved `honest_scope` + `edge_cases`.
- **`llms.txt`.** Added at repo root for AI agent discovery.
- **`install:verify`.** `npm run install:verify` runs 53 non-API tests in <1s with no credentials.
- **Dead code removal.** `tonight_bets` handler deleted (zero callers). `ask()` fallback and `daily-snapshot.js` now route through `quick_screen(mode='recommended')`.

### Migration notes

`recommended_bets`, `sharp_plays`, and `tonight_bets` are no longer registered tools. Use `quick_screen` with the `mode` parameter instead:

- `recommended_bets({ leagues, book })` → `quick_screen({ mode: 'recommended', leagues, book })`
- `sharp_plays({ league, market })` → `quick_screen({ mode: 'sharp', leagues: [league], markets: [market] })`
- `tonight_bets({ book })` → `quick_screen({ mode: 'tonight', book })`

**Sharp-play alerts (on-demand) + authoritative `finalVerdict`.**

### What changed

- **`finalVerdict` field.** Every returned candidate now carries a single authoritative bet/no-bet call that merges the raw screen tier and the validation verdict. Resolution rule: prefer `validatedVerdict` (it reflects re-fetched consensus + movement); hard safety override forces a `movement adverse` / `exec bad` flag to PASS (never BET). Also sets `finalConfidenceTier`, `priceDrift` (screen vs validated odds), and `finalWarnings` (`price-drift`, `unknown-game-context`, `validation-failed`).
- **`onlyBets` / `minFinalTier` filter on `quick_screen`.** Return only `finalVerdict=BET` rows at/above the tier floor in one call.
- **New `sharp_alerts` tool.** On-demand alert surface (no cron/polling). Returns ONLY `finalVerdict=BET` plays with clean research, deduped against a local store (`~/.ssb-for-agents/sharp-alerts-store.json`) so the same play isn't re-alerted within the dedup window (default 6h). Response shape: `newAlerts` / `repeatAlerts` / `allBets` + a `message` when nothing is new.

### Migration notes

No breaking changes. `finalVerdict` is additive. `sharp_alerts` is a new tool (available in full and lite modes). Prefer `sharp_alerts` over polling crons — frequent screen-endpoint polling triggered a rate-limit ban for the project owner.

## 2.9.3

- fix: mixed-scan reliability and throughput. Tennis fallback now honors the caller's tier filter (`-t`); JSON scans summarize >50 unresolved rows into total/byReason/sample instead of shipping tens of megabytes of identical failure reasons; the odds-history gate is no longer serial (parallel, env `PP_ODDS_HISTORY_CONCURRENCY`, default 3) so the budget is actually spendable in-wall-clock. Upstream 429s still halt the gate with cooldown.

## 2.9.2

- fix: bound aggregate per-pair hydration budget by the caller's limit. Mixed quick_screen scans (e.g. tennis/MLB/WNBA/NCAAF together with -n 5) never emitted JSON: the allocator share (133 games/pair for 9 pairs) flooded the serial odds-history gate and every pair blew PAIR_TIMEOUT_MS. Effective per-pair budget is now min(allocator share, limit-derived need); EV-first cap threaded per-pair the same way. Live: 150s+ timeout with 1000+ aborts and no JSON becomes ~33s, 0 aborts, honest output. Regressions: aggregate-pair-budget-limit, ev-first-aggregate-budget.

## 2.9.1

- Dependabot: fixed high-severity `adm-zip` transitive vulnerability via npm overrides pin (safe, no breaking changes).

## 2.9.0

- Backtest summary: `getBacktestSummary()` wired into `today()` response (sampleSize, settled, byTier, note — honest reporting, never fabricated ROI).
- Lint hygiene: cleared 30+ ESLint errors across `lib/`, `test/`, `scripts/`. Fixed tennis schedule duplicate-key data corruption (`Rybakina`/`Zhang` shadowing WTA entry).
- Docs: normalized retired `recommended_bets`/`sharp_plays` references to `quick_screen` in RESPONSE_SHAPES.md, HERMES_SKILL.md, PERFORMANCE.md. Updated tool composition map. Staking plan now calls `quick_screen` directly.

## 2.8.0

- `quick_screen` minimal formatter now includes `gameId`, `playId`, `selectionKey`, `finalConfidenceTier`, `displayTier`, `finalVerdict`, `hoursUntilStart`, `kaiCall`, `riskScore`, `consensusBookCount`, and `rationale` so agents can chain `quick_screen → validate_play` without special-casing verbosity.
- `formatQuickScreenBets`/`standard` carry the same authoritative fields (`finalVerdict`, `displayTier`, validated movement, etc.) across all verbosity levels.
- Sort tie-breaker now prefers near-even moneylines within equal tier/movement so usable -150/+130 lines surface before -300/+250.
- `validate_play` adverse-movement tier downgrade code is present; regression test scaffold added (currently blocked by movement-shape fixture coverage — see test note).
- Version bump only; changelog entry added.

## 2.8.3 (unreleased)

**Tennis `unknown-game-context` false-positive fix.**

### What changed

- `pickTourneyForMatchup` (lib/tennis-schedule-data/weekly-schedule-2026.js) now has a **week-level inference fallback** after the player-circuit lookup fails: during a **Grand Slam week** every relevant matchup resolves to that Slam (authoritative surface/level from the schedule), and a **single-event week** resolves to its one tourney. Previously these returned `null` → ESPN fallback (no venue for WTA/challenger early rounds) → `surface: unknown` → `riskFlag: 'unknown'`, which wrongly soft-failed Slam-week WTA/challenger plays (e.g. `Tubello vs Jeanjean` flagged `unknown-game-context` at Wimbledon). Genuinely ambiguous multi-event weeks (no circuit hint, several events per tour) still return `null` — the resolver never guesses a wrong surface.

### Why this matters

The `unknown-game-context` flag used to flow into `validatedGameContext.riskFlag` and the `finalWarnings`/`sharp_alerts` research gate, soft-failing legitimate WTA/challenger sharp plays. It now only fires for genuinely unresolvable matchups.

## 2.8.2

**Player research on by default (scoped).**

### What changed

- **Research scoped to final returned plays.** `quick_screen` now runs `player_context` research AFTER the `targetTiers` / `kaiCall` / card-window filtering, instead of over the entire raw scan. The `research` array is de-duplicated per game (so totals variants for one game don't each spawn a call) and now always maps 1:1 to the plays in `results`. This fixes the ~194KB response truncation that made research appear absent on full-slate scans.
- **`researchLimit` param (default 50, max 50).** Bounds how many final plays get researched, so agents doing huge unfiltered scans can cap payload size.
- **`includeResearch` default documented as `true`.** The `recommended_bets` schema previously said "Default false" while the handler already defaulted it `true` — the doc now matches behavior. `quick_screen` already defaulted `true`; unchanged.

### Migration notes

No breaking changes. Research is attached by default in both tools; pass `includeResearch: false` to opt out (e.g. for max-speed scans). Existing `includeResearch: false` callers are unaffected.

## 2.8.1

**Tier consistency fix + `parseable` flag for agent-friendly minimal output.**

### What changed

- **Tier consistency fix** — `clearTierCache()` is now invoked at the start of each MCP screen call (`quick_screen`, `recommended_bets`, `screen_ranked`, `validate_play`). Previously the per-call hysteresis cache (`tierCache`) was never reset, so a play's tier could drift between otherwise-identical calls as the score timeline accumulated observations. The documented "cleared each call" contract now holds; tiers are stable within a call and recomputed fresh per call.
- **`parseable` flag** — `quick_screen` / `recommended_bets` `minimal` verbosity can now return a structured `plays` array (one object per candidate, alongside the summary string) when `parseable: true`. Agents no longer need a second `standard` call just to parse.
- **Heavy-favorite demotion** — TIER 1 plays with extreme odds (worse than -200) are now demoted to TIER 2, since one loss wipes out multiple wins. They still surface as value plays, just not as locks.

### Migration notes

All changes are additive. `clearTierCache` runs automatically per call. `parseable` defaults to `false` (summary string only). Default tier behavior is unchanged for typical plays; only extreme-favorite "locks" are demoted.

## 2.8.0

**quick_screen / recommended_bets agent UX: honest cardWindow label, exposed cardWindow + maxPlaysPerGame params.**

### What changed

- **`cardWindow` param now exposed on `quick_screen` and `recommended_bets`** — values `today` (default), `next`, `all`. Previously hard-coded to `today` internally and unreachable through the tool surface; agents can now request tomorrow (`next`) or the full upcoming slate (`all`) directly.
- **Honest date-window label** — when `today` is alive and next-day matches are merged in, the response now reports `cardWindow: "today"` plus `nextDayMerged: true` and `nextDayDate`. Earlier builds overwrote `cardWindow` with tomorrow's date (`nextKey`) whenever any next-day row existed, making "today" scans falsely report tomorrow. The rows returned were always correct; only the label misled.
- **`nextDayMerged` / `nextDayDate` surfaced in `minimal` + `standard` formatters** — agents reading formatted output now see the two-day span instead of a lone mislabeled date.
- **`maxPlaysPerGame` param (default 2, max 50)** — controls how many plays per game appear in `minimal` verbosity (highest `screenScore` first). Raise it (e.g. `10`) for full coverage of a game without a second call. `standard`/`full` verbosity always return every candidate regardless of this value. Also fixed the trailing "... and N more plays" count, which used a hardcoded `2` instead of the actual shown count.

### Migration notes

All changes are additive. Default behavior is unchanged: `cardWindow` defaults to `today`, `maxPlaysPerGame` defaults to `2`, and `today` scans still merge next-day rows (now correctly labeled).

## 2.7.0

**Agent UX improvements: npm publish, cookie-based auth, agent examples, minEV filter.**

### What changed

- **Published to npm** — `npx -y ssb-for-agents` now works. Package is public on npmjs.com.
- **Cookie-based auth alternative** — `SSB_COOKIES` env var lets agents authenticate without Chrome/CDP. Export cookies from a logged-in browser session and set the env var.
- **Agent examples** — `examples/` directory with pre-configured MCP configs for Claude Desktop, Cursor, and Hermes.
- **minEV filter** — `quick_screen`, `recommended_bets`, `screen_ranked` now accept `minEV` parameter to filter to +EV plays only.
- **`validate_play` schema gate now accepts `playId`** — the input schema omitted `playId` (and set `additionalProperties: false`), so the arg-validator rejected it as "unknown property" before the handler ran. The handler and selection-matcher already supported exact `playId` matching (CHANGELOG 2.5.0), but the advertised path was unreachable through the tool surface. `playId` is now a declared property, `selection` is optional when `playId` is present, and the handler guard requires at least one of `selection`/`playId`. Agents should pass `playId` from the screen row for totals/spread/soccer/tennis markets to avoid fragile string matching and "no row matched" `lookup_failed` errors. Regression tests added in `test/mcp-arg-validator.test.js`.

### Migration notes

All changes are additive. Existing callers see no behavior change.

## 2.6.0

**Algorithm improvements, new tonight_bets tool, npm publish pipeline, tennis context fixes.**

### What changed

- **Recency weighting in risk score** — recent movement (<1h) now scores -1 risk, moderate (<3h) -0.5, stale (>8h) +0.5. Plays that moved recently are stronger signals.
- **CLV weight increased** — CLV >3% now gives -1.5 risk (was -1), CLV <-3% gives +2 (was +1). CLV is a more reliable signal than before.
- **Dead row filtering** — rows with `consensusBookCount: 0` and `movementLabel: 'insufficient_history'` are now dropped from results. Total Games and other thin markets no longer return 7 PASS rows with zero data.
- **Tennis game_context fix** — Added Cobolli and Minaur to PLAYER_CIRCUIT map so Wimbledon matches resolve to Grass/Grand Slam instead of "unknown".
- **New `tonight_bets` tool** — One-call bundle: screen + sort by game time + filter to BET/CONSIDER tier. Use when you want actionable bets for tonight without chaining multiple calls.
- **npm publish pipeline** — Release workflow now publishes to npm on tag push. `npx -y ssb-for-agents` will work after first publish.
- **Tool count** — 29 tools (was 28). `tonight_bets` added to screen category and lite mode.

### Migration notes

Zero. All changes are additive or improve existing behavior. `tonight_bets` is a new tool; existing tools are unchanged.

### Tests

- 1396 tests passing (was 1390)
- New: recency weighting tests, CLV weight tests, tonight_bets tool count tests
- Full backwards compatibility

## 2.5.0

**Agent-facing ergonomics: filter to Bet-tier only, sort by game time, on every screen tool.**

### What changed

- **Three new optional params on every screen-family tool** (`quick_screen`, `screen_ranked`, `sharp_plays`, `recommended_bets`):
  - `kaiCall: ["BET" | "CONSIDER" | "PASS"]` — keep only rows matching the listed display tiers. Default: no filter. `["BET"]` returns only strong plays.
  - `sortBy: "start" | "edge" | "tier" | "consensusBookCount" | "riskScore"` — sort the response by a single field. Default: server order (tier then screenScore).
  - `sortDir: "asc" | "desc"` — override the per-field default direction. Optional.
- **Field-specific default directions:** `start` asc (soonest first), `edge` desc (largest first), `tier` asc (TIER 1 first), `consensusBookCount` desc (most books first), `riskScore` asc (lowest first).
- **Missing-field rows always sort to the end**, regardless of `sortDir`. A row with no `start` value never gets stuck at position 1 of a `desc` list — agents asking "what's coming up first?" always get a useful answer.
- **ISO date strings auto-coerced** in sort — real data has both unix timestamps and ISO 8601 strings; the new `toNumberOrEpoch` helper handles both.
- **Missing/garbage `kaiCall` is treated as PASS** — explicit `"PASS"` filter required to see them.
- **`get_started` recipes updated** for all three workflows (casual / intermediate / sharp) to use the canonical `kaiCall=["BET"], sortBy="start"` pattern.
- **Tool descriptions updated** in plain language so agents know the new params exist.
- **Docs updated**: new "Filtering & sorting" section in `RESPONSE_SHAPES.md`; new "Quick Recipes" section in `HERMES_SKILL.md` with 5 copy-paste patterns.

### Migration notes

Zero. All new params are optional with sensible defaults. Existing callers see no behavior change.

### Tests

- 1390/1390 passing (up from 1341)
- New: `test/ssb-row-filter.test.js` (19 tests)
- New: `test/ssb-sort-utils.test.js` (30 tests, including `toNumberOrEpoch` helper coverage)
- New: regression coverage for in-place mutation aliasing bug (caught by `staking_plan` integration test)

### Files

- New: `lib/ssb-row-filter.js`, `lib/ssb-sort-utils.js`
- Modified: `lib/tool-definitions/screen.js`, `scripts/server/handlers.js`, `scripts/check-claims.js`, `docs/RESPONSE_SHAPES.md`, `docs/HERMES_SKILL.md`, `README.md`, `package.json`

## 2.4.0

**Major validate_play reliability overhaul: canonical play identity, honest degradation, and freshness metadata.**

### What changed

- **validate_play no longer returns fake PASS on lookup failure.** When the screen row can't be rehydrated, the verdict is now CONSIDER with `lookupStatus: "lookup_failed"` and `reasonType: "lookup_failure"`. The old behavior treated lookup misses as negative betting signals — now it's honest about being a stale snapshot.
- **Canonical play identity (`playId`) on every ranked row.** Screen, quick_screen, recommended_bets, and sharp_plays now emit `playId` and `selectionKey` on every candidate row. Agents can pass `playId` back to `validate_play` for exact row matching.
- **`validate_play` accepts optional `playId` param.** When provided, row matching skips string comparison entirely and looks up by canonical key.
- **Row matching priority restructured.** Exact playId > normalized selectionKey > line-stripped > nested selections > home/away fallback.
- **Screen freshness metadata in validate_play.** New `screenFreshness` top-level field and `freshnessSource` on the play object.
- **Typed MLB game-context errors.** `gameContext` returns `errorType`, `errorDetail`, and `attemptedLookup` when gamePk resolver fails.
- **MLB findMlbGamePk hardening.** Team-name matching normalizes case and whitespace.
- **New validate_play fields:** `lookupStatus`, `reasonType`, `screenFreshness`, `playId`, `selectionKey`, `freshnessSource`.

### Migration notes

Additive — existing consumers reading `verdict`, `reasons`, `verdictSummary` are unaffected. `actionableSummary` now says "Couldn't be rehydrated..." instead of "PASS — one or more hard checks failed" on stale snapshots.

### Tests

- 1258/1258 passing
- New regression tests for: lookup failure degradation, canonical identity, screen freshness, playId resolution, MLB typed errors

### v2.4.0a — Bugfix: Tennis game context always returned "unknown" in validate_play

- **Fixed: `game` parameter passed raw gameId instead of parseable matchup string.** When `validate_play` called `getGameContext`, it passed `game: gameId` (format `Tennis:PREMATCH:p1:p2:unixStart`) but the game-context dispatcher's `parseGameString` splits on "vs"/"@"/"at" separators — not colons. Player names were never extracted, so surface/level resolution always failed for every tennis play and returned `riskFlag: "unknown"`. The handler now parses indices 2 and 3 from the colon-delimited gameId and builds `"p1 vs p2"` before calling the dispatcher.
- **Harden selection-line matching against ambiguous Over/Under lines.** When the `validate_play` row matcher strips "22.5" from "Over 22.5", the remaining "over" key is indistinguishable from "Over 24.5". Added a numeric-content guard that requires the stored selection to contain the numeric portion before allowing a stripped match.
- **22 new regression tests** covering gameId parsing, numeric extraction, numeric guard, stripLine/stripOverUnder edge cases (all pass).
- Pre-existing test failures unchanged — the 10 failing tests are tool-count mismatches from the market alias refactoring and tournament resolution edge cases unrelated to this fix.

---

## 2.3.2

**Bugfix: tennis game context resolves matchup strings to real tournaments.**

### What changed

- **Matchup → tournament resolution in `getTennisContext`.** The `validate_play` and `quick_screen` pipelines call the tennis context module with a `tournament` field that is actually a matchup string (e.g. `"Dart vs Sonmez"`) — the real tourney name is never present. Previously the surface/level pattern matchers would fail to find a tour-level keyword and return `surface: unknown, level: null` for every tennis play. Now, when the input looks like a matchup and a start timestamp is available, the resolver looks up the active tourney from a 2026 weekly schedule table and uses the schedule's authoritative surface/level fields.
- **2026 ATP + WTA weekly schedule added.** Covers June through mid-August: Halle, Mallorca, Queen's, Eastbourne, Bad Homburg, Wimbledon, Hamburg, Gstaad, Washington, Cincinnati, and named grass Challengers (Surbiton, Ilkley, Nottingham). Extends via `lib/tennis-schedule-data/weekly-schedule-2026.js` — add a week entry when new tour-level events go live.
- **Player-circuit hints.** Top-100 player names (Dart, Kasatkina, Keys, Popyrin, Munar, etc.) are mapped to their preferred grass-swing tourneys so a top-50 matchup resolves to the correct tour-level event instead of "Challenger".
- **New `tournament`, `city`, `tour`, `signals.resolvedFromMatchup` fields** in the `getTennisContext` result when a matchup was successfully resolved.
- **`validate_play` now derives the start timestamp from the gameId** (format `Tennis:PREMATCH:p1:p2:unixStart`) and threads it into the game context call. Tennis was the only sport in the validate pipeline that didn't get a `start` field — the other sports have it from the screen row.

### Migration notes

Zero. For matchup strings where resolution succeeds (tour-level events in the schedule), `surface` and `level` are now populated and `riskFlag` is `clean` instead of `unknown`. For matchups outside the schedule window or where the players aren't in the circuit map, the existing `unknown` behavior is preserved. Real tournament names (e.g. "Wimbledon") are unaffected — the pattern matchers still handle them directly.

### Tests

25 new tests in `test/ssb-tennis-context.test.js` covering matchup detection, parseMatchup, the resolver against live gameIds from the June 22 grass swing, the integration path, and the schedule-data helpers. Full suite: 1225/1225 pass.

## 2.3.1

**Bugfix: tier/kaiCall consistency, UFC row resolution, find_best_price name transparency, and validate_play cache.**

### What changed

- **Tier 4 + kaiCall=BET contradiction fixed.** `getConfidenceTier` now clamps tiers upward when kaiCall is BET (min TIER 2) or CONSIDER (min TIER 3). Previously a play with 1.48% edge, 5-book consensus, and best execution could show up as "BET" but "TIER 4 (avoid)" — the risk-score-based tier and the actionability signal were out of sync. Now kaiCall is authoritative: if the system says BET, the tier won't contradict it.

- **UFC validate_play/get_play_details row resolution fixed.** The `runGetPlayDetailsImpl` handler passed `books: requestedBooks` to the upstream API, which was `[]` when no books were specified. This set `hasExplicitBooks=true` in `queryScreenOddsBestComps`, bypassing the `ALL_SCREEN_BOOKS` fallback for non-NA leagues (UFC, Tennis, Soccer). Since Pinnacle doesn't price those markets, every row was dropped before the focusBookMissingRows merge ever ran. Fix: `books: requestedBooks.length ? requestedBooks : undefined` so the API uses its own default set when no books are requested.

- **found_best_price now returns `selectionRequested` and `selectionMatched`.** When the user searches for "Trungelliti" and the system matches "Li" (a fuzzy name-mapping issue in the upstream data), agents can now detect the mismatch instead of silently displaying the wrong player's odds. `selectionRequested` is the original query, `selectionMatched` is what actually resolved. If multiple selections matched (rare edge case for team props), `selectionMatched` is an array.

- **validate_play no longer uses canonicalScreenCache.** The cache's 60s TTL was appropriate for screen_ranked re-fetches across markets but harmful for validate_play, which bundles research + MLB game context that goes stale quickly. Agents also call validate_play once per candidate, so there was no dedup benefit worth the staleness risk.

## 2.3.0

**Startup perf: parallel pre-warming, write-coalescing, circuit breaker, and cross-request dedup.**

### What changed

- **Parallel league pre-warming.** Screen calls for all 10 leagues fire concurrently instead of sequentially. ~2s vs ~20s cold-start.
- **Write-coalescing.** Optional stdout buffering (default OFF, opt-in via `SSB_MCP_STDIO_COALESCE_MS`). When enabled, JSON-RPC messages are batched on a 1ms timer or 16KB buffer, reducing write syscalls during bursty responses.
- **Circuit breaker.** Per-endpoint failure tracking. After 5 consecutive upstream errors, the breaker opens and fast-fails rather than retrying into a degrading backend. Auto-transitions to half-open after 30s. Configurable via `SSB_CIRCUIT_BREAKER_THRESHOLD` and `SSB_CIRCUIT_BREAKER_TIMEOUT_MS`.
- **Cross-request cache key normalization.** Parallel MCP requests with identical parameters but different array ordering now share a single upstream call instead of duplicating.
- **Docs.** 6 new env vars documented in CONFIG.md.

### Migration notes

Zero. Write coalescing is opt-in (default off). Everything else is automatic with no observable breaking change.

## 2.2.0

**Agent-facing surface cleanup: canonical param names with full back-compat, lite mode, tool categories.**

This is the release that takes the agent-ergonomics feedback from the June 2026 audit and ships it. Every existing call site keeps working — the new canonical names are additive, and the deprecated aliases are documented in each schema's `description` and normalized at dispatch time.

### What changed for users

- **Canonical param names.** `live` is now the canonical name for what used to be `is_live` (13 tools). `gameIds` is canonical for `game_ids` (`get_play_details`). The 5-name `sharp_plays` books param (`targetBooks` / `books` / `targetBook` / `book` / `targetBooksCsv`) is now documented as a single canonical form (`targetBooks`) with 4 deprecated aliases. New code can use the clean names; old code keeps working.
- **Tool surface modes via `SSB_MCP_MODE` env var.** Default `full` exposes all 26 tools; opt-in `lite` exposes 10 tools covering the casual / intermediate workflow (router → discover → drill-down → validate → track). Lite mode cuts the `tools/list` response by ~60%, which materially helps agents on tight context budgets.
- **Tool categories.** Every tool now carries a `category` field on its `tools/list` definition: `discovery` (5), `screen` (6), `drill_down` (3), `research` (3), `tracking` (4), `admin` (2), `meta` (3). Agents can cluster the surface instead of reading 26 individual descriptions.
- **`tools/list` returns a `_meta` block.** `{ mode, toolCount, liteToolCount, fullToolCount }` makes it obvious when an expected tool is missing because the server is in lite mode — no more env-grep debugging.
- **`verbosity=minimal` footgun is documented.** The minimal mode returns a plain-English summary STRING (not structured JSON), which trips agents that pick `minimal` to save tokens and then try to parse the response as data. The caveat is now in `VERBOSITY_PARAM.description` so it shows up wherever an agent is choosing a verbosity value.
- **Description quality sweep.** Six under-scored tool descriptions (`sharp_consensus`, `get_play_details`, `league_presets`, `health_status`, `resolve_pick`, `get_pick_stats`) got explicit when-to-call and when-NOT-to-call guidance. `screen_ranked` and `sharp_plays` got `RELATED` cross-references pointing at their sibling tools.

### Why this is the right shape

The MCP catalog is what agents actually read — descriptions, parameter names, and the shape of `tools/list` are the only contract they have with the server. The previous surface worked but forced agents to:

- Read all 26 descriptions to find the right tool (no grouping signal).
- Guess whether `is_live` vs `live` was canonical.
- Try parsing `verbosity=minimal` output as JSON and silently fail.
- Discover via trial-and-error that the schema accepted `game_ids` but the handler wanted the same key under that exact name.

This release makes every one of those discoverable from the schema alone.

### What changed under the hood

- `lib/ssb-tool-definitions.js` — new `__requiredAliases` schema hint, new `category` field on every tool, new `mode` option on `buildToolDefinitions()`. Exports `LITE_MODE_TOOLS` and `TOOL_CATEGORIES` for downstream consumers.
- `lib/mcp-arg-validator.js` — `validateArgs()` honors `__requiredAliases` so the required-check accepts a deprecated alias when the canonical key is absent. New `normalizeArgs()` helper bidirectionally syncs canonical ↔ alias param names at dispatch time (without mutating caller args).
- `scripts/ssb-mcp-server.js` — reads `SSB_MCP_MODE` env var (default `full`), runs `normalizeArgs()` between `validateArgs()` and handler dispatch, surfaces the `_meta` block in `tools/list`.
- `test/mcp-arg-validator.test.js` — +14 tests covering `normalizeArgs` and `__requiredAliases`.
- `test/ssb-tool-definitions.test.js` — new file, 13 tests covering lite mode, category injection, alphabetical sort, and category-count lock-in.

### Migration notes

No code changes required for existing callers. To opt into the new behavior:

```bash
# Run server in lite mode (10 tools instead of 26)
SSB_MCP_MODE=lite pp-query serve

# Use the new canonical param names in new code
quick_screen({ books: ["Fliff"], live: true })        # canonical "live"
get_play_details({ league: "NBA", gameIds: ["x"] })   # canonical "gameIds"
```

Old param names (`is_live`, `game_ids`) keep working unchanged.

## 2.1.10

**System-wide performance pass: parallelize every serial hot path and add a cross-call odds-history cache.** v2.1.8's perf PR parallelized the `recommended_bets` league loop and the `validate_play` sub-calls. This release does the same for the rest of the fan-out paths that were still serial, plus adds an LRU-backed in-process cache for `/odds_history_new` lookups so a `screen_ranked` → `validate_play` workflow doesn't re-fetch the same data on the second call.

### What changed for users

- **`sharp_plays` is now 3-5x faster on default args.** The 3-level nested loop (`targetBook × league × market` for both the rank scan and the sharp-book cross-reference) used to be fully serial. With v2.1.9 defaults (1 book × 10 leagues × 1 market × 2 phases = 20 sequential round-trips), it now fans out at concurrency 4. Typical wall-clock on a quiet slate drops from ~3-6s to ~1-2s.
- **Tennis `screen_ranked` history hydration is parallelized.** The tennis enrichment path had its own `for (const candidate of ...) { await queryOddsHistory(...) }` loop that bypassed the existing `hydrateScreenRowsWithHistory` concurrency cap. With 20-30 tennis candidates on a busy slate, that's 20-30 sequential `/odds_history_new` calls — now concurrency-6 like the rest of the codebase.
- **`runResearchOnTopRows` is parallelized at concurrency 3.** The author originally kept it serial "to keep the cache warm" but the cache key is `player|sport|gameTime|maxAgeMinutes` so concurrent calls deduplicate just as well. `screen_ranked({ includeResearch: true })` and `recommended_bets({ includeResearch: true })` now do 3 player_context calls at a time instead of one.
- **Cross-call odds-history LRU cache.** `queryOddsHistory` was already deduped within a single tool invocation, but the per-call `Map` was thrown away at the end of the call. Now the dedup is process-wide, 5-minute TTL, 250 entries, with an in-flight mutex so N concurrent identical lookups collapse to 1 network call. Failures are NOT cached (so transient errors retry cleanly).
- **`recommended_bets` market loop is parallelized.** League parallelism was already added in v2.1.8, but each league worker still did its 3 markets serially. Now the inner loop is `mapWithConcurrency(3)` over markets, capped at 4×3=12 in-flight calls (vs the previous 4 leagues serial × 3 markets serial = 12 sequential).
- **`query_player_context` races news sources in parallel.** Previously, Nitter RSS + Google News ran serially (and Google News + ESPN ran serially in the deepest-fallback path). Both are now `Promise.allSettled` so wall-clock is `max(t_a, t_b)` instead of `t_a + t_b`.
- **`requestJSON` hoists `JSON.stringify(body)` and the static header scaffolding out of the retry loop.** Tiny win — avoids re-serializing the body on every retry attempt. The `Authorization` header still has to be re-read inside the loop (it changes after a 401).
- **`screen-ranker` reuses the existing `nowMs` value** instead of calling `Date.now()` twice per row. Negligible, but a free cleanup.
- **`health_status` now exposes cache stats.** Operators can now see `response.hitRate` and `oddsHistory.hitRate` to verify the caches are doing useful work. A misconfigured TTL or max-entries was previously invisible.

### Why this is the right shape

v2.1.8's perf PR was a one-off; this release codifies the pattern. The shared `mapWithConcurrency(items, worker, { concurrency })` (extracted to `lib/ssb-shared-utils.js` from `scripts/server/handlers.js`) is the same primitive every fan-out uses. The shared `createCrossCallMemoizedQuery(fn, { cache, keyFn })` is the same primitive every memoized query uses. Future "this is slow" investigations will land on the same primitives, and the reviewer can validate that the cap is appropriate for the call count.

### What changed under the hood

- `lib/ssb-shared-utils.js` — new `mapWithConcurrency` (extracted from handlers.js) and new `createCrossCallMemoizedQuery(fn, { cache, keyFn })`. Both have unit tests.
- `lib/mcp-runtime-config.js` — new `getOddsHistoryCache()` returns the shared process-wide LRU; `getOddsHistoryCacheTtlMs()` exposes the 5-min TTL. Defaults: 250 entries, 5 min TTL — sized for a full NBA slate + 10 min of follow-up validation calls.
- `lib/ssb-sharp-plays-service.js` — `runSharpPlays` rank scan and cross-ref loops converted to `mapWithConcurrency(4)`.
- `lib/screen-tennis.js` — per-candidate history hydration wrapped in `mapWithConcurrency(6)`.
- `lib/ssb-research-runner.js` — `runResearchOnTopRows` rewritten to use `mapWithConcurrency(3)` with a new `concurrency` parameter.
- `lib/ssb-player-context.js` — Nitter+GoogleNews and GoogleNews+ESPN pairs converted to `Promise.allSettled`.
- `lib/ssb-api.js` — `requestJSON` hoists `JSON.stringify(body)` and the static header scaffolding out of the retry loop.
- `lib/screen-ranker.js` — `freshnessAgeMs` reuses the existing `nowMs` instead of a second `Date.now()`.
- `scripts/server/handlers.js` — `createOddsHistoryMemoizedQuery` now uses the cross-call LRU; `recommended_bets` inner market loop is parallelized; `health_status` exposes `caches.response` and `caches.oddsHistory` stats.
- `test/ssb-shared-utils.test.js` — 9 new tests covering `mapWithConcurrency` (empty input, order preservation, concurrency cap, non-numeric coercion) and `createCrossCallMemoizedQuery` (in-flight mutex, cross-call LRU, no failure caching, input validation).
- `test/ssb-mcp-server.test.js` — `validated candidates reuse identical odds-history lookups` updated to use unique gameId/selectionId since the cache is now process-wide (a previous test's result would otherwise be served).

### Stats

- 939 tests passing (was 930 in v2.1.9; +9 from new shared-utils tests)
- 0 lint errors (15 pre-existing function-length warnings unchanged)
- prettier clean, tsc clean, no circular deps
- Version consistency passes
- Live smoke (`MLB`, `UFC`) returns full ranked data with hydrated history

### Out of scope (deliberately skipped)

- **Adding the response cache to `screen_ranked`.** The current cache is only consulted for the multi-league/multi-market tools (`sharp_plays`, `all_slates`). `screen_ranked` is the "single-shot" tool and the agent usually passes dynamic args (different gameId, different book) so a cache hit would be rare. The 1.5x win on cache-friendly calls was not worth the risk of caching dynamic-context responses.
- **Increasing the response cache TTL above 60s.** Sharp-money signals decay on the minute scale; a 5-min TTL would start serving stale consensus edges. The current 60s is the right shape.
- **Pre-warming the cross-call odds-history cache on session start.** That would require knowing which (gameId, selectionId) tuples the user is about to query, which we don't. The cache is a passive layer.

## 2.1.9

**Consolidate the default-leagues list into a single source of truth, and add the two leagues the in-progress work missed (NFL, NCAAB, NCAAF).** Until v2.1.8 the default `leagues` argument across `screen_ranked`, `recommended_bets`, `get_alerts`, the `query-ssb.js` CLI, and the `ssb-api.js` default scan was a partial subset of what the PropProfessor backend supports. v2.1.9 picks up where v2.1.8 left off — the in_progress work added the missing leagues but kept them hardcoded inline in 6+ files, which is a footgun for future drift. This release replaces all of those with a single frozen `DEFAULT_LEAGUES` constant exported from `ssb-shared-utils.js` (and derives `SUPPORTED_LEAGUES` from it in `backtest-daily-snapshot.js`).

### What changed

- `lib/ssb-shared-utils.js` — new `DEFAULT_LEAGUES` export, frozen: `[NBA, MLB, NFL, NHL, WNBA, NCAAB, NCAAF, Soccer, Tennis, UFC]`. Order matches the upstream `/screen` POST shape (main US sports first, then college, then international / niche).
- `lib/ssb-api.js` — `queryScreenOddsBestComps` default `leagues` payload now uses `Array.from(DEFAULT_LEAGUES)` instead of a partial inline list.
- `lib/ssb-sharp-plays.js` — `resolveSharpPlayLeagues` default now uses `Array.from(DEFAULT_LEAGUES)`.
- `lib/ssb-tool-definitions.js` — `screen_ranked`, `recommended_bets`, `novig_screen`, `get_alerts`, and `get_started` tool descriptions updated to point at `DEFAULT_LEAGUES` instead of an inline league list.
- `scripts/server/handlers.js` — all 5 hardcoded `leagues` defaults (`novig_screen`, `recommended_bets`, `all_slates`, `get_started`, `get_alerts`) now use `Array.from(DEFAULT_LEAGUES)`. Removed the local `const DEFAULT_LEAGUES` shadow in `all_slates` that was hiding the import.
- `scripts/query-ssb.js` — CLI `sharp-plays` default now uses `Array.from(DEFAULT_LEAGUES)`.
- `scripts/backtest-daily-snapshot.js` — `SUPPORTED_LEAGUES` is now derived from `DEFAULT_LEAGUES` (uppercased + Set) so the snapshot guard, the API payload, and the CLI defaults can never drift out of sync.
- `test/ssb-shared-utils.test.js` — 3 new tests asserting the list contents, frozen state, and the presence/absence sanity guards (NBA, NFL, Soccer, Tennis must be present; empty string must not).
- `test/backtest-daily-snapshot.test.js` — unchanged, still passes (the test asserts the derived Set has the same 10 expected keys).

### Why this is the right shape

The v2.1.8 in_progress diff added the missing leagues to each callsite individually. That works once but is exactly the kind of fix that gets undone silently the next time someone adds a `leagues:` argument to a new tool. Centralizing it in one place makes the constraint enforceable: any new tool that takes a `leagues` arg should import `DEFAULT_LEAGUES` and the reviewer should not accept a hand-maintained list in the new file.

### Stats

- 930 tests passing (was 927 in v2.1.8; +3 DEFAULT_LEAGUES tests)
- No npm audit vulns
- No new dependencies
- 0 lint errors (15 pre-existing function-length warnings unchanged)
- Full backwards compatibility — `leagues` arg still overrides the default; the default itself just now matches what the backend actually supports.

## 2.1.8

**Player-context research as a first-class pre-flight across the tool surface, plus a new one-call validation tool.** The `player_context` tool has existed since v1.5.x but was only integrated as a pre-flight in `novig_screen`. v2.1.8 brings it to `screen_ranked` and `recommended_bets` as an opt-in flag, and introduces `validate_play` for the common "is this specific play worth betting on?" workflow.

### What's new for users

- **`includeResearch: true` on `screen_ranked`** — runs `player_context` on the top N ranked rows (default 10, configurable via `researchLimit`, max 50) and attaches the result as a `research` array on the response. Each entry has `player`, `riskFlag` (low/medium/high), `riskSummary`, and `topTweet`. Use this to surface injury/availability concerns alongside the ranked plays.
- **`includeResearch: true` on `recommended_bets`** — same idea but applied to TIER 1-2 recommendations. The `riskFlag` and `topTweet` get attached to each play in the response.
- **`riskDowngrade: true` (pairs with `includeResearch`)** — when both flags are set, plays with `riskFlag='high'` are removed from the result entirely (hard filter, not a soft annotation). Without `riskDowngrade`, the risk flags are just attached metadata.
- **New `validate_play` tool** — bundles `get_play_details` + `player_context` + execution-quality check into a single call. Given a `gameId` + `selection` from a prior `screen_ranked` result, returns a single `BET` / `CONSIDER` / `PASS` verdict with all supporting evidence (the play's tier, consensus edge, execution quality on the requested book, the player's riskFlag, and a top tweet if riskFlag=high). Saves the agent from chaining 3 separate tool calls to validate one play.

### What changed under the hood

- `lib/ssb-research-runner.js` (new) — `runResearchOnTopRows({ rows, limit, playerContextFn, maxAgeMinutes })` runs player_context on the top N rows by screenScore, captures per-row errors without aborting, and returns a normalized result array. Lives in its own module so the same code path serves `screen_ranked`, `recommended_bets`, and the future riskDowngrade path.
- `lib/ssb-tool-definitions.js` — added `validate_play` tool definition. Added `includeResearch`, `researchLimit`, `riskDowngrade` to `screen_ranked` and `recommended_bets` inputSchemas. The v2.1.6 arg validator enforces the types.
- `scripts/server/handlers.js` — `screen_ranked`, `recommended_bets`, and the new `validate_play` all use the research runner. When `riskDowngrade` is set, plays with high riskFlag are removed from the response and the count is surfaced in `resultMeta.riskDowngradedCount`.
- `test/ssb-research-runner.test.js` (new, 8 tests) — covers empty input, missing function, sort order, limit, error handling, missing selection, and tweet truncation.
- `test/ssb-validate-play.test.js` (new, 7 tests) — covers the validation errors, skipResearch, high/medium riskFlag downgrades, and the no-match-found path.
- `test/ssb-mcp-server.test.js` — added `validate_play` to the stdio-contract tool list assertion.
- `docs/openapi.json` — regenerated for the new tool.

### Why this is the right shape for the v2.1.7 "playable, not best" workflow

In v2.1.7 the user reported: "i dont need Fliff to have the best executable price. just a playable price." After that fix, the next natural question was: "ok so once I have a Fliff play flagged as playable, how do I know the player isn't injured?" The answer in v2.1.7 was: "you have to call `player_context` separately for each play." v2.1.8 collapses that into one flag on the same call.

`screen_ranked({ books: ['Fliff'], playableOnly: true, includeResearch: true, riskDowngrade: true, researchLimit: 10 })` now returns the top 10 Fliff plays at playable prices, with player-context research attached, and any play with riskFlag='high' removed from the result. The agent just needs to look at the verdict and riskFlag for each play.

`validate_play({ league: 'Tennis', gameId: '...', selection: 'Parry' })` is the one-call version for when you already have a specific play in mind — e.g. picked from a prior `screen_ranked` result — and want a single yes/no answer with the evidence trail.

### Live impact (Fliff Tennis example)

Before v2.1.8, a Fliff Tennis `screen_ranked` with `playableOnly: true` returned 22 plays but the agent had to call `player_context` separately for each to validate. After v2.1.8, the same call with `includeResearch: true` returns the same 22 plays plus a `research` array with `riskFlag` for each. Add `riskDowngrade: true` and the high-risk ones are filtered out.

### Deferred

- **Tennis-specific news source (atptour.com / wtatennis.com)** — defer to v2.1.9. The current `player_context` flow uses X/Google News/ESPN, which works for NBA/MLB but is thin for tennis player news. Adding atptour/wtatennis requires scraping (no clean RSS) and has a meaningful maintenance burden. The v2.1.8 riskFlag for tennis players is "no consensus news found" more often than ideal; v2.1.9 will close that gap.

### Stats

- 891 tests passing (was 876 in v2.1.7; +15 tests: 8 research-runner, 7 validate-play)
- 25 tools (was 24; +validate_play)
- 0 npm audit vulns
- 82.4%+ coverage (above c8 thresholds)
- Full backwards compatibility — all new options default to false, the new tool is opt-in.

## 2.1.7 (patch: playableOnly flag)

**Added `playableOnly: true` option to `screen_ranked` (and the underlying tennis + sharp_plays paths).** When set, the ranker keeps rows where the user-requested book is within the normal market range (`executionQuality != "bad"`) even when `consensusEdge` is negative or zero. Use this when you want signals on a specific book at executable prices, not just positive-EV opportunities.

### What changed

- `lib/screen-ranker.js` `expandScreenRow` / `rankScreenRows` / `rankLeagueScreenRows` — new `playableOnly` option. When true, the row filter drops only `executionQuality === 'bad'` rows (where the user's book is 10+ cents worse than the comp consensus). `'playable'` and `'best'` rows are kept regardless of consensus edge direction.
- `lib/screen-tennis.js` `rankTennisScreenRows` — same `playableOnly` option threaded through.
- `scripts/server/handlers.js` `screen_ranked`, `runLeagueScreen` (sharp_plays path), `runTennisScreen` — pass `playableOnly: args.playableOnly === true` to the ranker.
- `lib/ssb-tool-definitions.js` `screen_ranked` — added `playableOnly: { type: 'boolean', description: '...' }` to the inputSchema. The validator (added in v2.1.6 hardening) enforces the boolean type.
- `test/screen-ranker.test.js` — 4 new tests covering playable/best/bad execution under `playableOnly=true` and the default behavior.

### Why this is the right default for a "playable, not best" workflow

The user reported that for Fliff Tennis, no TIER 1-3 plays surfaced even though many rows had real movement signals (`openToCurrentClvPct > 0`, `movementLabel: 'supportive'`). The default ranker gate requires `score >= 1.75`, which implicitly demands positive consensus edge — too strict for a bettor who just wants "executable price on a book where sharp money is moving in the right direction." The `playableOnly` flag relaxes the consensus edge requirement while still dropping rows where the user's book is wildly off-market (the `bad` execution quality classification).

Example: with `books: ['Fliff']` and `playableOnly: true`, `screen_ranked` now surfaces Parry-Tauson at Fliff -145 (best -135) — a 10¢ spread, supportive movement, +1.74% CLV — that the default gate would have flagged PASS.

### Stats

- 876 tests passing (was 872 in v2.1.7; +4 playableOnly unit tests)
- 24 tools (unchanged)
- No behavior change for callers who don't pass `playableOnly` — full backwards compatibility.

## 2.1.7

**Two related ranker bugs that mis-reported consensus / execution data on single-book queries — both surfaced during a live Fliff Tennis query on 2026-06-15.** The first was a missing sharp-book augmentation in `screen_ranked` (consensus fields were 0 on every row when the user requested a non-sharp book). The second was the ranker reporting a non-preferred book's odds as if they were the preferred book's, producing misleading "Fliff -117" output when Fliff never posted a line.

### Root cause

**Bug 1: `screen_ranked` missing sharp-book augmentation.** The `runLeagueScreen` helper (used by `sharp_plays` via `queryLeagueScreen`) augmented the backend query with the league's sharp-book set so consensus data populated. The standalone `screen_ranked` handler had its own copy of the same logic but never got the augmentation — it called `client.queryScreenOddsBestComps({ books: requestedBooks })` directly. When a user requested a single non-sharp book (e.g. `books: ['Fliff']`), the backend returned just that one book and `consensusBookCount: 0` on every row.

**Bug 2: ranker falls through to non-preferred book.** `expandScreenRow` in `lib/screen-ranker.js` derives `preferredOdds` via `oddsMap?.[resolvedBook] || oddsMap?.[preferredBook] || oddsMap?.[rowBook] || oddsMap?.NoVigApp`. When the user requested a book (e.g. Fliff) that wasn't in the row's `oddsMap`, the ranker fell through to `oddsMap?.[rowBook]` (the source book, e.g. Pinnacle) and reported Pinnacle's line as if it were Fliff's. The user saw a confident-looking "-117" with no indication it was a different book.

### Fix

- `scripts/server/handlers.js` `screen_ranked` (~line 793) — augment the backend query with `getSharpBookComparisonSet({ league, market })` the same way `runLeagueScreen` does. Three pre-existing test assertions updated to expect the augmented book list (`['NoVigApp', 'Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings']` for NBA Moneyline, equivalent for other leagues).
- `scripts/server/handlers.js` `screen_ranked` + `runLeagueScreen` (sharp_plays path) — pass `requirePreferredBook: requestedBooks.length > 0` to `rankLeagueScreenRows`. The ranker drops any row where the user-requested book doesn't have a price in the row's `oddsMap`, rather than reporting a non-preferred book's odds as the preferred book's.
- `lib/screen-ranker.js` `expandScreenRow` — new `requirePreferredBook` option. When true and the preferred book isn't in `oddsMap`, the function returns `[]` (drops the row). When false (default), the legacy fallback behavior is preserved for callers that explicitly want "any book with consensus."
- `lib/screen-ranker.js` `rankScreenRows` + `rankLeagueScreenRows` — new `requirePreferredBook` option threaded through.
- `lib/screen-tennis.js` `rankTennisScreenRows` — same `requirePreferredBook` option threaded through.
- `test/screen-ranker.test.js` (new file, 6 tests) — first direct unit tests for the ranker. Covers the happy path, the `requirePreferredBook` drop, the legacy fallback, and the v2.1.6 `allBookOdds` reconstruction. The ranker was the most complex file in the project (916 LOC) without a direct test before this release; this is the test debt LOW-1 / LOW-2 from the prior audit, partially retired.
- `test/ssb-api.test.js` (3 assertions updated) and `test/ssb-mcp-server.test.js` (1 assertion + 1 mock update) — updated to reflect the augmented book list and the new "first sharp book" mock convention.

### Live impact (Fliff Tennis example)

| Field                                         | Before v2.1.7               | After v2.1.7                                  |
| --------------------------------------------- | --------------------------- | --------------------------------------------- |
| `consensusBookCount` on Fliff Tennis          | 0 on every row              | 1–5 (Pinnacle, Polymarket, Kalshi, BetOnline) |
| `consensusEdge`                               | `null`                      | -1.80 to +0.5pp (real)                        |
| `screenScore`                                 | 0.00 (all rows failed gate) | 5.13–8.66 (rankable)                          |
| Surfaces "Fliff -117" when Fliff never posted | YES (wrong book)            | NO (rows dropped)                             |
| Tier 1–3 plays when Fliff has no line         | Surfaced as if real         | Dropped (requirePreferredBook gate)           |

### Why this matters

The v2.1.6 release fixed the consensus-preservation bug (the data was being clobbered). v2.1.7 fixes the remaining two data-quality issues that were masking the v2.1.6 fix in practice. After v2.1.7:

- A user asking `screen_ranked(league='Tennis', books=['Fliff'])` sees rows where Fliff actually has a price, with real consensus from the league's sharp books.
- A user asking for a match where Fliff doesn't post gets 0 rows for that match — not a fake row with another book's odds mislabeled as Fliff's.
- A user asking `sharp_plays(book='Fliff', ...)` only sees plays where Fliff is actually priced.

### Stats

- 872 tests passing (was 866 in v2.1.6; +6 screen-ranker direct unit tests)
- 24 tools (unchanged)
- TIER 4 ≤ TIER 2 inversion: held (49.7% ≤ 49.9%)

### Deferred (carryover from v2.1.6)

- `import/no-cycle` ESLint rule — `eslint-plugin-import` does not yet support ESLint 10 (tracked at import-js/eslint-plugin-import#3227).
- MEDIUM-1 from prior audit (two LRU cache classes coexist) — defer to v3.0. No user-facing impact.

## 2.1.6

**Consensus-preservation fix in `extractScreenRows` — every main-line screen row was silently cascading to `consensusBookCount: 0 / TIER 4 / PASS` because the full per-book odds map was being clobbered on the expanded row.** Symptom: live screen / `get_play_details` / `recommended_bets` / `sharp_plays` calls all returned `consensusBookCount: 0`, `consensusEdge: null`, `executionQuality: "unknown"`, `marketBookCount: 0`, `supportBookCount: 0`, `screenScore: 0`, `gatePassed: false` with `gateReason: "score 0.00 below 2.05 gate"`, and consequently `riskScore: 10`, `kaiCall: "PASS"`, `confidenceTier: "TIER 4"`. The same symptom pattern as the 2026-06-15 upstream consensus outage — but the upstream `/odds_history_new` and `/screen` are healthy, so the bug was local.

### Root cause

`extractScreenRows` (`lib/screen-parser.js`) expands a normalized upstream row (`selections: { null: { ...lifted fields, odds: {full map} } }`, `defaultKey: null`) into per-book rows by spreading the row and then setting `odds: bookOdds.odds1` (a number). The explicit `odds` override clobbered the lifted full map. Combined with `normalizeRow` setting `selections: undefined` (because no other selection keys exist), the expanded row had no way for the ranker to find the full map. The ranker (`expandScreenRow` in `lib/screen-ranker.js`) gates on `row?.selections && (row?.book || row?.sportsbook)`; with `selections: undefined` the main path was skipped, the early-return on missing `preferredOdds` fired, and the row passed through with every consensus-derived field at zero.

### Fix

- `lib/screen-parser.js` `extractScreenRows` (`isNormalizedNonProp` branch) — preserve the full lifted odds map on the expanded row as `allBookOdds` before overriding `odds` with the per-book number.
- `lib/screen-ranker.js` `expandScreenRow` — when `row.selections` is undefined but `row.allBookOdds` is present, reconstruct the `selections: { null: { ...lifted fields, odds: row.allBookOdds } }` shape the existing main path already understands.
- 3 new regression tests in `test/ssb-analysis.test.js` (live-shape fixture mirroring the actual `/screen` payload, v2.1.2 fallback preservation, per-book `odds` contract preserved).

### Live impact

| Field                         | Before                                   | After                                                            |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `consensusBookCount`          | 0                                        | 5–19                                                             |
| `consensusStrength`           | `"none"`                                 | `"strong"`                                                       |
| `consensusEdge`               | `null`                                   | 0.4–5.2pp                                                        |
| `executionQuality`            | `"unknown"`                              | `"best"` / `"playable"` / `"bad"`                                |
| `marketBookCount`             | 0                                        | 4–19                                                             |
| `supportBookCount`            | 0                                        | 4–19                                                             |
| `bestAvailableOdds`           | `null`                                   | real value (e.g. 117 for a +116 side)                            |
| `screenScore`                 | 0                                        | 2.4–11.8                                                         |
| `gatePassed`                  | `false` (`"score 0.00 below 2.05 gate"`) | `true` (`"score X.XX passed 2.05 gate"`)                         |
| `riskScore`                   | 10                                       | 4–8                                                              |
| `kaiCall`                     | `"PASS"`                                 | `"CONSIDER"` / `"BET"` (when signals warrant)                    |
| `confidenceTier`              | `"TIER 4"`                               | `"TIER 1"`–`"TIER 3"`                                            |
| `tierTrajectory`              | all-zero placeholder                     | real trend / volatility / data points                            |
| `scoreBreakdown`              | all-zero                                 | real consensus / movement / sport / freshness                    |
| `"No consensus data"` warning | always present                           | gone (only "No line history" + freshness remain when applicable) |

### What I'm NOT touching (separate concerns)

- `< 2` gate in `resolveHistoryForEntity` — correct (you need 2+ points for movement). With consensus now flowing, rows with sparse history rank on consensus + freshness + sport score instead of being silently killed.
- `freshnessFallbackUsed: true` for the screen call itself — separate upstream timestamp issue.
- The prop-market `consensusBookCount: 0` tests in `test/ssb-analysis.test.js` — intentional, the prop code path uses a real `selections: { a: {...}, b: {...} }` map (non-null defaultKey), so the ranker already has what it needs and these rows are unchanged.

### Stats

- 866 tests passing (was 843 in v2.1.5; +23 tests: 3 live-shape consensus, 1 CDP URL-escape guard, 19 arg-validator)

### Deferred

- **`import/no-cycle` ESLint rule** — `eslint-plugin-import` does not yet support ESLint 10 (tracked at import-js/eslint-plugin-import#3227). The repo upgraded to eslint 10.5.0 in the same release cycle, so installing the plugin would force a downgrade. Re-evaluate once the plugin ships v10 support.
- 24 tools (unchanged)
- TIER 1/2 hit rate: pending re-validation against fresh data (was 51.5% on 575 plays in v2.1.5; should improve because more rows are now rankable instead of all defaulting to TIER 4)

## 2.1.5

**Vercel 429 self-heal — the MCP refreshes its own access token via Chrome DevTools Protocol when the server-to-server path gets 429'd.** Previously, when Vercel's TLS-fingerprint challenge gated `app.propprofessor.com/api/access-token`, the MCP would return errors to tool calls until the user manually ran `pp-token-watchdog.js`. Now `fetchAccessToken()` in `lib/ssb-auth.js` automatically falls back to a browser-context fetch from a logged-in Chrome tab on 429 / 401 / network errors. No cron, no external schedule — the MCP heals itself on the next request that needs a fresh token. The standalone `pp-token-watchdog.js` is preserved as a manual escape hatch for diagnostics and bulk token priming.

### Added

- **`fetchAccessTokenViaCDP()` in `lib/ssb-auth.js`** — Chrome DevTools Protocol token fetch. Connects to Chrome on `127.0.0.1:9222`, finds or creates a tab on `app.propprofessor.com`, runs `Runtime.evaluate` to `fetch()` the access-token endpoint with `credentials: 'include'`, and returns the parsed body. Reuses an existing PP tab if one is open; creates one if not. All timeouts explicit; failures bubble up cleanly.
- **Automatic fallback in `fetchAccessToken()`** — when the `got-scraping` path throws or returns 429 / 401, the MCP calls `fetchAccessTokenViaCDP()` automatically. The common path is unchanged (fast `got-scraping`); the 429 path costs ~1-2s of CDP overhead and then works for the next 8 minutes. Both paths failing yields a combined error with `err.code === 'TOKEN_REFRESH_FAILED_BOTH_PATHS'`.
- **`PP_NO_CDP_FALLBACK=1` env var** — disables the CDP fallback for headless / CI environments where Chrome isn't available. Default: fallback enabled.
- **17 new regression tests** in `test/ssb-cdp-fallback.test.js` covering the happy path, error branches, fallback gating, and the combined-error code.

### Changed

- `lib/ssb-api.js` re-exports `fetchAccessTokenViaCDP` alongside `fetchAccessToken` for backward compatibility.
- `scripts/pp-token-watchdog.js` header rewritten to mark it as a manual escape hatch (no longer needed for production). Lint-cleaned.

### Operator impact

- **No more "refresh token" hand-holding.** When Vercel 429s the access-token endpoint, the next tool call will silently take the CDP path. Users on machines with Chrome open and a SSB tab open won't notice anything.
- **Failure mode shrinks.** The MCP only breaks if BOTH Vercel is gating AND Chrome isn't running with a logged-in PP tab open. In practice that means "I'm not at my Mac."
- **Watchdog cron is no longer required.** If you previously had a `slash-5 18-23 * * *` cron driving `pp-token-watchdog.js`, you can remove it. The watchdog script itself stays in the repo for manual diagnostics.

### Stats

- 843 tests passing (was 826 in v2.1.4; +17 CDP fallback tests)
- 24 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)

## 2.1.4

**Hotfix on top of v2.1.3: degraded-line warning was silently filtering out Puck Line / Run Line / Total markets.** v2.1.3 added the backfill + warning for line-based markets, but the warning check used `r.line1 == null` as a defense-in-depth moneyline check. For Puck Line rows, the ranker doesn't surface `line1` on the output (because `normalizeRow` only lifts `selections.null.*` — for default keys like "-1" or "-3.5" the line lives at `selections[defaultKey].line1` and never makes it to the top level). The check evaluated `undefined == null === true` and excluded every Puck Line row from the warning. Test data included `line1` so unit tests passed; the live MCP call never got the warning. Fixed in this release.

### Fixed

- **v2.1.3 degraded-data warning now actually fires for line-based markets** (`lib/ssb-mcp-ranked-screen.js`). The warning check no longer inspects `r.line1` or `r.line` directly. It relies on `r.lineFieldMissingCount > 0` as the primary signal (the backfill code already guards on `fallbackLine !== null`, which is naturally null for moneylines, so the count is naturally 0 there) plus a defense-in-depth `market === "moneyline"` exclusion. Regression test added in `test/ssb-mcp-ranked-screen.test.js` that mirrors the live data shape (no `line1` on the row, large `lineFieldMissingCount`).

### Stats

- 826 tests passing (was 825 in v2.1.3; +1 line1-undefined regression test)
- 24 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)

## 2.1.3

**Line-history backfill + degraded-data warning for line-based markets.** The upstream SSB `/odds_history` endpoint does not return a `line` field per entry — only `odds`, `start_ts`, `end_ts`, and `liquidity`. Verified 2026-06-14: 0/874 entries had a `line` field across NHL/MLB/UFC. For line-based markets (Puck Line, Run Line, Point Spread, Total Goals/Runs/Rounds, etc.) the MCP can show the current line but cannot track line movement from history. v2.1.1 + v2.1.2 shipped the spread-alias fix but the underlying line-history data is missing upstream. This release adds a defensive local fallback and surfaces the degraded state honestly.

### Changed

- **Line values are now backfilled into history entries from the row's current line** (`lib/ssb-history.js`, `lib/ssb-screen-history.js`). When the upstream response is missing the `line` field, the MCP writes the matched row's current line (`matchedRow.line1` / `line2` / `line`) into each entry. This makes the entries self-consistent and unblocks downstream consumers that read `entry.line` unconditionally. Moneylines (legitimate `line: null`) are not backfilled.
- **New degraded-data warning** in `resultMeta.warnings` (`lib/ssb-mcp-ranked-screen.js`): when non-moneyline rows had line values backfilled, the response now reads `"Line values missing from upstream history for N/M non-moneyline rows (K entries backfilled from current line). Line-movement detection is degraded for this slate."` Users see the degraded state instead of a silent `line: null` everywhere.

### Stats

- 825 tests passing (was 819 in v2.1.2; +6 line-history backfill tests)
- 24 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)

### Honesty note

The v2.1.1 / v2.1.2 release notes claimed a "spread-alias regression fix" that resolved `MARKET_ALIASES.spread` / `.handicap` to per-league canonical names. The alias resolution is correct. The line-movement tracking it was implicitly claiming to enable is not — the upstream data doesn't carry per-entry line values. This release closes the loop: the alias works, the line-history entries are now self-consistent, and the degraded state is visible to users. Tracked upstream separately.

## 2.1.2

**UFC / Soccer screen_ranked hotfix.** 2 hours after v2.1.1 shipped, a live test against the UFC card revealed that `screen_ranked` was returning 0 rows for any league where the default focus book (Pinnacle) didn't post moneylines. Same root cause hit any non-major league passed to the focused tool. Algorithm, tier system, and tool surface unchanged.

### Fixed

- **`screen_ranked` returned 0 rows for UFC / Soccer** (`scripts/server/handlers.js`, `lib/screen-parser.js`). The handler was defaulting `focusBook` to `preset.preferredBooks[0]` (Pinnacle) even when the user didn't specify one. `extractScreenRows` then applied a `focusPlays` filter that dropped every row whose odds didn't include Pinnacle — which is every UFC row, since Pinnacle doesn't post UFC moneylines in the live data feed. Fix: `screen_ranked` now only sets `focusBook` when the user explicitly passes `books`; otherwise `focusPlays` is empty and the row expansion covers all books in the payload. Defensive follow-up: `extractScreenRows` now falls back to "all books in the row" if the requested focus book has no odds in that row (the "best effort" intent of the focus feature). 1 new regression test in `test/handler-integration.test.js` asserts the fix against a fixture mirroring the live 2026-06-14 data shape (Pinnacle absent, BetOnline/Caesars/FanDuel/DraftKings present).

### Stats

- 819 tests passing (was 818 in v2.1.1; +1 UFC regression test)
- 24 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)
- TIER 4 ≤ TIER 2 inversion: still holds (49.7% ≤ 49.9%)

## 2.1.1

**Fantasy Optimizer tool, spread-alias regression fix, and auth-file permission tightening.** Closes 3 high-priority items from the June 14 deep audit.

### Added

- **Fantasy Optimizer tool** — new `fantasy_optimizer` MCP tool for DFS-style fantasy picks (PrizePicks, Underdog, etc.). Requires a paid PropProfessor subscription with Fantasy Optimizer access. Query by league, fantasy app, market, min/max odds/value, and more. 24 total tools now exposed (was 23 in v2.1.0).
- **Player-name sanitizer for `player_context` xurl escalation** — `sanitizePlayerName()` in `lib/ssb-player-context.js` now allowlist-validates player names (Unicode letters/numbers + space + `.'-`) before passing them to the xurl CLI via `cp.execFile`. Rejects empty input, flag-like strings (`--help`), shell metacharacters, emoji, and inputs over 100 chars. Surfaced as a clean `source: "xurl-failed"` response rather than a malformed CLI invocation. June 8 SEC-001 partial fix.

### Fixed

- **Auth file permissions tightened (SEC-003)** — `pp-query login`, `installAuthFile`, and the token cache now write `0o600` (owner read/write only) and `chmod` to enforce on existing files. The auth.json and token-cache.json files previously inherited the system default `0644`, which let any other local user on the box read the bearer token / cookie jar — full account impersonation against SSB. 2 new regression tests cover the new mode bits. Closes the June 8 high-severity finding.
- **Spread alias wrong for basketball/football/soccer** (`lib/ssb-shared-utils.js` + `lib/ssb-sharp-books.js`). `MARKET_ALIASES.spread` and `.handicap` resolved to `"Spread"` for NBA/WNBA/NCAAB/NCAAF/NFL/SOCCER, but the live SSB `/screen` endpoint serves those leagues as `"Point Spread"`. Every spread query on those leagues returned an empty payload. Discovered 2026-06-12 when a WNBA `novig_screen` with `markets=["Spread"]` returned 0 candidates but `find_best_price(market="Point Spread")` returned 19 books. Tennis was unaffected because `normalizeTennisMarketQuery()` expands `"Spread"` to `["Game Handicap", "Set Handicap", "Point Spread"]` before the screen call. `ALT_MARKET_BOOKS` keys renamed to match the new canonical name; 4 new regression tests added.
- **SECURITY.md support matrix** — was reporting v1.0.x as the only supported release (project is at v2.1.x). Now lists 2.0.x / 2.1.x as supported, 1.7.x as security-fixes-only, and pre-1.7 as unsupported. First thing a vuln researcher reads — previously implied the project was abandoned since v1.0.x.

### Changed

- **install.py** now (a) parses the JSON output of `pp-query setup` to print a human-readable "created at <path>" / "kept existing at <path>" line instead of a raw JSON blob, and (b) honors the `AUTH_FILE` env var when present instead of always overriding with the default path. 1 new regression test verifies the env passthrough.
- **README** "Status" + "What's new" sections updated to reflect v2.1.1 (previously the v2.1.1 WIP was claiming v2.1.0 included Fantasy Optimizer, which it did not — v2.1.0 shipped without it).

### Stats

- 818 tests passing (was 784 in v2.1.0; +34 net: 19 fantasy-optimizer, 8 sanitizer, 4 spread-alias, 2 SEC-003, 1 install.py env passthrough)
- 24 tools (was 23, +1 fantasy_optimizer)
- Python tests: 12 (was 11, +1 env passthrough)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged — algorithm untouched)
- TIER 4 ≤ TIER 2 inversion: still holds (49.7% ≤ 49.9%)
- Lib files: 31 (unchanged)
- Server entry: 158 lines (unchanged from v2.0.0)
- Handlers: 1,804 → 1,847 lines (+43 for fantasy_optimizer)

## 2.1.0

**Hermes Plugin Conversion (Apollo-Style Install).** This release adds the Apollo-style one-command install flow. No behavior change to the 23 MCP tools.

### Added

- `make install` — one-command install: links the `ssb-coach` skill into hermes, registers the MCP server, installs the default config
- `make install-cron` — registers the optional `ssb-alerts` sharp-money cron
- `make uninstall` — reverses both
- `scripts/install.py` — idempotent Python installer (stdlib only, no pip deps)
- `scripts/install_helpers.py` + `scripts/test_install_helpers.py` — hermes path/profile resolution helpers with tests
- `bin/pp` — thin CLI wrapper for `pp hide / unhide / hidden / sync / doctor / today`
- `config.default.json` — ships sane defaults (league=NBA, bankroll=1000, targetBook=NoVigApp)
- `pp-query setup` — copies the default config to `~/.ssb-for-agents/config.json`
- `skills/ssb-coach/SKILL.md` — operator-facing coach skill (auto-routes "what should I bet today" to the right tools)
- `docs/cron-prompts/sharp-money-alert.md` — cron prompt template
- `INSTALL.md` — 60-second quick-start

### Behavior

- The 23 MCP tools and 784-test suite are unchanged. Pure packaging work.
- `hermes mcp add ssb` is unchanged in shape — the installer just automates the config edit that users previously did manually.

### Migration

- Existing users: re-running `make install` is a no-op. New install gets the skill symlink + config.
- The 3 hermes-side `ssb-*` skills in `~/.hermes/skills/` are unchanged. The new coach skill ships in the repo and gets linked separately.

## 2.0.1

### Docs

Pre-directory polish. The README's polish checklist from v1.6.1 (repo description, Mermaid diagram, FAQ, docs map, install path verification) was already comprehensive. v2.0.1 ships two targeted fixes for drift:

- **FAQ "TIER 1 hit rate"** — updated from the v1.5.5-era 580-play sample to the current 575-play backtest count. Honest framing: hit rate sits around chance (~50%) on a ~575-play synthetic backtest. Numbers drift slightly with the random seed; the round claim is stable.
- **Status section "Latest release"** — was a generic pointer to the releases page. Now names v2.0.0 specifically with a one-line description of what it was, so directory visitors landing on the README see the most recent release at a glance.

Install path verification: `node scripts/ssb-mcp-server.js` boots clean, NDJSON framing works end-to-end, `initialize` + `tools/list` returns all 23 tools, `npm link --dry-run` confirms the `pp-mcp` / `pp-query` binaries would install. No code changes; no behavior change.

## 2.0.0

### Refactor

Lib organization, part 2 of 2. The 23 `createMcpHandlers()` tool implementations (~1,730 lines) are extracted from `scripts/ssb-mcp-server.js` into `scripts/server/handlers.js`. The JSON-RPC frame (`createMcpServer`) and the stdio serve loop stay in the entry point; `handlers.js` is a leaf that the entry re-exports from for backward compatibility with existing imports. Algorithm, tier system, and tool surface unchanged. No user-facing behavior changes.

### Bug fix

A v1.7.0 leftover from the planned-but-incomplete v2.0.0 refactor: the previous server file dropped its `module.exports` block, which would have broken every external importer (CLI scripts, tests, downstream tools). The v2.0.0 entry point restores the exports block and prunes 9 dead imports/consts the partial refactor had carried into `handlers.js` (`createJsonRpcSuccess`, `createJsonRpcError`, `encodeMessage`, `createStdioMessageReader`, `buildToolDefinitions`, `clearTierCache`, `SERVER_NAME`, `SERVER_VERSION`, `PROTOCOL_VERSION` — all server-level, none of which belong in a leaf module). `mapWithConcurrency` (a top-level helper) is also re-exported from the new leaf so existing test imports still resolve.

### Stats

- 784 tests passing (unchanged from 1.7.0)
- 23 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)
- TIER 4 ≤ TIER 2 inversion: still holds (49.7% ≤ 49.9%)
- Server entry: 1,861 → 158 lines
- New leaf: `scripts/server/handlers.js` (1,730 lines)
- Lib files: 31 (unchanged)

## 1.7.0

### Refactor

Lib organization, part 1 of 2. Structural cleanup with no user-facing behavior changes. The algorithm, tier system, and tool surface are unchanged.

- **Tennis files merged** — `lib/ssb-tennis-times.js` and `lib/ssb-tennis-names.js` → `lib/ssb-tennis.js`. Both files were tennis-specific helpers (player name resolution, ESPN-backed match time correction) that were needlessly split. The merged file has a single `module.exports` exposing the union of the old APIs: `PLAYER_NAMES`, `resolvePlayerName`, `getNameSlug`, `correctTennisTimes`, `fetchEspnMatches`, `nameSimilarity`, `formatCentralTime`, `isPlaceholderTime`. All import sites updated.

### Stats

- 784 tests passing (unchanged)
- 23 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged)
- TIER 4 ≤ TIER 2 inversion: still holds
- Lib files: 32 → 31

## 1.6.3

### Refactor

Tool surface consolidation. Two of the findings from the June 11 audit, folded into one release. The algorithm, tier system, and CLI surface are unchanged — only the tool catalogue.

- **`screen_raw` removed** — was a thin wrapper around `client.queryScreenOdds` with no ranking, hydration, or formatter. Use `screen_ranked` with `verbosity="full"` instead, which already exposes the same raw payload plus ranking metadata, consensus, movement, and freshness.
- **Four bet-management tools consolidated into one** — `get_hidden_bets` + `hide_bet` + `unhide_bet` + `clear_hidden_bets` → `manage_hidden_bets({ action, bet?, id? })`. `action='list' | 'hide' | 'unhide' | 'clear'`. Same underlying client methods, just one tool name to learn. `action` is required; `bet` required for `hide`; `id` required for `unhide`.

### Stats

- 784 tests passing (-4 net: 3 screen_raw tests + 1 get_started test removed, all referenced decommissioned tools)
- 23 tools (was 27, -4)
- TIER 1 hit rate: 51.5% on 575 plays (unchanged from v1.6.2)
- TIER 4 ≤ TIER 2 inversion: still holds

## 1.6.4 — Bug fixes (addendum)

**Addendum note:** This release section captures a set of bug fixes, feature changes, and test updates that shipped in the codebase between v1.6.3 and v1.7.0 but were never migrated out of the `Unreleased` bucket in the changelog. The code changes themselves (commits `dbc7636` through `c117450`) are present in every release tag from v1.6.3 onward. This section exists so the versioned history matches the shipped code.

### Bug fix

- **`sharp_plays` now requires real sharp book confirmation for `Bet candidate` rows** — fixed the NoVigApp "consensus gap" where `consensusBookCount` was always 0 (NoVigApp is a P2P exchange, not a bookmaker, so its no-vig lines never matched any other book exactly). Each sharp book's screen is now cross-referenced individually to find independent supportive movement on the same game+selection. New row fields: `sharpBookMovementConfirmed`, `sharpBookMovementSource`, `sharpBookClv` — populated when a sharp book independently confirms the play. `movementIsSharpSourced` now accepts `sharpBookMovementConfirmed` as an alternative to traditional independent sharp movement. Misleading pass reasons (`no_usable_line_history`, `movement_source_is_target_book`, etc.) are suppressed when sharp book confirmation exists.
- **Removed unsound fallback paths in `classifySharpPlay`** — `consensusEdgeOnlyOk`, `consensusOnlyOk`, and `clvOnlyOk` were previously accepted as `Bet candidate` paths based on consensus edge or CLV alone without actual sharp movement confirmation. All `Bet candidates` now require either traditional `movementIsSharpSourced` (independent sharp book movement) or `sharpBookMovementConfirmed` (sharp book cross-reference). Also removed the `consensusValidated` path and the now-unused variables (`hasConsensusEdge`, `clvValue`, `movementLabelOk`, `movementUnverifiable`). Simplified pass reason logic — no longer conditional on fallback flags.

### Feature

- **Nitter RSS as primary tweet source in `player_context`** — `player_context` now tries Nitter RSS first (fast, no auth, local instance via `NITTER_BASE` env var, default `http://localhost:8080`). Fallback chain: Nitter RSS → X GraphQL (nitter-session-api) → Google News RSS → ESPN search. New source labels: `nitter-rss`, `nitter-combined`, `news-fallback` (previously only `x-direct`, `combined`, `empty`). New helper: `searchNitterRSS()` in `lib/ssb-news-sources.js` with RSS parsing that handles both Google News and Nitter RSS formats (`<dc:creator>` for author).
- **`skipHistory: boolean` param on screen tools** — added to `screen_ranked`, `recommended_bets`, `all_slates`, `staking_plan`, and `sharp_consensus`. When `true`, skips odds history hydration entirely — useful when you only need current odds/edges and don't need movement data. Propagated through all handler call chains: `recommended_bets` → `screen_ranked`, `staking_plan` → `recommended_bets`, `all_slates` → `runLeagueScreen`/`runTennisScreen`, `sharp_consensus` → `screen_ranked`. `sharp_plays` already supported it via `...args` spread in `runSharpPlays` service. Companion to `compact`: `compact` only affects output formatting, not data hydration — use `skipHistory` to skip hydration.

### Docs

- **Compact mode description fix** — clarified the `compact` param description across all tools: "Does NOT affect history hydration — movement data is always fetched." Previously the wording implied `compact` skipped history. Aligns the tool description with actual behavior (post-fix: `compact` is purely a payload-shaping flag, hydration always runs).

### Stats

- 784 tests passing (was 784 in v1.6.3; test count for this addendum window unchanged because the affected modules' tests were updated in-place rather than added/removed)
- 23 tools (unchanged)
- Tool count: 23 (unchanged)

## 1.6.2

### Bug fix

Response-layer cleanup. Three high-impact issues found in the June 11, 2026 code+response audit. The algorithm, tier system, and tool surface are unchanged — only how the data is shaped before it leaves the server.

- **CLI `--verbosity` is now wired through to the MCP handler** (`scripts/query-ssb.js`). Before: `--verbosity minimal` was silently dropped on the floor for the `sharp-plays` command, so the CLI always returned the raw 144KB payload regardless of the flag. After: `--verbosity minimal|standard|full` works end-to-end. The MCP server (line 861) was already wired correctly — this is CLI-only.
- **Response rows are now compacted at extraction** — null, empty-string, empty-array, and empty-object fields are stripped before the formatter runs. Applied to `sharp-plays`, `screen_ranked` (via `buildRankedScreenResponse`), and `find_best_price` (`allPrices`). The new `compactRow` helper lives in `lib/ssb-shared-utils.js`. Response payload drops ~96% for typical sharp-plays output (144KB → ~5KB for 3 plays). Empty fields were noise; the data users actually want is unchanged.
- **`selections.null` and `defaultKey: "null"` string leaks fixed at extraction** — PropProfessor's API uses the literal string `"null"` as a key to mean "no sub-market" (moneyline, spread, total). Before: that string leaked through to consumers as a real key. After: `normalizeRow` lifts `selections.null.*` to top level for non-prop markets and drops `defaultKey: "null"`. Player-prop selections (which use real player names as keys) are untouched.

### Stats

- 788 tests passing (was 775, +13)
- 27 tools (unchanged)
- TIER 1 hit rate: 51.5% on 575 plays (was ~50% on smaller sample — within noise)
- TIER 4 ≤ TIER 2 inversion: still holds (49.7% ≤ 49.9%)

## 1.6.1

### Docs

Pre-directory-submission polish. No code changes — the algorithm, tools, and tests are all unchanged from v1.6.0.

- **Repo description updated** — from "Standalone SSB MCP server and query client" to "MCP server that surfaces sharp-money movement across 36 sportsbooks — signal feed, not betting oracle." This is what `mcp.so`, `awesome-mcp`, and other directory listings display as the first-glance summary.
- **Mermaid architecture diagram added** in the README — shows the data flow from 36 sportsbooks → PropProfessor API → ranking pipeline → 27 MCP tools → your AI agent. Renders natively in GitHub; makes the value prop visual in 5 seconds for directory visitors.
- **"How the ranking works" section trimmed** — the 5-step methodology (movement grading, risk score weights, tier table, hysteresis, sharp book cross-reference) moved to [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md). The README now has a 1-paragraph summary + link. Reduces README from 397 → 389 lines, makes the visible content more scannable.
- **FAQ section added** — answers the 5 questions directory visitors ask first: "Does this tell me what to bet?" (no, it surfaces signals), "Do I need an account?" (yes, paid PropProfessor), "What books does it cover?" (36), "Is it free?" (code is MIT, data is paid), "Can I run it without an MCP client?" (yes, `pp-query` CLI).

### Verified working (no fix shipped)

- `npm install` clean
- `pp-query health` returns valid auth token against live PropProfessor API
- Server boots cleanly (1.5s startup, no errors)
- `node scripts/backtest-synthetic.js` produces expected distribution (575 TIER 1 plays per 3000-scenario run, TIER 4 ≤ TIER 2 holds)

### Stats

- 775 tests passing (unchanged)
- 0 open issues
- 0 open PRs
- Tool count: 27 (unchanged)
- Algorithm: unchanged

## 1.6.0

### Pivot: sharp-money signal feed, not betting oracle

**The core finding from v1.5.5:** the synthetic backtest reliably shows the algorithm is finding coordinated sharp-money movement correctly (TIER 4 ≤ TIER 2 inversion holds, tier ordering is correct), but it does **not** reliably predict outcomes (TIER 1 hit rate is ~50% on a 580-play sample). The honest product positioning is a **sharp-money signal feed** — telling you _what sharp books are doing_ so you can decide what to bet, not telling you _what will happen_.

This release is a positioning + messaging change, not an algorithm change. The ranking pipeline, risk score, tier system, kaiCall semantics, and tool surface are unchanged. What changes is how the README and tool descriptions frame the system.

### Docs

- **README hero and intro reframed** — from "turns your AI agent into a sharp / tell you what to bet" to "shows you what the sharp money is doing / surface the sharp moves and let you decide". Added an explicit "Honest scope" callout that the system is a signal feed, not a betting oracle.
- **"The numbers" section reframed** — replaced "TIER 1 hit rate target: >60%" with measurement of _signal quality_ (tier ordering, steam move detection, line lag detection) rather than _predictive power_. The "what this means in practice" callout makes it explicit: trust the signal, not the outcome prediction.
- **"What you can ask your agent" prompts reframed** — replaced "Find me moneyline value on Lakers" with "What are tonight's strongest coordinated sharp moves across NBA and NHL?" and similar observation-focused prompts. The optional bet-tracking prompts are explicitly marked as optional.
- **"All 27 tools" section reframed** — user-type categories renamed from "casual/intermediate/sharp bettors" to "quick situational checks / deeper signal analysis / full raw data and research" (about _data depth_, not betting style). The "Betting" category is renamed to "Flagged Plays". `staking_plan` description now reads "for picks you decide to place" instead of just "Fractional Kelly sizing".
- **"See it in action" example reframed** — example prompt and lead text updated to emphasize signal quality, not action. The output JSON is unchanged because it's accurate — the framing around it is what changed.

### Tool definitions

- `recommended_bets` description updated — explicitly states the tier/kaiCall are quality ratings on the movement data, NOT predictions about outcomes. Use this as your "what is sharp money doing right now" tool.
- `get_started` description updated — clarifies that "casual/intermediate/sharp" labels are about data depth, not betting style.

### Stats

- 775 tests passing (unchanged)
- 0 open issues
- 0 open PRs
- Tool count: 27 (verified consistent across definitions, OpenAPI spec, and README by `check:claims`)
- Algorithm: unchanged. TIER 1 hit rate, risk-scoring weights, tier assignment table, and kaiCall semantics are identical to v1.5.5.

## 1.5.5

### Bug fix

- **Synthetic backtest was producing 99% TIER 4 plays** — the scenario generator had two compounding bugs that made the README's "TIER 1 hit rate" claim statistically meaningless:
  1. **Only 7 books** in the scenario — couldn't reach the `consensusBookCount >= 10` bonus needed for TIER 1 in the risk score. Expanded to 12 books (production has ~36; 12 is a representative subset).
  2. **Per-scenario tier cache and score timeline were not reset** between iterations in the backtest loop. The hysteresis layer in `lib/ssb-risk-score.js` is module-level global state — once a play got assigned TIER 4 early in the run, the cache and timeline kept it there for the rest of the backtest. Added `clearTierCache()` + `clearScoreTimeline()` calls at the start of each scenario.
- Added a new `strong_sharp_move` scenario type (15% of the mix) that produces the coordinated sharp-book movement the ranking pipeline needs to assign TIER 1. Updated the scenario mix to: 15% strong_sharp_move / 25% sharp_move / 30% stable_no_edge / 30% adverse. Without this scenario type, the ranking pipeline never had a realistic chance to assign TIER 1.

### Docs

- **README "The numbers" section corrected** — the v1.5.3-era claim of "55.9% TIER 1 hit rate" and "+6.9 to +7.2pp TIER 1 vs TIER 3 gap" was based on a 3-5 play sample (noise). The new backtest produces a stable distribution across seeds:
  - TIER 1 hit rate: **48.9% to 52.4%** (avg ~50.7%) on ~580 plays per 3000 scenarios
  - TIER 1 vs TIER 3 gap: **+0.3 to +3.1pp** (avg ~1.2pp)
  - TIER 4 ≤ TIER 2 inversion: **holds in 4 of 6 seeds** (the v1.5.1 fix is directionally correct, but the synthetic backtest is still noisy)

  The honest read: the ranking algorithm is finding some edge (TIER 1 > TIER 3) but it's small. The v1.6.0 milestone ("TIER 1 hit rate from 55.9% to >60%") has a longer road than the v1.5.3-era changelog suggested — the real baseline is ~50%, and reaching 60% requires meaningful algorithm work, not just backtest noise reduction.

### Chore

- **`check:claims` now requires at least 100 TIER 1 plays per 3000-scenario backtest** before it considers the TIER 1 sample size meaningful. Below that threshold, the hit rate is just noise and any "X% TIER 1 hit rate" claim is unsupportable. The v1.5.3-era backtest produced 3-5 TIER 1 plays per run; the new backtest produces ~580.
- Added a test that verifies all 4 tiers produce plays (guards against the "99% TIER 4" failure mode recurring) and that the TIER 1 sample size meets the 100-play minimum.

### Stats

- 775 tests passing (was 774 — added `runBacktest produces enough TIER 1 plays for a meaningful hit rate` test)
- 0 open issues
- 0 open PRs
- Tool count: 27 (verified consistent across definitions, OpenAPI spec, and README by `check:claims`)

## 1.5.4

### Docs

- **README test count corrected** — bumped from 773 to 774 to match the v1.5.3 changelog (which already noted the +1 from `test/backtest-daily-snapshot.test.js`). Updated the badge, "The numbers" table, Status section, and maintainers section. The shipped v1.5.3 README was internally inconsistent — the changelog and the codebase agreed on 774, the README didn't.

### Chore

- **Added `npm run check:claims`** — automates the pre-release claim-drift checks that the `ssb-mcp-release-format` skill documents. Verifies that the README's tool count matches the tool definitions and the OpenAPI spec, that every tool referenced in the "All N tools" section actually exists, that the test count matches `npm test` output, and that the TIER 4 ≤ TIER 2 inversion claim is directionally supported. Runs in 1.1s with `--skip-tests`, 5.2s full. This is the script that would have caught the test-count drift above on the v1.5.3 release — flagging the issue at the source instead of leaking into a shipped README.
- **Deleted 3 stale branches** — `fix/novig-screen-research-and-filtering` (already merged), `release/v1.3.0-market-freshness-overhaul` and `release/v1.4.0-dx-and-cleanup` (long-since shipped release branches). Cleanup only, no code impact.

### Stats

- 774 tests passing (unchanged)
- Open issues: 0
- Open PRs: 0
- Tool count: 27 (verified consistent across definitions, OpenAPI spec, and README by `check:claims`)

## 1.5.3

### Bug fix

- **Cron data pollution** — `scripts/backtest-daily-snapshot.js` now validates the league parameter against a supported-league list (`NBA`, `MLB`, `NHL`, `NFL`, `WNBA`, `UFC`, `TENNIS`, `SOCCER`, `NCAAB`, `NCAAF`) before writing snapshot files. Previously, any league the upstream API returned — including garbage values like `NONEXISTENT_LEAGUE_999` — was being persisted to `backtest-data/`. The script also no longer auto-runs its `main()` on `require()` (now guarded by `require.main === module`), so importing it from tests no longer kicks off the cron job.
- **Tool count drift** — `clear_score_timeline` is now registered in the OpenAPI spec generator (`scripts/generate-openapi-spec.js`), bringing the tool count to **27** across README, code, and OpenAPI. Previously the tool was implemented in the server and pinned in the integration tests, but missing from the auto-generated API spec.

### Chore

- **Removed dangling `audit:sharp-research` npm script** — `package.json` referenced `scripts/audit-sharp-play-research.js` which never existed. Zero callers in the codebase, docs, or CI. The dead reference is gone.

### Housekeeping

- **Closed 9 stale v1.3.0 issues** (#20–#28) — all were already shipped in v1.3.0–v1.4.0. Closed retroactively with references to the shipping commits so the issues tab no longer shows a misleading "9 open enhancement issues all targeting v1.3.0."

### Stats

- 774 tests passing (was 773 — added `test/backtest-daily-snapshot.test.js`)
- README tool count: 26 → 27
- OpenAPI spec endpoints: 26 → 27
- Zero algorithm changes. TIER 1 hit rate, risk-scoring weights, tier assignment table, and kaiCall semantics are unchanged from v1.5.2.
- TIER 1 hit rate work (the 55.9% → 60% gap) is deferred to v1.6.0.

## 1.5.2

### New README

The README has been rewritten from scratch to be useful to a sports bettor who landed in a GitHub directory listing — not just a developer wiring up an MCP.

**What changed:**

- Hero section with a real example output from `recommended_bets` so visitors can see what the tool returns in 5 seconds, before installing
- "The numbers" section leads with backtest results (TIER 1 hit rate, TIER 1 vs TIER 3 gap, TIER 4 inversion fix) — the proof, not promises
- "What you can ask your agent" section groups example prompts by bettor scenario (pre-game, line shopping, validation, sizing, player context) — use cases before the tool list
- "How the ranking works" is now a full methodology section explaining the green/yellow/red movement grade, the 1–10 risk score formula, the tier assignment table, the hysteresis layer, and the kaiCall semantics. Math-first, no hand-waving. This is the moat.
- "Backtesting" section explains both the synthetic backtest and the daily-snapshot cron, with thresholds for what healthy tier ordering looks like
- "Support this project" is a small tip-jar section — community-funded, no upsell
- Demo workflow uses a realistic Lakers @ Celtics example instead of placeholder text

**What was moved out of the README to `docs/`:**

- Performance flags (`compact`, `skipHistory`, `fields`, `include`, `verbosity`, cache, `caveman-shrink`) → `docs/PERFORMANCE.md`
- Environment variables and book configuration → `CONFIG.md` (expanded; was a thin table, now full reference)

**What was cut:**

- "Verified Runtime Behavior (2026-06-06)" — stale by definition. The live CI badge replaces it.
- "For Maintainers" hardcoded test count (now generated from `npm test`)

### Stats

- 773 tests passing
- 82% statement coverage
- README is now 357 lines (was 367) but with substantially more useful content and 100% of the methodology

## 1.5.1

### Fix: TIER 4 > TIER 2 inversion

The `gradeMovementQuality` function was marking `insufficient_history` plays as RED, which buried ~50% of plays as TIER 4 even when they were coin-flip plays with no negative signal. This caused TIER 4 hit rate to exceed TIER 2.

**Root cause:** `noMovementData = movementLabel === 'insufficient_history' && edge < 0.5` was a RED condition. Missing history data is not an adverse signal — it's just absence of data.

**Fix:** Removed `noMovementData` from RED conditions. Now only genuinely adverse signals (`movementLabel === 'adverse'`) or bad execution with thin consensus trigger RED.

**Backtest results (3000 scenarios, before → after):**

- TIER 4 vs TIER 2: was inverted (50.6% > 47.8%) → now correct (48.6% < 53.2%)
- TIER 1 vs TIER 3 gap: 6.9pp → 7.2pp (improved)
- Tier ordering: TIER 1/2 > TIER 3 > TIER 4 (clean)

### Improved synthetic backtest generator

Scenario generator now creates three distinct scenario types with real edge conditions:

- `sharp_move` (35%): Sharp books moved, target book is stale → should be TIER 1/2
- `stable_no_edge` (35%): All books agree, no edge → should be TIER 3/4
- `adverse` (30%): Sharp books moving against the pick → should be TIER 4

## 1.5.0

### Token refresh mutex

Concurrent requests that trigger 401s now share a single token refresh instead of each independently calling `fetchAccessToken`. The `tokenRefreshPromise` singleton in `createSSBClient` ensures only one refresh happens at a time — subsequent callers wait for the same promise.

- 3 new tests: concurrent refresh dedup, refresh-after-expiry, concurrent invalidation wait
- Reduces unnecessary API calls to PropProfessor's token endpoint under load

### Synthetic backtest validation

`scripts/backtest-synthetic.js` — runs the full ranking pipeline (extract → hydrate → rank → tier) against synthetic scenarios with known outcomes. Reports per-tier hit rates and validates tier differentiation.

**Results (500 scenarios):**

- TIER 1: 55.9% hit rate (borderline — target is >60%)
- TIER 1 vs TIER 3 gap: +6.9pp — system differentiates quality
- TIER 4 > TIER 2: red flag — risk flags need tuning

**Files:**

- `scripts/backtest-synthetic.js` — scenario generator + backtest runner + reporting
- `test/backtest-synthetic.test.js` — 6 tests for scenario generation and backtest execution

### Test count

717 tests total, 717 passing.

## 1.4.2

### Fixture-based handler integration tests

Offline tests for all major MCP handlers — no auth, no network, no API dependency.

**New files:**

- `test/fixtures/screen-payloads.js` — 3 NBA games + 1 MLB game across 5 books with deliberate odds differences (consensus, sharp movement, split market)
- `test/fixtures/odds-history.js` — odds history with steam moves, gradual drift, and stable lines
- `test/fixtures/mock-client.js` — shared mock client factory with call tracking and customizable payloads
- `test/handler-integration.test.js` — 26 tests across 11 suites

**Handlers tested:**

- `screen_ranked` (7 tests) — ranking, limit, compact, fields, Spread, Total
- `screen` (2 tests) — NBA, MLB league-specific
- `sharp_plays` (3 tests) — resultMeta, Fliff lag detection, multi-league
- `recommended_bets` (3 tests) — tier/kai structure, targetTiers filter, marketsBreakdown
- `staking_plan` (1 test) — stake allocation structure
- `find_best_price` (1 test) — line shopping across books, price sorting
- `all_slates` (2 tests) — consolidated results, multi-league
- `health_status` (1 test) — auth session info
- `league_presets` (1 test) — no client calls
- `ev_candidates` (2 tests) — validation, result structure
- `error handling` (3 tests) — empty game_data, missing selections, empty leagues

**Test count:** 708 total (707 pass, 1 pre-existing live smoke failure).

## 1.4.1

### Auth session expiry detection

Session cookie (`__Secure-next-auth.session-token`) TTL is now parsed from `auth.json` and surfaced everywhere:

- **`health_status` MCP tool** — returns `auth.session` with `status`, `expiresAt`, `daysRemaining`, and `warning`
- **`pp-query doctor`** — `summary` now includes `session`, `sessionExpiresAt`, `sessionDaysRemaining`, `sessionWarning`; next-step guidance changes based on expiry status
- **`inspectAuthSetup()`** — new `sessionExpiry` field with full cookie analysis
- **`getCookieExpiryInfo()`** — new exported function, reusable across CLI and MCP

Status levels: `ok` (>7d), `warning` (3–7d), `critical` (≤3d), `expired` (≤0d).

### Auth watchdog cron script

`scripts/pp-auth-watchdog.js` — standalone script for Hermes cron (`no_agent: true`). Silent when healthy, outputs a warning when session is expiring or expired. No tokens consumed.

### Tests

8 new tests for `getCookieExpiryInfo` covering ok/warning/critical/expired/no_auth/no_session_token/browser_session_only/allCookieExpiries. Total: 682 passing.

## 1.4.0

### Removed TIER 4 fallback from recommended_bets

When no TIER 1/2 plays exist, `recommended_bets` now returns 0 plays instead of falling back to `sharp_plays` with `strict=false` and `includePasses=true`. The previous fallback surfaced TIER 4 plays, contradicting the "never bet TIER 4" philosophy.

### Fixed tool descriptions

- `sharp_plays` `markets` param description now correctly states default is `["Moneyline", "Spread", "Total"]` (was "default Moneyline")
- `novig_screen` `markets` param description updated similarly
- Both tools already scanned all three markets — only the descriptions were wrong

### Navigable server architecture

`ssb-mcp-server.js` handlers grouped into domain sections:

- Screening & Ranking (7 handlers)
- Sharp Movement (2 handlers)
- Betting (2 handlers)
- Player Context, UFC, Bet Management, Line Shopping, Meta, Picks, Alerts

Full file split into separate modules deferred to v1.5 — cross-handler dependencies need integration tests first.

### DX improvements

- Added "What's New in v1.4.0" section to README
- Added expanded troubleshooting section to SETUP.md covering common issues (auth expiry, 0 tools, no bets found, timeouts)

## 1.3.0

### Market Name Normalization (Phase 3)

**Generic aliases now resolve per-league** — query `market="Total"` for any league and get the correct upstream market name:

| Alias  | NHL         | MLB        | NBA          | WNBA/SOCCER                |
| ------ | ----------- | ---------- | ------------ | -------------------------- |
| Total  | Total Goals | Total Runs | Total Points | Total Points / Total Goals |
| Spread | Puck Line   | Run Line   | Spread       | Spread                     |

**New function:** `resolveMarketName(input, league)` in `ssb-shared-utils.js`

- Returns `{ resolved, wasAliased, original, aliasKey }`
- Handles case-insensitive input, whitespace, and shorthand (`rl`, `pl`)

**Applied to all 10 MCP entry points:**

- `screen`, `screen_ranked`, `raw_screen`
- `recommended_bets`, `staking_plan`
- `sharp_plays`, `sharp_consensus`
- `all_slates`, `novig_screen`
- `find_best_price`, `get_play_details`
- `ufc_card`

**New `markets_alias_used` field** in `resultMeta` when aliases were resolved:

```
"markets_alias_used": ["Total → Total Goals"]
```

**Tests:** 28 new test cases in `test/market-aliases.test.js` covering:

- All league/alias combinations
- Case insensitivity and whitespace
- Shorthand aliases (`rl`, `pl`)
- Passthrough for non-alias inputs
- Default Moneyline when empty

**595 tests passing** (594 from v1.2.0 + 28 new - 27 existing adjusted for correct alias behavior)

### Freshness Engine (Diagnosed — No Code Change Needed)

Phase 1 investigation found the `freshnessFallbackUsed: true` flag is **not a bug** — the upstream SSB `/screen` API simply doesn't include timestamp fields on rows. The fallback code already handles this correctly:

- Scoring (`edge`/`tier`/`kai`) still populates even in fallback mode
- `newestAgeMs: 0` / `oldestAgeMs: 0` is the correct response to missing upstream data
- `timestampSources: { response_received: N }` correctly reports what's available

**G1 goal ("freshnessFallbackUsed: false on healthy responses") is not achievable** without upstream SSB changes.

### Notes

- Branch: `release/v1.3.0-market-freshness-overhaul`
- Phase 5 (Token persistence) complete
- Phase 6 (Tool descriptions) complete
- Phase 7 (Verbosity) complete
- Phase 8 (Tests) complete — 674 tests

### marketsBreakdown in recommended_bets

**New `marketsBreakdown` field** in `recommended_bets` response showing play count by market type:

```json
"marketsBreakdown": { "Moneyline": 3, "Spread": 1, "Total": 0 }
```

Makes it transparent when Spread/Total have fewer plays due to upstream data quality, rather than appearing as a moneyline-only tool.

## Cross-Book Consensus Expansion (Phase 4)

**Alt markets now get expanded comparison book sets.** Previously, querying Run Line for MLB only compared against the same sharp book set as Moneyline — but Circa, BookMaker, etc. don't consistently post Run Line odds. Now:

| League | Alt Market | Books                                                              |
| ------ | ---------- | ------------------------------------------------------------------ |
| MLB    | Run Line   | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker |
| MLB    | Total Runs | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel            |
| NHL    | Puck Line  | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker |
| NBA    | Spread     | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker |

**New `consensusStrength` field** on every ranked row:

| Value      | Meaning               |
| ---------- | --------------------- |
| `strong`   | 3+ books agree        |
| `moderate` | 2 books agree         |
| `weak`     | 1 book (no consensus) |
| `none`     | 0 books               |

**New `computeWeightedConsensus()`** function for sparse book coverage — when only 1-2 books post odds, Pinnacle gets 2x weight as the sharpest source.

**Before:** MLB Run Line avg 1.7 books per selection. **After:** Main Run Line has 11+ books, alt lines have 2+.

**Docs:** `docs/MARKET-BOOK-AVAILABILITY.md` with full availability matrix.

## 1.2.0

### Universal Agent Access (Major)

**Automated Auth Flow**

- New `pp-query login` command opens browser, user logs in, auth saves automatically to `~/.ssb-for-agents/auth.json`
- No more manual cookie export — just run one command
- Added Playwright as optional dependency for browser automation
- Health endpoint now reports auth status with clear recovery instructions ("Run: pp-query login")

**Verbosity Levels**

- All bet-returning tools (`recommended_bets`, `sharp_plays`, `screen_ranked`, `screen`, `novig_screen`, `all_slates`, `staking_plan`, `ev_candidates`, `ufc_card`) now accept `verbosity: "minimal" | "standard" | "full"`
- `minimal`: Plain English for casual bettors ("Bet Bonfim at +105, high confidence, low risk")
- `standard`: Structured data without debug noise (edge, tier, risk, rationale)
- `full`: Everything — line history, movement data, debug payloads (default, backward compatible)

**Tool Discoverability**

- New `get_started` meta-tool tells agents the workflow based on user type (casual/intermediate/sharp)
- Returns structured workflow with steps, tools to use, and tools to avoid
- README now has "Tool Guide" section grouping tools by user type

**Agent Onboarding**

- `docs/AGENT_PROMPT.md` — system prompt template for agents serving bettors
- `docs/HERMES_SKILL.md` — Hermes skill file for quick context
- Covers tier system, risk scores, movement grades, workflows by user type

**Structured Error Handling**

- Error codes: `AUTH_EXPIRED`, `BACKEND_DOWN`, `RATE_LIMITED`, `BACKEND_ERROR`, `INTERNAL_ERROR`
- Each error includes recovery instructions
- Agents know exactly what to tell users when something breaks

**Backtesting**

- New `scripts/backtest.js` CLI validates tier system predicts outcomes
- `docs/BACKTESTING.md` explains usage and limitations
- Ready for historical data when available

**Stats**

- 583 tests passing (up from 489)
- 20 tools (up from 19 — added `get_started`)
- All lint checks pass

## 1.1.0

### Multi-market defaults for recommended_bets, staking_plan, sharp_plays

- `recommended_bets` now defaults to scanning Moneyline + Spread + Total markets (was Moneyline only). Queries each market per league, deduplicates by gameId+selection (keeps higher screenScore), then applies tier filtering. Returns the best plays across all markets.
- `staking_plan` inherits the same multi-market default via `recommended_bets`.
- `sharp_plays` now defaults to scanning Moneyline + Spread + Total (was Moneyline only).
- All three tools accept `markets: ["Spread"]` to override the default market list.
- `market` param preserved for backwards compatibility (treated as single-market override).
- Response includes `markets_queried: string[]` showing which markets were scanned.

### Equalized market priority weights

- Moneyline, spread, and total weights are now equal within each league's ranking preset. Previously spreads and totals had lower weights, requiring stronger signals to pass the same ranking gate.
- Props retain higher weights (harder markets to find edges in).
- Affected leagues: NBA, MLB, NFL, NHL, SOCCER, UFC, NCAAB, NCAAF, WNBA, and fallback.

### markets_queried in resultMeta

- All screen responses (`screen`, `screen_ranked`, `all_slates`, `ufc_card`) now include `resultMeta.markets_queried: string[]` indicating which markets were scanned.

### Tool description updates

- `recommended_bets`: documents multi-market default and `markets` param.
- `staking_plan`: documents multi-market inheritance.
- `sharp_plays`: documents multi-market default.
- `all_slates`: documents `markets` param.
- Added `markets` array property to `recommended_bets`, `staking_plan`, `all_slates`, and `sharp_plays` input schemas.

## 1.0.8

### Compact mode for screen/recommended/all_slates/staking_plan

- New `compact=true` param on `screen_ranked`, `screen`, `recommended_bets`, `all_slates`, and `staking_plan` tools. Strips each row to ~25 essential fields (no lineHistory, scoreBreakdown, full odds maps). Reduces response size by ~90%.
- When `compact=true`, history hydration (N+1 API calls to odds history endpoint) is skipped entirely, making compact queries 10-50x faster.
- `resultMeta.compact` flag indicates whether the response was compacted.

### `fields` param for selective field return

- New `fields: string[]` param on all screen/recommended/all_slates/staking_plan tools. Overrides `compact` when both are set.
- Example: `fields: ["game","selection","odds","edge","tier","kai"]` returns only those fields per row.
- `resultMeta.fields` lists the fields that were returned.

### `include` param for top-level metadata filtering

- New `include: string[]` param on all screen/recommended/all_slates/staking_plan tools.
- Values: `"freshness"`, `"warnings"`, `"resultMeta"`, `"league"`. Example: `include: ["resultMeta"]` returns only `ok`, `result`, and `resultMeta`.

### Response caching

- In-memory LRU cache with TTL (default 60s, configurable via `SSB_CACHE_TTL_MS`).
- Max entries: 50, configurable via `SSB_CACHE_MAX`.
- Cache hits reported via `resultMeta.cached: true`.
- Only caches full responses (not compact/fields-filtered).

### `get_play_details` MCP tool

- New tool: `get_play_details(league, game_ids)` — returns full rows (with line history, consensus, movement debug) for specific game IDs.
- Designed for the workflow: compact list → drill into selected plays.

### Lint cleanup

- Fixed 22 pre-existing lint errors across lib and test files (unused imports, duplicate keys, redundant Boolean casts).

## 1.0.7

### Screen API migration

- Migrated screen endpoint from `screen.propprofessor.com/api/retrieve-data-new` → `backend.propprofessor.com/screen`
- Now passes the full `ALL_SCREEN_BOOKS` list (36 books) by default, fixing non-major sports (Tennis, Soccer, etc.) returning only Polymarket data
- Added book name canonicalization via `canonicalizeScreenBookName()` with alias support (e.g. "rebet" → "Rebet", "propbuilder" → "Prop Builder")

### New analysis modules

- `ssb-steam-move.js` — Steam move detection integrated into screen ranking (exposes `steamMove`, `steamBooks`, `steamDirection` per row)
- `ssb-sharp-consensus.js` — Multi-window sharp consensus analysis across 1h/2h/6h/12h/24h/48h windows
- `ssb-best-price.js` — Line shopping: finds best price across all books for a given play

### New MCP tools (6)

- `query_sharp_consensus_windows` — Detect sustained sharp book consensus movement across time windows
- `query_all_slates` — Query 7+ leagues at once with consolidated ranked output
- `find_best_price` — Compare odds across all books for line shopping
- `get_hidden_bets` / `hide_bet` / `unhide_bet` / `clear_hidden_bets` — Fantasy bet hide/unhide CRUD
- `query_fantasy_picks` — Restored tool hitting `slipgen.propprofessor.com/fantasy-picks`
- `query_screen_odds_best_comps` / `query_screen_odds_ranked` — Explicit MCP tools for the screen ranking pipeline

### Sharp plays upgrades

- Steam bonus (+15pts) added to sharp play scoring
- Consensus-only fallback for execution books (Fliff, etc.) that can't validate independent sharp movement
- `requireIndependentSharpMovement` flag for flexible movement verification
- `lineHistoryUsable` surfaced in near-miss previews
- Removed `book: executionBook` override that was clobbering the actual book name in `sharp-plays-service`

### Screen ranking improvements

- `buildDegradedDataWarnings()` — Data quality transparency: warns when line history, consensus, or freshness is missing
- `recentWindowHours` now configurable via args (was hardcoded 6h)
- `getResolvedScreenSelection()` now matches by `selectionId` or exact `line+odds`, not just `defaultKey` (fixes prop selection mismatches)
- Steam move detection integrated into ranking pipeline

### Tennis two-phase fallback

- Phase 1: `/screen` with full book list (fixes Polymarket-only results)
- Phase 2: When `/screen` has insufficient data, falls back to +EV endpoint with odds history enrichment via `enrichTennisEvCandidates()`

### Handler renaming for consistency

All MCP tool handlers prefixed with `query_` for consistency:

- `ev_discover` → `query_positive_ev_candidates` (with mandatory `leagues` validation)
- `ev_validate` → `query_validated_positive_ev_candidates`
- `screen` → `query_screen_odds`
- `screen_raw` → N/A (removed as redundant)
- `sharp_plays` → `query_sharp_plays`
- `consensus_windows` → `query_sharp_consensus_windows`
- `ufc_card` → `query_ufc_card`
- `health` → `health_status`
- New per-league tools: `query_nba_screen`, `query_mlb_screen`, `query_nfl_screen`, `query_nhl_screen`, `query_ufc_screen`, `query_soccer_screen`, `query_ncaab_screen`, `query_ncaaf_screen`, `query_wnba_screen`, `query_sport_screen`
- CLI `ufc-card` command updated to call `query_ufc_card`

### Test coverage (+500 lines)

- Steam move detection and best-price analysis tests
- Prop selection resolution with multi-line alternates (Hartenstein O7.5 vs O8.5)
- Execution field preservation for selection2 rows (Spurs +5.5)
- `recentWindowHours` threading into movement summaries
- Book name canonicalization (ReBet aliases)
- 373 total tests, all passing

## 1.0.6

- Restored a raw `query_fantasy_picks` MCP tool for the live `/fantasy` optimizer / DFS board so fantasy availability no longer has to be inferred from `/screen`
- Reintroduced `queryFantasyPicks()` on the API client, posting directly to `https://slipgen.propprofessor.com/fantasy-picks` with the fantasy page referer
- Added regression coverage for the restored fantasy API helper and MCP tool-list / handler surface
- Added a reusable `sharp-plays-service` package export so PP-MCP business logic can be shared without importing the MCP script entrypoint
- Fixed `superjson` loading in the CommonJS API client by using a cached dynamic import, restoring Node 18 compatibility for TRPC hide-row serialization
- Added CI and local verification coverage across Node 18 and Node 20, including lint and Prettier checks
- Kept the release version ahead of the already-published `v1.0.5` tag so the next GitHub release can be tagged cleanly as `v1.0.6`

## 1.0.5

- Restored `query_positive_ev_candidates` as an MCP sportsbook discovery helper so Hermes can scan broad +EV candidates before validating finalists with `/screen`
- Added `query_validated_positive_ev_candidates` so PP-MCP can run sportsbook discovery plus built-in odds-history and sharp-movement validation in one MCP call
- Left `minValue` optional on the +EV MCP helpers so the frontend Positive EV screen can remain the source of truth when it already enforces `-3`
- Added MCP contract coverage for the restored +EV discovery tools, including `tools/list` parity, unset-`minValue` behavior, and validated ranking output
- Clarified README wording so the MCP surface is documented as screen-first with intentional sportsbook discovery and validation exceptions
- Added ranked response `debug=true|false` gating, defaulting to verbose debug metadata while allowing lean MCP and CLI payloads
- Added row-level `freshnessSource`, `freshnessAgeMs`, `freshnessFallbackUsed`, and `rankingProvenance` metadata for explainability and traceability
- Added `npm run smoke:live` for a lightweight live `/screen` ranked-response verification flow before tagging releases
- Shipped the sharp-history and ranked lookback work into the MCP ranked response path and export tooling
- Made `health_status` freshness ages non-null for populated screen payloads, with timestamp-source reporting and explicit fallback metadata when rows are undated
- Exposed richer ranked movement/debug metadata, including filtered history trails, dropped-point reasons, movement debug summaries, and lookback/result metadata
- Added bounded request timeouts across HTTP and TRPC calls so MCP and CLI requests fail predictably instead of hanging indefinitely
- Changed `query_validated_positive_ev_candidates` to use hybrid validation failure handling: partial validation returns warnings plus validation counts, while fully unvalidated requests fail explicitly
- Aligned `pp-query tennis` market expansion with the MCP tennis flow for spread and total aliases
- Hardened ranked preferred-book matching so regex-special characters in book names cannot crash ranking
- Added executable shebangs to the published `pp-mcp` and `pp-query` bin entrypoints

## 1.0.4

- Added configurable ranked odds-history lookback defaults via `SSB_ODDS_HISTORY_LOOKBACK_HOURS`
- Added per-request ranked lookback overrides through MCP `lookbackHours` and local CLI `--lookback-hours`
- Kept the default ranked odds-history window at 6 hours across MCP, library helpers, and local export/query scripts
- Tightened package metadata to describe the screen-first MCP surface and the broader local CLI split
- Synced package-lock metadata with package.json after the screen-only cleanup follow-up
- Added MCP regression coverage for removed fantasy tool names returning `Unknown tool`
- Fixed `pp-query sport` so it returns ranked screen output like `pp-query screen`
- Fixed `pp-query list` so the documented `list` command is included in the emitted command inventory

## 1.0.3

- Added WNBA sport support across the MCP server, CLI, and ranking presets
- Added a generic `query_sport_screen` MCP tool and `pp-query sport` CLI alias
- Added `pp-query list` and expanded CLI help to document the command inventory
- Tightened README wording and examples for the new sport aliases

## 1.0.2

- Public repo release polish
- Added standalone package metadata and CLI binaries
- Split setup into dedicated auth and config docs
- Added GitHub Actions CI and release automation
- Published v1.0.1 release and opened the repo for public access

## 1.0.1

- Initial standalone packaging of the SSB MCP server and query CLI
- Added README, license, binary entrypoints, and GitHub release workflow
