'use strict';
/**
 * Cross-league market efficiency — is any market soft enough to matter?
 *
 * The research claim being tested: low-volume markets are structurally softer (fewer analysts,
 * slower adjustment). UFC is the thinnest market ESPN prices, so if the claim holds anywhere,
 * it should hold there.
 *
 * WHY RETURNS AND NOT BRIER. Raw Brier/log-loss is NOT comparable across leagues: a league with
 * more lopsided slates scores better on those metrics without being any more efficient. A
 * RETURN is comparable, because it is already normalised by the prices. So the headline metric
 * here is the ROI of naive strategies -- and specifically the favourite-longshot bias, which is
 * the classic measurable inefficiency.
 *
 * Usage: node scripts/market-efficiency.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { americanToProb, devigPrices, payout } = require('../lib/team-model');

const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');

const LEAGUES = [
  { key: 'mlb', label: 'MLB', seasons: ['2023', '2024', '2025'] },
  { key: 'college-football', label: 'NCAAF', seasons: ['2021', '2022', '2023', '2024', '2025'] },
  { key: 'nhl', label: 'NHL', seasons: ['2023', '2024'] },
  { key: 'wnba', label: 'WNBA', seasons: ['2024', '2025'] },
  { key: 'ufc', label: 'UFC', seasons: ['2023', '2024', '2025'] }
];

function loadOne(key, seasons) {
  const rows = [];
  let impossible = 0;
  for (const s of seasons) {
    const f = path.join(DATA_DIR, `${key}-${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const o = g.odds || {};
      if (o.homeClose == null || o.awayClose == null) continue;
      const fair = devigPrices(o.homeClose, o.awayClose);
      if (!fair) continue;
      // Settled by score (team sports) or by `winner` (UFC).
      let homeWon = g.homeWon;
      if (homeWon == null) {
        if (g.home.score == null || g.away.score == null) continue;
        homeWon = g.home.score > g.away.score;
      }
      const rawHome = americanToProb(o.homeClose);
      const rawAway = americanToProb(o.awayClose);
      if (rawHome == null || rawAway == null) continue;
      // SANITY GUARD. Two prices in a real 2-way market must imply more than 1.0 combined --
      // that excess IS the book's margin. A sum below 1.0 means the pair is not a 2-way market
      // (typically a 3-way regulation line with the draw omitted), and de-vigging it invents a
      // negative margin and fake profit. This is what made NHL look like a +9.8% favourite edge.
      if (rawHome + rawAway < 1.0) {
        impossible += 1;
        continue;
      }
      rows.push({
        season: s,
        fairHome: fair.home,
        rawHome,
        rawAway,
        homeMl: Number(o.homeClose),
        awayMl: Number(o.awayClose),
        hold: fair.hold,
        homeWon
      });
    }
  }
  return { rows, impossible };
}

function betRoi(rows, sideFn) {
  let n = 0;
  let wins = 0;
  let pnl = 0;
  for (const r of rows) {
    const side = sideFn(r);
    if (!side) continue;
    const ml = side === 'home' ? r.homeMl : r.awayMl;
    if (!Number.isFinite(ml) || ml === 0) continue;
    const won = side === 'home' ? r.homeWon : !r.homeWon;
    n += 1;
    if (won) {
      wins += 1;
      pnl += payout(ml);
    } else pnl -= 1;
  }
  if (!n) return null;
  return { n, hit: wins / n, roi: pnl / n };
}

/** Calibration slope: regress actual on implied. 1.0 = perfectly calibrated. */
function slope(rows) {
  const n = rows.length;
  const mx = rows.reduce((s, r) => s + r.fairHome, 0) / n;
  const my = rows.reduce((s, r) => s + (r.homeWon ? 1 : 0), 0) / n;
  let cov = 0;
  let vx = 0;
  for (const r of rows) {
    cov += (r.fairHome - mx) * ((r.homeWon ? 1 : 0) - my);
    vx += (r.fairHome - mx) ** 2;
  }
  return vx > 0 ? cov / vx : null;
}

console.log('=== CROSS-LEAGUE MARKET EFFICIENCY ===');
console.log('Is any market soft enough that a NAIVE strategy returns a profit?');
console.log('');

const results = [];
for (const lg of LEAGUES) {
  const { rows, impossible } = loadOne(lg.key, lg.seasons);
  if (!rows.length) {
    console.log(`${lg.label}: no data`);
    continue;
  }
  const hold = rows.reduce((s, r) => s + r.hold, 0) / rows.length;
  const fav = betRoi(rows, (r) => (r.fairHome > 0.5 ? 'home' : 'away'));
  const dog = betRoi(rows, (r) => (r.fairHome > 0.5 ? 'away' : 'home'));
  const home = betRoi(rows, () => 'home');
  const sl = slope(rows);
  results.push({ label: lg.label, rows, hold, fav, dog, home, sl, impossible });

  const flag = impossible > 0 ? `  !! ${impossible} rows REJECTED (impossible 2-way sum)` : '';
  console.log(
    `${lg.label.padEnd(7)} games ${String(rows.length).padStart(5)} | hold ${(hold * 100).toFixed(2)}% | calib slope ${sl.toFixed(3)}${flag}`
  );
  console.log(
    `        favourite ROI ${fav.roi >= 0 ? '+' : ''}${(fav.roi * 100).toFixed(2)}% (n=${fav.n})  ` +
      `underdog ROI ${dog.roi >= 0 ? '+' : ''}${(dog.roi * 100).toFixed(2)}%  home ROI ${home.roi >= 0 ? '+' : ''}${(home.roi * 100).toFixed(2)}%`
  );
}

console.log('');
console.log('=== RANKED BY HOW SOFT THE MARKET IS (blind-favourite ROI, higher = softer) ===');
console.log('A soft market pays the favourite better. Still negative = still paying the vig.');
for (const r of [...results].sort((a, b) => b.fav.roi - a.fav.roi)) {
  console.log(
    `  ${r.label.padEnd(7)} fav ROI ${(r.fav.roi * 100).toFixed(2)}% | hold ${(r.hold * 100).toFixed(2)}% | ` +
      `slope ${r.sl.toFixed(3)} ${Math.abs(r.sl - 1) > 0.08 ? '<-- biased' : ''}`
  );
}

console.log('');
console.log('=== FAVOURITE-LONGSHOT BIAS BY BUCKET (implied vs actual, home side) ===');
for (const r of results) {
  const line = [];
  for (let lo = 0.1; lo < 0.9; lo += 0.1) {
    const b = r.rows.filter((x) => x.fairHome >= lo && x.fairHome < lo + 0.1);
    if (b.length < 25) continue;
    const imp = b.reduce((s, x) => s + x.fairHome, 0) / b.length;
    const act = b.filter((x) => x.homeWon).length / b.length;
    line.push(`${lo.toFixed(1)}:${imp.toFixed(2)}/${act.toFixed(2)}`);
  }
  console.log(`  ${r.label.padEnd(7)} ${line.join('  ')}`);
}
console.log('');
console.log('Reading: in each pair the first number is what the price implied and the second is');
console.log('what happened. If actual > implied at high probabilities, favourites are UNDER-priced');
console.log('(longshot bias) -- and a market with that pattern, large enough to beat the hold, is');
console.log('the only kind of naive edge that exists.');
