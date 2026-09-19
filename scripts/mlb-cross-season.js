'use strict';
/**
 * Cross-season matrix: fit on one full season, evaluate on every OTHER season.
 *
 * One holdout can be lucky. Fitting on 2023 and testing on 2025 is a single draw. Running
 * every ordered pair, and pooling the out-of-sample bets, is the honest way to ask whether
 * the model has an edge or just noise that happens to look like one.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = process.env.SSB_MLB_DATA || path.join(os.homedir(), '.ssb-for-agents', 'mlb');

const {
  buildWalkForwardRows,
  fitCoefficients,
  modelProbability,
  brierScore,
  logLoss,
  simulateBets
} = require('../lib/mlb-model');

const SEASONS = ['2023', '2024', '2025'];
const rowsBySeason = {};
for (const s of SEASONS) {
  const rows = buildWalkForwardRows(JSON.parse(fs.readFileSync(`${DATA_DIR}/season-${s}.json`, 'utf8')));
  rowsBySeason[s] = rows.filter((r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null);
  console.log(`${s}: ${rowsBySeason[s].length} usable games`);
}

console.log('');
console.log('=== DATA SANITY (does the price data behave like a real market?) ===');
// These two checks are what make the verdict trustworthy: if the prices or the win/loss
// flags were wrong, the "no edge" result would be meaningless. A real market is roughly
// calibrated, and blindly backing favourites must lose about the vig.
const allRows = SEASONS.flatMap((s) => rowsBySeason[s]);
const calib = [];
for (let lo = 0.2; lo < 0.8; lo += 0.1) {
  const b = allRows.filter((r) => r.marketHome >= lo && r.marketHome < lo + 0.1);
  if (b.length < 20) continue;
  const implied = b.reduce((s, r) => s + r.marketHome, 0) / b.length;
  const actual = b.filter((r) => r.homeWon).length / b.length;
  calib.push({ lo, n: b.length, implied, actual });
}
console.log('  market calibration (all seasons pooled):');
for (const c of calib) {
  console.log(
    `    ${c.lo.toFixed(1)}-${(c.lo + 0.1).toFixed(1)}  n=${String(c.n).padStart(5)}  implied ${c.implied.toFixed(3)}  actual ${c.actual.toFixed(3)}`
  );
}
let favN = 0,
  favW = 0,
  favPnl = 0;
for (const r of allRows) {
  const homeFav = r.marketHome > 0.5;
  const ml = Number(homeFav ? r.homeCloseMl : r.awayCloseMl);
  if (!Number.isFinite(ml) || ml === 0) continue;
  const won = homeFav ? r.homeWon : !r.homeWon;
  favN += 1;
  if (won) {
    favW += 1;
    favPnl += ml > 0 ? ml / 100 : 100 / -ml;
  } else favPnl -= 1;
}
console.log(
  `  backing the favourite in every game: ${favN} bets, ${favW}W (${((favW / favN) * 100).toFixed(1)}%), ROI ${((favPnl / favN) * 100).toFixed(2)}%`
);
console.log('  ^ A no-information strategy must lose roughly the hold. If this were positive, the');
console.log('    price data or the win/loss flags would be wrong, and so would every number below.');

const pooled = { threshold: {} };
const THRESHOLDS = [0.02, 0.03, 0.04, 0.05, 0.07];

console.log('');
console.log('=== FIT ON ONE SEASON, EVALUATE ON THE OTHERS (fully out-of-sample) ===');
console.log('train->test   nTest   Brier model   Brier mkt   LogLoss model  LogLoss mkt   verdict');

for (const trainSeason of SEASONS) {
  const fit = fitCoefficients(rowsBySeason[trainSeason]);
  for (const testSeason of SEASONS) {
    if (testSeason === trainSeason) continue;
    const test = rowsBySeason[testSeason];
    const prob = (r) => modelProbability(r, fit);
    const bm = brierScore(test, prob);
    const bk = brierScore(test, (r) => r.marketHome);
    const lm = logLoss(test, prob);
    const lk = logLoss(test, (r) => r.marketHome);
    console.log(
      `${trainSeason}->${testSeason}     ${String(test.length).padStart(5)}   ${bm.toFixed(5)}       ${bk.toFixed(5)}     ${lm.toFixed(5)}       ${lk.toFixed(5)}     ` +
        `${bm < bk ? 'model BETTER' : 'model WORSE'} (Brier ${(bm - bk >= 0 ? '+' : '') + (bm - bk).toFixed(5)})`
    );
    for (const t of THRESHOLDS) {
      const s = simulateBets(test, prob, { threshold: t });
      if (!s.n) continue;
      const p = (pooled.threshold[t] = pooled.threshold[t] || {
        n: 0,
        wins: 0,
        rawSum: 0,
        devigSum: 0,
        pnl: 0,
        returns: [],
        clvN: 0,
        clvSum: 0,
        seasons: 0
      });
      p.n += s.n;
      p.wins += s.wins;
      p.rawSum += s.impliedRate * s.n;
      p.devigSum += s.devigRate * s.n;
      p.pnl += s.pnl;
      p.seasons += 1;
      if (s.clv != null) {
        p.clvSum += s.clv * s.n;
        p.clvN += s.n;
      }
    }
  }
}

console.log('');
console.log('=== POOLED out-of-sample betting (all 6 season pairs combined) ===');
console.log('Everything here was bet on seasons the coefficients never saw, at closing prices,');
console.log('with real vig. TWO benchmarks are shown, because they answer different questions:');
console.log('  vs RAW price  = what you actually get paid against. No information => ~-hold.');
console.log("  vs DE-VIGGED  = the market's own view of the true probability. This is the real");
console.log('                  edge test: beating the raw price but not the de-vigged number just');
console.log('                  means you are collecting the vig back, not forecasting better.');
console.log('');
console.log('  thresh    bets    hit      vs RAW   z      vs DE-VIG  z      ROI      +/-1se    CLV');
for (const t of THRESHOLDS) {
  const p = pooled.threshold[t];
  if (!p || !p.n) continue;
  const hit = p.wins / p.n;
  const raw = p.rawSum / p.n;
  const dv = p.devigSum / p.n;
  const zRaw = (hit - raw) / Math.sqrt((raw * (1 - raw)) / p.n);
  const zDv = (hit - dv) / Math.sqrt((dv * (1 - dv)) / p.n);
  const roi = p.pnl / p.n;
  const roiSe = Math.sqrt((1 + Math.abs(roi)) / p.n);
  console.log(
    `  ${t.toFixed(2)}   ${String(p.n).padStart(5)}   ${(hit * 100).toFixed(1)}%   ` +
      `${(hit - raw) * 100 >= 0 ? '+' : ''}${((hit - raw) * 100).toFixed(2)}pts  ${zRaw.toFixed(2).padStart(6)}   ` +
      `${(hit - dv) * 100 >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts  ${zDv.toFixed(2).padStart(6)}   ` +
      `${roi >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}%    ${(roiSe * 100).toFixed(2)}%    ${p.clvN ? ((p.clvSum / p.clvN) * 100).toFixed(2) + '%' : 'n/a'}`
  );
}
console.log('');
console.log('Reading this: a real edge needs the DE-VIGGED column positive with |z| >= 2, and the');
console.log('ROI should agree with it. An ROI near -hold with no de-vigged edge means the strategy');
console.log('is paying the vig and forecasting nothing -- which is what this model does.');
