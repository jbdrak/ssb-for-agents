'use strict';
// The two results contradict. Resolve it: on the model's OWN picks, is the model right and
// the market wrong (real edge), or is the model just overconfident (luck)?
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
  const rows = buildWalkForwardRows(JSON.parse(fs.readFileSync(`${DATA_DIR}/season-${s}.json`, 'utf8')));
  rowsBySeason[s] = rows.filter((r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null);
}

const picks = [];
for (const tr of SEASONS) {
  const fit = fitCoefficients(rowsBySeason[tr]);
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const p = modelProbability(r, fit);
      if (p == null) continue;
      const eh = p - r.marketHome;
      const side = eh > 0.07 ? 'home' : -eh > 0.07 ? 'away' : null;
      if (!side) continue;
      const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
      picks.push({
        side,
        modelP: side === 'home' ? p : 1 - p,
        marketDv: side === 'home' ? dv.home : dv.away,
        raw: americanToProb(side === 'home' ? r.homeCloseMl : r.awayCloseMl),
        won: side === 'home' ? r.homeWon : !r.homeWon
      });
    }
  }
}

const n = picks.length;
const mean = (f) => picks.reduce((s, p) => s + f(p), 0) / n;
const act = picks.filter((p) => p.won).length / n;

console.log(`model picks at edge>0.07, pooled out-of-sample: n = ${n}`);
console.log('');
console.log("  On the model's OWN picks:");
console.log(`    model's mean probability   ${(mean((p) => p.modelP) * 100).toFixed(3)}%`);
console.log(`    market de-vigged mean      ${(mean((p) => p.marketDv) * 100).toFixed(3)}%`);
console.log(`    ACTUAL hit rate            ${(act * 100).toFixed(3)}%`);
console.log('');
console.log('  If modelP ~ actual and marketDv is lower, the model is RIGHT and the market is');
console.log('  wrong on these games -> real edge. If modelP >> actual, the model is overconfident');
console.log('  and the win rate is luck.');

// Home/away split -- a home bias masquerading as skill would show up here.
const home = picks.filter((p) => p.side === 'home');
const away = picks.filter((p) => p.side === 'away');
console.log('');
console.log(`  side split: home ${home.length} (${((home.length / n) * 100).toFixed(1)}%), away ${away.length}`);
for (const [label, set] of [
  ['home', home],
  ['away', away]
]) {
  if (!set.length) continue;
  const a = set.filter((p) => p.won).length / set.length;
  const m = set.reduce((s, p) => s + p.modelP, 0) / set.length;
  const d = set.reduce((s, p) => s + p.marketDv, 0) / set.length;
  console.log(
    `    ${label}: model ${(m * 100).toFixed(2)}%  market ${(d * 100).toFixed(2)}%  actual ${(a * 100).toFixed(2)}%`
  );
}

// THE decisive control: forget the model. On these SAME games, what did the MARKET predict?
console.log('');
console.log('=== the market on the same games ===');
console.log('The market is well calibrated overall. If it is badly wrong on exactly the games');
console.log('the model picks, that is a real edge. If it is fine, the model got lucky.');
const dvAll = picks.reduce((s, p) => s + p.marketDv, 0) / n;
const se = Math.sqrt((dvAll * (1 - dvAll)) / n);
console.log(
  `  market de-vigged ${(dvAll * 100).toFixed(3)}% vs actual ${(act * 100).toFixed(3)}%  -> ${((act - dvAll) * 100).toFixed(3)}pts (z=${((act - dvAll) / se).toFixed(2)})`
);

// And the reverse: on games the model DIDN'T pick, is the market calibrated?
const nonPicks = [];
for (const tr of SEASONS) {
  const fit = fitCoefficients(rowsBySeason[tr]);
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const p = modelProbability(r, fit);
      if (p == null) continue;
      const eh = p - r.marketHome;
      if (eh > 0.07 || -eh > 0.07) continue;
      const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
      if (!dv) continue;
      nonPicks.push({ dvHome: dv.home, won: r.homeWon });
    }
  }
}
const nn = nonPicks.length;
const dvm = nonPicks.reduce((s, p) => s + p.dvHome, 0) / nn;
const am = nonPicks.filter((p) => p.won).length / nn;
console.log(
  `  on the ${nn} games the model did NOT pick: market de-vigged ${(dvm * 100).toFixed(3)}% vs actual ${(am * 100).toFixed(3)}%  -> ${((am - dvm) * 100).toFixed(3)}pts`
);
console.log('');
console.log('  ^ If the market is calibrated on non-picks and off on picks, that is suspicious.');
console.log('    A well-calibrated market should be calibrated on BOTH subsets.');
