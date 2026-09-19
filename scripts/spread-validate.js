'use strict';
/**
 * Spread validation battery.
 *
 * The moneyline battery asks "does the model beat the closing price?". The spread version
 * asks the sharper question first: **is the model better at predicting the margin than the
 * LINE itself is?** The line is already a margin prediction, so if the model's mean absolute
 * error is worse than the line's, it cannot have an edge no matter how it is thresholded.
 * That check comes before any betting simulation.
 *
 * Usage:
 *   node scripts/spread-validate.js --league college-football --seasons 2021,2022,2023,2024,2025
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildWalkForwardMarginRows,
  fitMarginCoefficients,
  modelMargin,
  marginError,
  simulateSpreadBets,
  assertSpreadConvention
} = require('../lib/spread-model');
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

console.log(`=== ${LEAGUE} spread model validation ===`);
console.log(`seasons ${SEASONS.join(', ')} | min games ${MIN_GAMES}`);

const rowsBySeason = {};
for (const s of SEASONS) {
  const f = path.join(DATA_DIR, `${LEAGUE}-${s}.json`);
  if (!fs.existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(1);
  }
  const rows = buildWalkForwardMarginRows(JSON.parse(fs.readFileSync(f, 'utf8')), { minGames: MIN_GAMES });
  rowsBySeason[s] = rows.filter((r) => r.line != null && r.homeMarginRate != null && r.awayMarginRate != null);
  console.log(`  ${s}: ${rowsBySeason[s].length} usable games (of ${rows.length} priced)`);
}
const allRows = SEASONS.flatMap((s) => rowsBySeason[s]);

// ---------- 0. convention ----------
// If ESPN's spread sign were inverted, every result below would be silently reversed.
console.log('');
console.log('=== 0. SPREAD SIGN CONVENTION (must be verified, not assumed) ===');
const conv = assertSpreadConvention(allRows);
console.log(
  `  n=${conv.n}  home covers ${((conv.homeCovers ?? 0) * 100).toFixed(1)}%  corr(line, actual margin) ${(conv.corr ?? 0).toFixed(3)}`
);
console.log(
  `  ${conv.ok ? 'PASS: home-perspective, as assumed' : 'FAIL: convention is wrong, results below are meaningless'}`
);
if (!conv.ok) process.exit(1);

// ---------- 1. data sanity ----------
console.log('');
console.log('=== 1. DATA SANITY ===');
const margins = allRows.map((r) => r.margin);
const meanMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
const homeWinRate = allRows.filter((r) => r.margin > 0).length / allRows.length;
console.log(`  mean actual margin ${meanMargin.toFixed(2)} (home field), home wins ${(homeWinRate * 100).toFixed(1)}%`);
// Backing the favourite against the spread must lose about the hold.
let favN = 0,
  favW = 0,
  favPnl = 0;
for (const r of allRows) {
  const favHome = r.line < 0; // negative line = home favoured
  const price = favHome ? r.homeSpreadOdds : r.awaySpreadOdds;
  const result = favHome
    ? r.margin > r.line
      ? 'win'
      : r.margin < r.line
        ? 'loss'
        : 'push'
    : r.margin < r.line
      ? 'win'
      : r.margin > r.line
        ? 'loss'
        : 'push';
  if (result === 'push') continue;
  favN += 1;
  if (result === 'win') {
    favW += 1;
    favPnl += payout(Number.isFinite(price) ? price : -110);
  } else favPnl -= 1;
}
console.log(
  `  backing the FAVOURITE against the spread: ${favN} bets, ${favW}W (${((favW / favN) * 100).toFixed(1)}%), ROI ${((favPnl / favN) * 100).toFixed(2)}%`
);
console.log('  ^ must be NEGATIVE. A positive number here means the line or the scores are wrong.');

// ---------- 2. is the model a better margin predictor than the line? ----------
console.log('');
console.log('=== 2. MARGIN ACCURACY: the model vs the LINE ITSELF ===');
console.log('The line IS a margin prediction. Worse MAE than the line => no edge is possible.');
console.log('train->test   nTest   MAE model   MAE line   bias model   verdict');
const fits = {};
for (const s of SEASONS) fits[s] = fitMarginCoefficients(rowsBySeason[s]);
let better = 0;
let pairs = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    const test = rowsBySeason[te];
    const m = marginError(test, (r) => modelMargin(r, fits[tr]));
    const l = marginError(test, (r) => r.line);
    if (!m || !l) continue;
    pairs += 1;
    if (m.mae < l.mae) better += 1;
    console.log(
      `${tr}->${te}     ${String(m.n).padStart(5)}   ${m.mae.toFixed(3)}       ${l.mae.toFixed(3)}      ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(2).padStart(5)}        ` +
        `${m.mae < l.mae ? 'model BETTER' : 'model WORSE'} (${(m.mae - l.mae >= 0 ? '+' : '') + (m.mae - l.mae).toFixed(3)})`
    );
  }
}
console.log(`  model beats the LINE on margin MAE in ${better} of ${pairs} season pairs`);
console.log(
  `  fitted: ${SEASONS.map((s) => `${s} k=${fits[s].k.toFixed(3)} hfa=${fits[s].hfa.toFixed(2)}`).join(' | ')}`
);

// ---------- 3. pooled betting ----------
console.log('');
console.log('=== 3. POOLED out-of-sample spread betting (all season pairs, real prices) ===');
console.log('  thresh   bets    W-L-P        hit      ROI      +/-1se    CLV(pts)');
const pooled = {};
for (const t of THRESHOLDS)
  pooled[t] = { n: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, returns: [], clvN: 0, clvSum: 0 };
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const t of THRESHOLDS) {
      const s = simulateSpreadBets(rowsBySeason[te], (r) => modelMargin(r, fits[tr]), { threshold: t });
      if (!s.n) continue;
      const p = pooled[t];
      p.n += s.n;
      p.wins += s.wins;
      p.losses += s.losses;
      p.pushes += s.pushes;
      p.pnl += s.pnl;
      if (s.clv != null) {
        p.clvSum += s.clv * s.n;
        p.clvN += s.n;
      }
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
      `${(hit * 100).toFixed(1)}%   ${roi >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}%   ${(roiSe * 100).toFixed(2)}%   ${p.clvN ? (p.clvSum / p.clvN).toFixed(2) : 'n/a'}`
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
      const m = modelMargin(r, fits[tr]);
      if (m == null) continue;
      const eh = m - r.line;
      const side = eh > REF ? 'home' : -eh > REF ? 'away' : null;
      if (!side) continue;
      const price = Number(side === 'home' ? r.homeSpreadOdds : r.awaySpreadOdds);
      const diff = side === 'home' ? r.margin - r.line : r.line - r.margin;
      if (diff === 0) continue;
      base.push(diff > 0 ? payout(Number.isFinite(price) ? price : -110) : -1);
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
      const m = modelMargin(r, fits[tr]);
      if (m == null) continue;
      sq += (m - r.line) ** 2;
      cnt += 1;
    }
  }
}
const sd = Math.sqrt(sq / cnt);
console.log(`  model disagreement sd = ${sd.toFixed(2)} points`);
let seed2 = 999;
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
        const m = r.line + noise.get(key);
        const eh = m - r.line;
        const side = eh > REF ? 'home' : -eh > REF ? 'away' : null;
        if (!side) continue;
        const price = Number(side === 'home' ? r.homeSpreadOdds : r.awaySpreadOdds);
        const diff = side === 'home' ? r.margin - r.line : r.line - r.margin;
        if (diff === 0) continue;
        n += 1;
        if (diff > 0) {
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
console.log('A spread edge needs: model MAE BETTER than the line, ROI above -hold, a bootstrap that');
console.log('is not ~0% profitable, and a placebo that does not match the model.');
