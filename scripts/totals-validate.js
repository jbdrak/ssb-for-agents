'use strict';
/**
 * Totals (over/under) validation battery.
 *
 * Same logic as the spread battery: the line IS a total prediction, so the decisive check
 * comes BEFORE any betting simulation -- compare mean absolute error on the actual total.
 * If the model is worse than the line at predicting totals, it cannot beat the line by
 * thresholding, wherever the threshold is set.
 *
 * Usage:
 *   node scripts/totals-validate.js --league college-football --seasons 2021,2022,2023,2024,2025
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildWalkForwardMarginRows,
  fitTotalCoefficients,
  modelTotal,
  totalError,
  simulateTotalBets
} = require('../lib/line-model');
const { payout } = require('../lib/team-model');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LEAGUE = arg('league', 'college-football');
const SEASONS = arg('seasons', '2025')
  .split(',')
  .map((s) => s.trim());
const MIN_GAMES = Number(arg('min-games', '3'));
const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');
const THRESHOLDS = [1, 2, 3, 4, 5];

console.log(`=== ${LEAGUE} totals model validation ===`);
console.log(`seasons ${SEASONS.join(', ')} | min games ${MIN_GAMES}`);

const rowsBySeason = {};
for (const s of SEASONS) {
  const f = path.join(DATA_DIR, `${LEAGUE}-${s}.json`);
  if (!fs.existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(1);
  }
  const rows = buildWalkForwardMarginRows(JSON.parse(fs.readFileSync(f, 'utf8')), { minGames: MIN_GAMES });
  rowsBySeason[s] = rows.filter(
    (r) =>
      r.overUnder != null &&
      Number.isFinite(r.overOdds) &&
      Number.isFinite(r.underOdds) &&
      r.homePfRate != null &&
      r.awayPfRate != null
  );
  console.log(`  ${s}: ${rowsBySeason[s].length} usable games (of ${rows.length} priced)`);
}
const allRows = SEASONS.flatMap((s) => rowsBySeason[s]);

// ---------- 1. data sanity ----------
console.log('');
console.log('=== 1. DATA SANITY ===');
const totals = allRows.map((r) => r.homeScore + r.awayScore);
const meanTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
const meanLine = allRows.reduce((s, r) => s + r.overUnder, 0) / allRows.length;
console.log(`  mean actual total ${meanTotal.toFixed(2)} | mean closing line ${meanLine.toFixed(2)} (should be close)`);
let ovN = 0,
  ovW = 0,
  ovPnl = 0;
for (const r of allRows) {
  const t = r.homeScore + r.awayScore;
  if (t === r.overUnder) continue;
  ovN += 1;
  if (t > r.overUnder) {
    ovW += 1;
    ovPnl += payout(Number.isFinite(r.overOdds) ? r.overOdds : -110);
  } else ovPnl -= 1;
}
console.log(
  `  backing the OVER every game: ${ovN} bets, ${ovW}W (${((ovW / ovN) * 100).toFixed(1)}%), ROI ${((ovPnl / ovN) * 100).toFixed(2)}%`
);
console.log('  ^ must be NEGATIVE and near the hold. Positive means the total data or scores are wrong.');

// ---------- 2. total accuracy vs the line ----------
console.log('');
console.log('=== 2. TOTAL ACCURACY: the model vs the LINE ITSELF ===');
console.log('The line IS a total prediction. Worse MAE than the line => no edge is possible.');
console.log('train->test   nTest   MAE model   MAE line   bias model   verdict');
const fits = {};
for (const s of SEASONS) fits[s] = fitTotalCoefficients(rowsBySeason[s]);
let better = 0;
let pairs = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    const test = rowsBySeason[te];
    const m = totalError(test, (r) => modelTotal(r, fits[tr]));
    const l = totalError(test, (r) => r.overUnder);
    if (!m || !l) continue;
    pairs += 1;
    if (m.mae < l.mae) better += 1;
    console.log(
      `${tr}->${te}     ${String(m.n).padStart(5)}   ${m.mae.toFixed(3)}       ${l.mae.toFixed(3)}      ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(2).padStart(5)}        ` +
        `${m.mae < l.mae ? 'model BETTER' : 'model WORSE'} (${(m.mae - l.mae >= 0 ? '+' : '') + (m.mae - l.mae).toFixed(3)})`
    );
  }
}
console.log(`  model beats the LINE on total MAE in ${better} of ${pairs} season pairs`);
console.log(`  fitted: ${SEASONS.map((s) => `${s} k=${fits[s].k.toFixed(3)} c=${fits[s].c.toFixed(1)}`).join(' | ')}`);

// ---------- 3. pooled betting ----------
console.log('');
console.log('=== 3. POOLED out-of-sample over/under betting (all season pairs, real prices) ===');
console.log('  thresh   bets    O-U-P          hit      ROI      +/-1se');
const pooled = {};
for (const t of THRESHOLDS) pooled[t] = { n: 0, wins: 0, losses: 0, pushes: 0, pnl: 0 };
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const t of THRESHOLDS) {
      const s = simulateTotalBets(rowsBySeason[te], (r) => modelTotal(r, fits[tr]), { threshold: t });
      if (!s.n) continue;
      const p = pooled[t];
      p.n += s.n;
      p.wins += s.wins;
      p.losses += s.losses;
      p.pushes += s.pushes;
      p.pnl += s.pnl;
    }
  }
}
for (const t of THRESHOLDS) {
  const p = pooled[t];
  if (!p.n) continue;
  const decided = p.wins + p.losses;
  const hit = decided ? p.wins / decided : 0;
  const roi = p.pnl / p.n;
  const roiSe = Math.sqrt((1 + Math.abs(roi)) / p.n);
  console.log(
    `  ${t.toFixed(1)}     ${String(p.n).padStart(5)}   ${String(p.wins).padStart(4)}-${String(p.losses).padEnd(4)}-${String(p.pushes).padEnd(4)}  ` +
      `${(hit * 100).toFixed(1)}%   ${roi >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}%   ${(roiSe * 100).toFixed(2)}%`
  );
}

// ---------- 4. bootstrap ----------
const REF = 3;
console.log('');
console.log(`=== 4. BOOTSTRAP on the edge>${REF} picks (2,000 resamples) ===`);
const base = [];
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const t = modelTotal(r, fits[tr]);
      if (t == null) continue;
      const e = t - r.overUnder;
      const side = e > REF ? 'over' : -e > REF ? 'under' : null;
      if (!side) continue;
      const total = r.homeScore + r.awayScore;
      if (total === r.overUnder) continue;
      const price = Number(side === 'over' ? r.overOdds : r.underOdds);
      const won = side === 'over' ? total > r.overUnder : total < r.overUnder;
      base.push(won ? payout(Number.isFinite(price) ? price : -110) : -1);
    }
  }
}
if (base.length) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rois = [];
  for (let b = 0; b < 2000; b++) {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += base[Math.floor(rnd() * base.length)];
    rois.push(sum / base.length);
  }
  rois.sort((a, b) => a - b);
  console.log(
    `  picks ${base.length} | ROI 2.5th ${(rois[50] * 100).toFixed(2)}%  50th ${(rois[1000] * 100).toFixed(2)}%  97.5th ${(rois[1950] * 100).toFixed(2)}%`
  );
  console.log(`  samples with ROI > 0: ${((rois.filter((x) => x > 0).length / rois.length) * 100).toFixed(1)}%`);
} else {
  console.log('  no picks');
}

// ---------- 5. placebo ----------
console.log('');
console.log('=== 5. PLACEBO: same disagreement spread, ZERO information ===');
let sq = 0;
let cnt = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const t = modelTotal(r, fits[tr]);
      if (t == null) continue;
      sq += (t - r.overUnder) ** 2;
      cnt += 1;
    }
  }
}
const sd = Math.sqrt(sq / cnt);
console.log(`  model disagreement sd = ${sd.toFixed(2)} points`);
let seed2 = 4242;
const gauss = () => {
  let u = 0,
    v = 0;
  while (u === 0) u = (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (v === 0) v = (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
for (const draw of [1, 2, 3]) {
  const noise = new Map();
  let n = 0,
    wins = 0,
    losses = 0,
    pnl = 0;
  for (const tr of SEASONS) {
    for (const te of SEASONS) {
      if (te === tr) continue;
      for (const r of rowsBySeason[te]) {
        const key = `${te}|${r.startDate}|${r.home.name}|${r.away.name}`;
        if (!noise.has(key)) noise.set(key, gauss() * sd);
        const t = r.overUnder + noise.get(key);
        const e = t - r.overUnder;
        const side = e > REF ? 'over' : -e > REF ? 'under' : null;
        if (!side) continue;
        const total = r.homeScore + r.awayScore;
        if (total === r.overUnder) continue;
        const price = Number(side === 'over' ? r.overOdds : r.underOdds);
        const won = side === 'over' ? total > r.overUnder : total < r.overUnder;
        n += 1;
        if (won) {
          wins += 1;
          pnl += payout(Number.isFinite(price) ? price : -110);
        } else {
          losses += 1;
          pnl -= 1;
        }
      }
    }
  }
  if (!n) continue;
  console.log(
    `  placebo draw ${draw}   n=${String(n).padStart(5)}  hit ${((wins / (wins + losses)) * 100).toFixed(2)}%  ` +
      `ROI ${(pnl / n) * 100 >= 0 ? '+' : ''}${((pnl / n) * 100).toFixed(2)}%`
  );
}

console.log('');
console.log('A totals edge needs: model MAE BETTER than the line, ROI above -hold, a bootstrap that');
console.log('is not ~0% profitable, and a placebo that does not match the model.');
