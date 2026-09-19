'use strict';
/**
 * Favourite-longshot bias test.
 *
 * The classic, well-documented inefficiency: longshots are over-priced and favourites
 * under-priced. The cross-league scan flagged UFC as the only market with a calibration
 * slope meaningfully above 1 (1.09) -- i.e. UFC favourites win MORE often than their price
 * implies. This script asks the only question that matters: is that enough to beat the hold?
 *
 * Usage: node scripts/favourite-bias.js [league ...]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { americanToProb, devigPrices, payout } = require('../lib/team-model');

const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');
const LEAGUES = {
  mlb: ['2023', '2024', '2025'],
  'college-football': ['2021', '2022', '2023', '2024', '2025'],
  nhl: ['2023', '2024'],
  wnba: ['2024', '2025'],
  ufc: ['2023', '2024', '2025']
};

function load(key) {
  const out = [];
  for (const s of LEAGUES[key] || []) {
    const f = path.join(DATA_DIR, `${key}-${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const o = g.odds || {};
      if (o.homeClose == null || o.awayClose == null) continue;
      const rawH = americanToProb(o.homeClose);
      const rawA = americanToProb(o.awayClose);
      if (rawH == null || rawA == null) continue;
      if (rawH + rawA < 1.0) continue; // not a 2-way market
      const fair = devigPrices(o.homeClose, o.awayClose);
      if (!fair) continue;
      let homeWon = g.homeWon;
      if (homeWon == null) {
        if (g.home.score == null || g.away.score == null) continue;
        homeWon = g.home.score > g.away.score;
      }
      out.push({ season: s, fairHome: fair.home, homeMl: Number(o.homeClose), awayMl: Number(o.awayClose), homeWon });
    }
  }
  return out;
}

/** Back the favourite when its de-vigged probability is at least `thr`. Settle at the close price. */
function backFav(rows, thr) {
  let n = 0;
  let wins = 0;
  let pnl = 0;
  let expWins = 0;
  for (const r of rows) {
    const favHome = r.fairHome >= 0.5;
    const p = favHome ? r.fairHome : 1 - r.fairHome;
    if (p < thr) continue;
    const ml = favHome ? r.homeMl : r.awayMl;
    if (!Number.isFinite(ml) || ml === 0) continue;
    const won = favHome ? r.homeWon : !r.homeWon;
    const rawP = americanToProb(ml);
    if (rawP == null) continue;
    n += 1;
    expWins += rawP; // what the PRICE says should happen (includes the vig)
    if (won) {
      wins += 1;
      pnl += payout(ml);
    } else pnl -= 1;
  }
  if (!n) return null;
  const hit = wins / n;
  const exp = expWins / n;
  const se = Math.sqrt((exp * (1 - exp)) / n);
  return { n, hit, exp, z: se > 0 ? (hit - exp) / se : 0, roi: pnl / n };
}

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LEAGUES);
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];

console.log('=== FAVOURITE-LONGSHOT BIAS: does backing favourites beat the hold? ===');
console.log('z = how far the observed win rate is from what the PRICE implied (vig included).');
console.log('z > 2 means favourites won more often than the price allowed for.');
console.log('');

for (const k of keys) {
  const rows = load(k);
  if (!rows.length) {
    console.log(`${k}: no data`);
    continue;
  }
  console.log(`${k.toUpperCase()} (${rows.length} games)`);
  console.log('  min prob |    n |   hit | price |      z |     ROI');
  for (const thr of THRESHOLDS) {
    const r = backFav(rows, thr);
    if (!r) continue;
    const mark = r.z > 2 ? ' <-- significant' : '';
    console.log(
      `  ${thr.toFixed(2).padStart(8)} | ${String(r.n).padStart(4)} | ${(r.hit * 100).toFixed(1)}% | ${(r.exp * 100).toFixed(1)}% | ` +
        `${r.z >= 0 ? '+' : ''}${r.z.toFixed(2).padStart(5)} | ${r.roi >= 0 ? '+' : ''}${(r.roi * 100).toFixed(2)}%${mark}`
    );
  }
  // Per-season stability for the headline threshold.
  const per = LEAGUES[k].map((s) => {
    const r = backFav(
      rows.filter((x) => x.season === s),
      0.6
    );
    return r ? `${s}: ${r.roi >= 0 ? '+' : ''}${(r.roi * 100).toFixed(1)}% (n=${r.n})` : `${s}: -`;
  });
  console.log(`  >=0.60 by season: ${per.join('  ')}`);
  console.log('');
}
console.log('NOTE: five thresholds are shown per league on purpose. Reporting only the best one');
console.log('would be p-hacking -- with 5 thresholds x 5 leagues there are 25 chances for noise to');
console.log('look like signal. A result is only interesting if it is large, consistent across');
console.log('seasons, AND survives the multiple-testing correction.');
