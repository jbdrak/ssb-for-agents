'use strict';
/**
 * Stress tests before believing a +4.76pt edge against a closing line.
 * Anything this large is either a real, surprising result or a leak. Test both.
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
const fits = {};
for (const s of SEASONS) fits[s] = fitCoefficients(rowsBySeason[s]);

function collect(probFn, threshold) {
  const picks = [];
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
        const dv = devigPrices(r.homeCloseMl, r.awayCloseMl);
        const raw = americanToProb(ml);
        if (raw == null || !dv) continue;
        const won = side === 'home' ? r.homeWon : !r.homeWon;
        picks.push({
          season: te,
          dv: side === 'home' ? dv.home : dv.away,
          raw,
          ml: Number(ml),
          won,
          ret: won ? (Number(ml) > 0 ? Number(ml) / 100 : 100 / -Number(ml)) : -1
        });
      }
    }
  }
  return picks;
}

function stats(picks, label) {
  const n = picks.length;
  if (!n) return console.log(`${label}: none`);
  const hit = picks.filter((p) => p.won).length / n;
  const dv = picks.reduce((s, p) => s + p.dv, 0) / n;
  const se = Math.sqrt((dv * (1 - dv)) / n);
  const roi = picks.reduce((s, p) => s + p.ret, 0) / n;
  const v = picks.reduce((s, p) => s + (p.ret - roi) ** 2, 0) / (n - 1);
  const roiSe = Math.sqrt(v / n);
  console.log(
    `${label.padEnd(22)} n=${String(n).padStart(5)}  hit ${(hit * 100).toFixed(2)}%  mkt ${(dv * 100).toFixed(2)}%  ` +
      `edge ${hit - dv >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts z=${((hit - dv) / se).toFixed(2)}  ` +
      `ROI ${roi * 100 >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}% +/-${(roiSe * 100).toFixed(2)}%`
  );
  return { n, hit, dv, roi, roiSe, picks };
}

const realFn = (r, tr) => modelProbability(r, fits[tr]);

console.log('=== 1. STABILITY ACROSS SEASONS (each season fully out-of-sample) ===');
for (const s of SEASONS) {
  const picks = collect(realFn, 0.07).filter((p) => p.season === s);
  stats(picks, `holdout ${s}`);
}

console.log('');
console.log('=== 2. MONOTONE IN THRESHOLD? (a real edge should grow with conviction) ===');
console.log('threshold  n      edge       z      ROI');
for (const t of [0.03, 0.05, 0.07, 0.1, 0.15, 0.2]) {
  const picks = collect(realFn, t);
  const n = picks.length;
  if (!n) continue;
  const hit = picks.filter((p) => p.won).length / n;
  const dv = picks.reduce((s, p) => s + p.dv, 0) / n;
  const se = Math.sqrt((dv * (1 - dv)) / n);
  const roi = picks.reduce((s, p) => s + p.ret, 0) / n;
  console.log(
    `  ${t.toFixed(2)}    ${String(n).padStart(5)}  ${(hit - dv) * 100 >= 0 ? '+' : ''}${((hit - dv) * 100).toFixed(2)}pts  ${((hit - dv) / se).toFixed(2)}   ${roi * 100 >= 0 ? '+' : ''}${(roi * 100).toFixed(2)}%`
  );
}

console.log('');
console.log('=== 3. IS THE EDGE JUST THE STARTER-ERA TERM? (ablate each input) ===');
const noStarter = (r, tr) => modelProbability({ ...r, homeStarterRa: null, awayStarterRa: null }, fits[tr]);
const noStrength = (r, tr) => modelProbability({ ...r, homeStrength: 0.5, awayStrength: 0.5 }, fits[tr]);
stats(collect(realFn, 0.07), 'full model');
stats(collect(noStarter, 0.07), 'strength only (no starter)');
stats(collect(noStrength, 0.07), 'starter only (no strength)');

console.log('');
console.log('=== 4. DOES THE EDGE SURVIVE A BOOTSTRAP? (resample picks) ===');
const base = collect(realFn, 0.07);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const rois = [];
for (let b = 0; b < 2000; b++) {
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += base[Math.floor(rnd() * base.length)].ret;
  rois.push(sum / base.length);
}
rois.sort((a, b) => a - b);
console.log(
  `  ROI 2.5th pct ${(rois[50] * 100).toFixed(2)}%   50th ${(rois[1000] * 100).toFixed(2)}%   97.5th ${(rois[1950] * 100).toFixed(2)}%`
);
console.log(
  `  fraction of bootstrap samples with ROI > 0: ${((rois.filter((r) => r > 0).length / 2000) * 100).toFixed(1)}%`
);

console.log('');
console.log('=== 5. LEAK CHECK: is the starter ERA a season-to-date value, or the FINAL season ERA? ===');
console.log('If the same pitcher shows an identical ERA across the whole season, ESPN is serving a');
console.log('retroactively-updated number and the model can see the future.');
const byPitcher = new Map();
for (const s of SEASONS) {
  for (const r of rowsBySeason[s]) {
    for (const side of ['home', 'away']) {
      const id = r[side].starterId;
      const era = side === 'home' ? r.homeStarterEra : r.awayStarterEra;
      if (!id || era == null) continue;
      if (!byPitcher.has(id)) byPitcher.set(id, []);
      byPitcher.get(id).push({ date: String(r.startDate).slice(0, 10), era });
    }
  }
}
let changing = 0,
  constant = 0,
  examples = 0;
for (const [, list] of byPitcher) {
  if (list.length < 5) continue;
  const vals = new Set(list.map((x) => x.era));
  if (vals.size > 1) {
    changing += 1;
    if (examples < 3) {
      list.sort((a, b) => a.date.localeCompare(b.date));
      console.log(
        `  ${list[0].date}..${list[list.length - 1].date}: ${list
          .map((x) => x.era)
          .slice(0, 12)
          .join(', ')}`
      );
      examples += 1;
    }
  } else constant += 1;
}
console.log(
  `  pitchers with >=5 starts: ${changing + constant} | ERA changes across the season: ${changing} | ERA frozen: ${constant}`
);
console.log(`  -> ${changing > constant ? 'ERA is as-of-date: NO LEAK' : 'SUSPICIOUS: ERA looks frozen'}`);
