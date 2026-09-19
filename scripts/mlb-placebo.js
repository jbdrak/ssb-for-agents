'use strict';
/**
 * THE CONTROL THAT SETTLES IT.
 *
 * The model is overconfident and disagrees with the market by >7pts on ~half of all games.
 * So: build a PLACEBO with the SAME disagreement profile but ZERO information -- p is the
 * market's own probability plus random noise, matched to the model's spread. Apply the
 * identical selection rule and measure the same statistic.
 *
 * If the placebo shows the same "edge", the edge is an artifact of selecting on the
 * disagreement, and the model adds nothing. If the placebo shows ~0, the model's ranking
 * carries real information and the edge is genuine.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = process.env.SSB_MLB_DATA || path.join(os.homedir(), '.ssb-for-agents', 'mlb');

const {
  buildWalkForwardRows,
  fitCoefficients,
  modelProbability,
  americanToProb,
  devigPrices
} = require('../lib/mlb-model');

const SEASONS = ['2023', '2024', '2025'];
const rowsBySeason = {};
for (const s of SEASONS) {
  rowsBySeason[s] = buildWalkForwardRows(JSON.parse(fs.readFileSync(`${DATA_DIR}/season-${s}.json`, 'utf8'))).filter(
    (r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null
  );
}

// deterministic PRNG so the result is reproducible
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() {
  let u = 0,
    v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function measure(probFn, label, threshold = 0.07) {
  let n = 0,
    wins = 0,
    dvSum = 0,
    rawSum = 0,
    pnl = 0;
  const returns = [];
  for (const tr of SEASONS) {
    for (const te of SEASONS) {
      if (te === tr) continue;
      for (const r of rowsBySeason[te]) {
        const p = probFn(r, tr);
        if (p == null) continue;
        const eh = p - r.marketHome;
        const side = eh > threshold ? 'home' : -eh > threshold ? 'away' : null;
        if (!side) continue;
        const ml = side === 'home' ? r.homeCloseMl : r.awayCloseMl;
        const raw = americanToProb(ml);
        const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
        if (raw == null || !dv) continue;
        const dvSide = side === 'home' ? dv.home : dv.away;
        const won = side === 'home' ? r.homeWon : !r.homeWon;
        n += 1;
        dvSum += dvSide;
        rawSum += raw;
        if (won) wins += 1;
        const ret = won ? (Number(ml) > 0 ? Number(ml) / 100 : 100 / -Number(ml)) : -1;
        pnl += ret;
        returns.push(ret);
      }
    }
  }
  if (!n) return null;
  const hit = wins / n;
  const dv = dvSum / n;
  const se = Math.sqrt((dv * (1 - dv)) / n);
  const roi = pnl / n;
  const mean = roi;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const roiSe = Math.sqrt(variance / n);
  const raw = rawSum / n;
  const zRaw = (hit - raw) / Math.sqrt((raw * (1 - raw)) / n);
  const zDv = (hit - dv) / se;
  console.log(
    `${label.padEnd(28)} n=${String(n).padStart(5)}  hit ${(hit * 100).toFixed(2)}%  ` +
      `vs RAW ${(hit - raw) * 100 >= 0 ? '+' : ''}${((hit - raw) * 100).toFixed(2)}pts (z=${zRaw.toFixed(2)})  ` +
      `vs DE-VIG ${(hit - dv) * 100 >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts (z=${zDv.toFixed(2)})  ` +
      `ROI ${roi * 100 >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}% +/-${(roiSe * 100).toFixed(2)}%`
  );
  return { n, hit, dv, z: zDv, roi };
}

// Real model, coefficients fit per training season.
const fits = {};
for (const s of SEASONS) fits[s] = fitCoefficients(rowsBySeason[s]);
const realFn = (r, tr) => modelProbability(r, fits[tr]);
measure(realFn, 'REAL model');

// Match the placebo's spread to the model's.
let sq = 0,
  cnt = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const p = modelProbability(r, fits[tr]);
      if (p == null) continue;
      sq += (p - r.marketHome) ** 2;
      cnt += 1;
    }
  }
}
const modelSd = Math.sqrt(sq / cnt);
console.log(`\nmodel disagreement sd = ${(modelSd * 100).toFixed(2)}pts`);
console.log('');

console.log('=== PLACEBO: p = market + noise, same spread, ZERO information ===');
console.log('Three independent noise draws. Each should land near zero edge, and each should');
console.log('LOSE roughly the hold, because that is what a model with no information returns.');
for (const draw of [1, 2, 3]) {
  const noise = new Map();
  const fn = (r) => {
    const key = r.startDate + r.home.name + r.away.name;
    if (!noise.has(key)) noise.set(key, gauss() * modelSd);
    return Math.min(0.99, Math.max(0.01, r.marketHome + noise.get(key)));
  };
  measure(fn, `placebo draw ${draw} (sd ${(modelSd * 100).toFixed(0)}pts)`);
}

console.log('');
console.log('=== also: p = market + a CONSTANT bias (no information, no spread) ===');
for (const b of [0.05, 0.1]) {
  measure((r) => Math.min(0.99, Math.max(0.01, r.marketHome + b)), `constant bias +${(b * 100).toFixed(0)}pts`);
}
