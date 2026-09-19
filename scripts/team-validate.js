'use strict';
/**
 * The full validation battery for a team-strength model, for any sport.
 *
 * This is the script that decides whether a model has an edge. It is deliberately one file
 * rather than several, because the checks only mean something TOGETHER: a betting result
 * without a data-sanity check, a placebo control, and a cross-season holdout is not evidence.
 *
 * Usage:
 *   node scripts/team-validate.js --league mlb --seasons 2023,2024,2025
 *   node scripts/team-validate.js --league college-football --seasons 2021,2022,2023,2024,2025 \
 *     --exponent 2.37 --min-games 3
 *
 * Data comes from `scripts/sport-collect.js`:
 *   ~/.ssb-for-agents/data/<league>-<year>.json   (override with SSB_DATA_DIR)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildWalkForwardRows,
  fitCoefficients,
  modelProbability,
  brierScore,
  logLoss,
  simulateBets,
  calibration,
  devigPrices,
  payout
} = require('../lib/team-model');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LEAGUE = arg('league', 'mlb');
const SEASONS = arg('seasons', '2025')
  .split(',')
  .map((s) => s.trim());
const EXPONENT = Number(arg('exponent', '1.83'));
const MIN_GAMES = Number(arg('min-games', '10'));
const MIN_STARTS = Number(arg('min-starts', '3'));
const THRESHOLDS = [0.02, 0.03, 0.04, 0.05, 0.07];
const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');

const opts = { minGames: MIN_GAMES, minStarts: MIN_STARTS, exponent: EXPONENT };

console.log(`=== ${LEAGUE} model validation ===`);
console.log(`seasons ${SEASONS.join(', ')} | pythagorean exponent ${EXPONENT} | min games ${MIN_GAMES}`);

// ---------- load ----------
const rowsBySeason = {};
for (const s of SEASONS) {
  const f = path.join(DATA_DIR, `${LEAGUE}-${s}.json`);
  if (!fs.existsSync(f)) {
    console.error(`missing ${f} - run: node scripts/sport-collect.js --sport <sport> --league ${LEAGUE} ...`);
    process.exit(1);
  }
  const rows = buildWalkForwardRows(JSON.parse(fs.readFileSync(f, 'utf8')), opts);
  rowsBySeason[s] = rows.filter((r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null);
  console.log(`  ${s}: ${rowsBySeason[s].length} usable games`);
}
const allRows = SEASONS.flatMap((s) => rowsBySeason[s]);
if (!allRows.length) {
  console.error('no usable rows');
  process.exit(1);
}

// ---------- 1. data sanity ----------
// Without this the rest is meaningless: if the prices or the win/loss flags were wrong, a
// "no edge" verdict would be as untrustworthy as a "big edge" one.
console.log('');
console.log('=== 1. DATA SANITY (does the price data behave like a real market?) ===');
console.log('  market calibration (all seasons pooled):');
for (const c of calibration(allRows, (r) => r.marketHome, { bucket: 0.1 })) {
  console.log(
    `    ${c.lo.toFixed(1)}-${c.hi.toFixed(1)}  n=${String(c.n).padStart(5)}  implied ${c.marketP.toFixed(3)}  actual ${c.actual.toFixed(3)}`
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
    favPnl += payout(ml);
  } else favPnl -= 1;
}
console.log(
  `  backing the favourite in every game: ${favN} bets, ${favW}W (${((favW / favN) * 100).toFixed(1)}%), ROI ${((favPnl / favN) * 100).toFixed(2)}%`
);
console.log('  ^ must be NEGATIVE and near minus the hold. If positive, the data is wrong.');

// ---------- 2. cross-season holdout ----------
console.log('');
console.log('=== 2. FIT ON ONE SEASON, EVALUATE ON THE OTHERS (fully out-of-sample) ===');
console.log('train->test   nTest   Brier model   Brier mkt   LogLoss model  LogLoss mkt   verdict');
const fits = {};
for (const s of SEASONS) fits[s] = fitCoefficients(rowsBySeason[s]);
const probFor = (r, tr) => modelProbability(r, fits[tr]);

let brierBetter = 0;
let pairs = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    const test = rowsBySeason[te];
    const bm = brierScore(test, (r) => probFor(r, tr));
    const bk = brierScore(test, (r) => r.marketHome);
    const lm = logLoss(test, (r) => probFor(r, tr));
    const lk = logLoss(test, (r) => r.marketHome);
    pairs += 1;
    if (bm < bk) brierBetter += 1;
    console.log(
      `${tr}->${te}     ${String(test.length).padStart(5)}   ${bm.toFixed(5)}       ${bk.toFixed(5)}     ${lm.toFixed(5)}       ${lk.toFixed(5)}     ` +
        `${bm < bk ? 'model BETTER' : 'model WORSE'} (${(bm - bk >= 0 ? '+' : '') + (bm - bk).toFixed(5)})`
    );
  }
}
console.log(`  model beats the market on Brier in ${brierBetter} of ${pairs} season pairs`);

// ---------- 3. pooled betting, both benchmarks ----------
console.log('');
console.log('=== 3. POOLED out-of-sample betting (every season pair, closing prices, real vig) ===');
console.log('  vs RAW price  = what you are actually paid against. No information => ~-hold.');
console.log("  vs DE-VIGGED  = the market's own view of the true probability. THE real edge test:");
console.log('                  beating the raw price but not the de-vigged number is just the vig');
console.log('                  coming back, not forecasting better.');
console.log('');
console.log('  thresh    bets    hit      vs RAW   z      vs DE-VIG  z      ROI      +/-1se    CLV');
const pooled = {};
for (const t of THRESHOLDS) pooled[t] = { n: 0, wins: 0, rawSum: 0, dvSum: 0, pnl: 0, returns: [], clvN: 0, clvSum: 0 };
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const t of THRESHOLDS) {
      const s = simulateBets(rowsBySeason[te], (r) => probFor(r, tr), { threshold: t });
      if (!s.n) continue;
      const p = pooled[t];
      p.n += s.n;
      p.wins += s.wins;
      p.rawSum += s.impliedRate * s.n;
      p.dvSum += s.devigRate * s.n;
      p.pnl += s.pnl;
      p.returns.push(...Array.from({ length: s.n }, () => s.roi));
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
  const hit = p.wins / p.n;
  const raw = p.rawSum / p.n;
  const dv = p.dvSum / p.n;
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

// ---------- 4. bootstrap ----------
const REF = 0.07;
const base = [];
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const p = probFor(r, tr);
      if (p == null) continue;
      const eh = p - r.marketHome;
      const side = eh > REF ? 'home' : -eh > REF ? 'away' : null;
      if (!side) continue;
      const ml = Number(side === 'home' ? r.homeCloseMl : r.awayCloseMl);
      if (!Number.isFinite(ml) || ml === 0) continue;
      const won = side === 'home' ? r.homeWon : !r.homeWon;
      base.push(won ? payout(ml) : -1);
    }
  }
}
console.log('');
console.log(`=== 4. BOOTSTRAP on the ${base.length} picks at edge>${REF.toFixed(2)} (2,000 resamples) ===`);
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
  const profitable = (rois.filter((x) => x > 0).length / rois.length) * 100;
  console.log(
    `  ROI 2.5th ${(rois[50] * 100).toFixed(2)}%   50th ${(rois[1000] * 100).toFixed(2)}%   97.5th ${(rois[1950] * 100).toFixed(2)}%`
  );
  console.log(`  samples with ROI > 0: ${profitable.toFixed(1)}%   (a real edge is not near zero)`);
}

// ---------- 5. placebo control ----------
// The control that settles it. A model with the SAME disagreement spread but ZERO
// information. If it shows the same edge, the edge is the selection procedure, not the model.
console.log('');
console.log('=== 5. PLACEBO: same disagreement spread, ZERO information ===');
let sq = 0,
  cnt = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    for (const r of rowsBySeason[te]) {
      const p = probFor(r, tr);
      if (p == null) continue;
      sq += (p - r.marketHome) ** 2;
      cnt += 1;
    }
  }
}
const modelSd = Math.sqrt(sq / cnt);
console.log(`  model disagreement sd = ${(modelSd * 100).toFixed(2)}pts`);
let seed = 12345;
const gauss = () => {
  let u = 0,
    v = 0;
  while (u === 0) u = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (v === 0) v = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
function placebo(draw) {
  const noise = new Map();
  let n = 0,
    wins = 0,
    dvSum = 0,
    pnl = 0;
  // Iterate the SAME season pairs as the real model, so the pick count is comparable. A
  // placebo evaluated on a different sample size cannot be compared to the real result.
  for (const tr of SEASONS) {
    for (const te of SEASONS) {
      if (te === tr) continue;
      for (const r of rowsBySeason[te]) {
        const key = `${te}|${r.startDate}|${r.home.name}|${r.away.name}`;
        if (!noise.has(key)) noise.set(key, gauss() * modelSd);
        const p = Math.min(0.99, Math.max(0.01, r.marketHome + noise.get(key)));
        const eh = p - r.marketHome;
        const side = eh > REF ? 'home' : -eh > REF ? 'away' : null;
        if (!side) continue;
        const ml = Number(side === 'home' ? r.homeCloseMl : r.awayCloseMl);
        const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
        if (!Number.isFinite(ml) || !dv) continue;
        const won = side === 'home' ? r.homeWon : !r.homeWon;
        n += 1;
        dvSum += side === 'home' ? dv.home : dv.away;
        if (won) {
          wins += 1;
          pnl += payout(ml);
        } else pnl -= 1;
      }
    }
  }
  if (!n) return;
  const hit = wins / n;
  const dv = dvSum / n;
  const z = (hit - dv) / Math.sqrt((dv * (1 - dv)) / n);
  console.log(
    `  placebo draw ${draw}   n=${String(n).padStart(5)}  hit ${(hit * 100).toFixed(2)}%  ` +
      `vs DE-VIG ${hit - dv >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts (z=${z.toFixed(2)})  ROI ${(pnl / n) * 100 >= 0 ? '+' : ''}${((pnl / n) * 100).toFixed(2)}%`
  );
}
for (const d of [1, 2, 3]) placebo(d);

// ---------- 6. ablation ----------
console.log('');
console.log('=== 6. ABLATION (which input carries the result?) ===');
// Uses the SAME season-pair pooling as sections 3-5, so the pick counts are comparable.
function measure(label, fn) {
  let n = 0,
    wins = 0,
    dvSum = 0,
    pnl = 0;
  for (const tr of SEASONS) {
    for (const te of SEASONS) {
      if (te === tr) continue;
      const s = simulateBets(rowsBySeason[te], (r) => fn(r, tr), { threshold: REF });
      if (!s.n) continue;
      n += s.n;
      wins += s.wins;
      dvSum += s.devigRate * s.n;
      pnl += s.pnl;
    }
  }
  if (!n) return console.log(`  ${label.padEnd(26)} no bets`);
  const hit = wins / n;
  const dv = dvSum / n;
  const z = (hit - dv) / Math.sqrt((dv * (1 - dv)) / n);
  console.log(
    `  ${label.padEnd(26)} n=${String(n).padStart(5)}  vs DE-VIG ${(hit - dv) * 100 >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts ` +
      `(z=${z.toFixed(2)})  ROI ${(pnl / n) * 100 >= 0 ? '+' : ''}${((pnl / n) * 100).toFixed(2)}%`
  );
}
const fit0 = fitCoefficients(allRows);
measure('full model', (r) => modelProbability(r, fit0));
measure('strength only', (r) => modelProbability({ ...r, homeStarterRa: null, awayStarterRa: null }, fit0));
measure('starter only', (r) => modelProbability({ ...r, homeStrength: 0.5, awayStrength: 0.5 }, fit0));

console.log('');
console.log('Reading the whole thing: an edge needs the DE-VIGGED column positive with |z| >= 2,');
console.log('ROI meaningfully above -hold, a placebo that does NOT match it, and a bootstrap that');
console.log('is not ~0% profitable. Anything less is noise wearing a suit.');
