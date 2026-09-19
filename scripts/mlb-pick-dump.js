'use strict';
// Hand-checkable dump: print actual picks so they can be verified against reality.
const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = process.env.SSB_MLB_DATA || path.join(os.homedir(), '.ssb-for-agents', 'mlb');

const { buildWalkForwardRows, fitCoefficients, modelProbability, devigPrices } = require('../lib/mlb-model');

const rows = buildWalkForwardRows(JSON.parse(fs.readFileSync(`${DATA_DIR}/season-2025.json`, 'utf8'))).filter(
  (r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null
);
const fit = fitCoefficients(rows.slice(0, Math.floor(rows.length * 0.6)));

const picks = [];
for (const r of rows) {
  const p = modelProbability(r, fit);
  if (p == null) continue;
  const eh = p - r.marketHome;
  const side = eh > 0.07 ? 'home' : -eh > 0.07 ? 'away' : null;
  if (!side) continue;
  const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
  picks.push({ r, p, side, dv, won: side === 'home' ? r.homeWon : !r.homeWon });
}

console.log(
  `model picks in 2025: ${picks.length} of ${rows.length} games (${((picks.length / rows.length) * 100).toFixed(1)}%)`
);
console.log('That is a HUGE share -- a good model agrees with the market on most games.');
console.log('');
console.log('First 12 picks, raw, so they can be checked by hand:');
console.log('date        matchup                              pick   closeML  modelP  marketDv  score      won?');
for (const pk of picks.slice(0, 12)) {
  const r = pk.r;
  const ml = pk.side === 'home' ? r.homeCloseMl : r.awayCloseMl;
  const mkt = pk.side === 'home' ? pk.dv.home : pk.dv.away;
  const modelP = pk.side === 'home' ? pk.p : 1 - pk.p;
  console.log(
    `${String(r.startDate).slice(0, 10)}  ${(r.away.name + ' @ ' + r.home.name).padEnd(36).slice(0, 36)} ` +
      `${pk.side.padEnd(5)}  ${String(ml).padStart(6)}  ${(modelP * 100).toFixed(1)}%   ${(mkt * 100).toFixed(1)}%     ` +
      `${r.awayScore}-${r.homeScore}   ${pk.won ? 'W' : 'L'}`
  );
}

// Does the model agree with the market most of the time? It should.
console.log('');
const diffs = rows.map((r) => Math.abs(modelProbability(r, fit) - r.marketHome));
const meanAbs = diffs.reduce((s, d) => s + d, 0) / diffs.length;
const big = diffs.filter((d) => d > 0.07).length;
console.log(
  `mean |model - market| = ${(meanAbs * 100).toFixed(2)} pts; games differing by >7pts: ${big} (${((big / rows.length) * 100).toFixed(1)}%)`
);

// Sanity: what does the model say the HOME team's probability is, on average?
console.log(
  `mean model P(home) ${((rows.reduce((s, r) => s + modelProbability(r, fit), 0) / rows.length) * 100).toFixed(2)}%  vs market ${((rows.reduce((s, r) => s + r.marketHome, 0) / rows.length) * 100).toFixed(2)}%  vs actual ${((rows.filter((r) => r.homeWon).length / rows.length) * 100).toFixed(2)}%`
);
