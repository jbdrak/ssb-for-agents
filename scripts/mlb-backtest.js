'use strict';
/**
 * MLB model backtest: can team strength + starting pitcher beat the closing line?
 *
 * Usage:
 *   node scripts/mlb-backtest.js --data /tmp/mlb-2025.json
 *   node scripts/mlb-backtest.js --data /tmp/mlb-2024.json --holdout /tmp/mlb-2025.json
 *
 * `--holdout` is the honest test that matters: coefficients are fit ONLY on the training
 * season and then applied, untouched, to a different season. An in-season split shares a
 * market regime and a roster pool with itself; a different season does not.
 */

const fs = require('fs');
const {
  buildWalkForwardRows,
  fitCoefficients,
  modelProbability,
  brierScore,
  logLoss,
  simulateBets,
  calibration
} = require('../lib/mlb-model');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataPath = arg('data');
if (!dataPath) {
  console.error('need --data <season.json>');
  process.exit(1);
}
const holdoutPath = arg('holdout');
const TRAIN_FRACTION = Number(arg('train-fraction', '0.6'));

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const games = load(dataPath);
const rows = buildWalkForwardRows(games);
const usable = rows.filter((r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null);

console.log(`data: ${dataPath}`);
console.log(`  games ${rows.length} | usable (both teams >=10 prior games, priced) ${usable.length}`);
if (!usable.length) process.exit(1);

const splitIdx = Math.floor(usable.length * TRAIN_FRACTION);
const train = usable.slice(0, splitIdx);
const test = usable.slice(splitIdx);
const day = (r) => String(r.startDate).slice(0, 10);
console.log(`  train ${train.length} (${day(train[0])} .. ${day(train[train.length - 1])})`);
console.log(`  test  ${test.length} (${day(test[0])} .. ${day(test[test.length - 1])})`);

const fit = fitCoefficients(train);
console.log('');
console.log(
  `fitted on train: kEra=${fit.kEra.toFixed(4)} hfa=${fit.hfa.toFixed(3)} (train Brier ${fit.brier.toFixed(5)})`
);

const prob = (r) => modelProbability(r, fit);

function report(label, set) {
  if (!set.length) return;
  const bm = brierScore(set, prob);
  const bk = brierScore(set, (r) => r.marketHome);
  const lm = logLoss(set, prob);
  const lk = logLoss(set, (r) => r.marketHome);
  const meanP = set.reduce((s, r) => s + prob(r), 0) / set.length;
  const meanM = set.reduce((s, r) => s + r.marketHome, 0) / set.length;
  const actual = set.filter((r) => r.homeWon).length / set.length;
  console.log('');
  console.log(`=== ${label} (n=${set.length}) ===`);
  console.log(`  mean P(home): model ${meanP.toFixed(4)} | market ${meanM.toFixed(4)} | actual ${actual.toFixed(4)}`);
  console.log(
    `  Brier   model ${bm.toFixed(5)} | market ${bk.toFixed(5)} | ${bm < bk ? 'model better' : 'model worse'} by ${Math.abs(bm - bk).toFixed(5)}`
  );
  console.log(
    `  LogLoss model ${lm.toFixed(5)} | market ${lk.toFixed(5)} | ${lm < lk ? 'model better' : 'model worse'} by ${Math.abs(lm - lk).toFixed(5)}`
  );
  console.log('');
  console.log('  calibration:');
  for (const c of calibration(set, prob)) {
    console.log(
      `    ${c.lo.toFixed(1)}-${c.hi.toFixed(1)}  n=${String(c.n).padStart(4)}  model ${c.meanP.toFixed(3)}  actual ${c.actual.toFixed(3)}  market ${c.marketP.toFixed(3)}`
    );
  }
  console.log('');
  console.log('  betting sim at CLOSING prices (settled as if every qualifying game were bet):');
  console.log('    thresh    bets    hit     price-implied   edge      z      ROI      +/-1se     CLV');
  for (const t of [0.02, 0.03, 0.04, 0.05, 0.07]) {
    const s = simulateBets(set, prob, { threshold: t });
    if (!s.n) continue;
    console.log(
      `    ${t.toFixed(2)}   ${String(s.n).padStart(5)}   ${(s.hitRate * 100).toFixed(1)}%     ${(s.impliedRate * 100).toFixed(1)}%       ` +
        `${s.edgePoints >= 0 ? '+' : ''}${s.edgePoints.toFixed(2)}pts  ${s.z >= 0 ? '+' : ''}${s.z.toFixed(2)}  ` +
        `${s.roi >= 0 ? '+' : ''}${(s.roi * 100).toFixed(2)}%   ${(s.roiStderr * 100).toFixed(2)}%   ${s.clv != null ? (s.clv * 100).toFixed(2) + '%' : 'n/a'}`
    );
  }
}

report('IN-SEASON TEST (held-out tail of the same season)', test);

if (holdoutPath) {
  const ho = buildWalkForwardRows(load(holdoutPath)).filter(
    (r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null
  );
  report(`CROSS-SEASON HOLDOUT (${holdoutPath}, coefficients never saw this)`, ho);
  console.log('');
  console.log('  ^ This is the number that decides it. An in-season split shares a market regime');
  console.log('    with itself; a different season does not.');
}
