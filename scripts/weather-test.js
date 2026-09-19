'use strict';
// Does WEATHER add information the closing total line does not already contain?
//
// The bar is not "does weather correlate with scoring" -- it certainly does. The bar is:
// does adding it make the model's total MAE SMALLER THAN THE LINE'S? If the market already
// prices wind and temperature, the answer is no, and the feature is worthless to a bettor.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildWalkForwardMarginRows } = require('../lib/line-model');

const SEASONS = (process.argv[2] || '2021,2022,2023,2024,2025').split(',');
const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');

const rowsBySeason = {};
for (const s of SEASONS) {
  const rows = buildWalkForwardMarginRows(
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, `college-football-${s}.json`), 'utf8')),
    { minGames: 3 }
  ).filter((r) => r.overUnder != null && r.homePfRate != null && r.awayPfRate != null);
  rowsBySeason[s] = rows;
}
const all = SEASONS.flatMap((s) => rowsBySeason[s]);
console.log(`games with a total and usable features: ${all.length}`);

const outdoor = all.filter((r) => r.weather && r.weather.indoor === false && r.weather.windMph != null);
const indoor = all.filter((r) => r.weather && r.weather.indoor === true);
console.log(`outdoor with weather: ${outdoor.length} | indoor (no weather): ${indoor.length}`);
if (!outdoor.length) {
  console.log('no weather joined yet');
  process.exit(0);
}

// 1. Does weather correlate with the ACTUAL total, raw? (it should)
const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
console.log('');
console.log('=== 1. raw correlation with the actual total (outdoor only) ===');
const act = (r) => r.homeScore + r.awayScore;
const windy = outdoor.filter((r) => r.weather.windMph >= 15);
const calm = outdoor.filter((r) => r.weather.windMph < 10);
console.log(`  windy (>=15mph) n=${windy.length}  mean total ${mean(windy, act).toFixed(2)}`);
console.log(`  calm  (<10mph)  n=${calm.length}  mean total ${mean(calm, act).toFixed(2)}`);
console.log(`  difference: ${(mean(windy, act) - mean(calm, act)).toFixed(2)} points`);
const cold = outdoor.filter((r) => r.weather.tempF < 45);
const warm = outdoor.filter((r) => r.weather.tempF >= 65);
console.log(`  cold (<45F) n=${cold.length}  mean total ${mean(cold, act).toFixed(2)}`);
console.log(`  warm (>=65F) n=${warm.length}  mean total ${mean(warm, act).toFixed(2)}`);
console.log(`  difference: ${(mean(cold, act) - mean(warm, act)).toFixed(2)} points`);

// 2. Does the LINE already reflect it? Compare the line's own error on windy vs calm.
console.log('');
console.log('=== 2. does the LINE already price it? (line error by condition) ===');
const lineErr = (a) => mean(a, (r) => Math.abs(r.overUnder - act(r)));
console.log(`  line MAE on windy games: ${lineErr(windy).toFixed(3)}`);
console.log(`  line MAE on calm games : ${lineErr(calm).toFixed(3)}`);
console.log(
  `  line mean on windy ${mean(windy, (r) => r.overUnder).toFixed(2)} vs calm ${mean(calm, (r) => r.overUnder).toFixed(2)}`
);
console.log('  ^ if the line already sits lower on windy games by a similar amount, it is priced.');

// 3. Fit base vs weather-augmented, cross-season, and compare to the line.
const base = (r, c) => c.k * ((r.homePfRate + r.awayPaRate + r.awayPfRate + r.homePaRate) / 2) + c.c;
const withWx = (r, c) => {
  let t = base(r, c);
  const w = r.weather;
  if (w && w.indoor === false && w.windMph != null) {
    t += c.wind * w.windMph + c.temp * ((w.tempF ?? 65) - 65) + c.precip * (w.precipIn ?? 0);
  }
  return t;
};
// Coordinate descent, not an exhaustive grid. The weather grid is 5-dimensional, and a full
// sweep is ~2.8M combinations x ~900 rows x 20 season pairs -- minutes per fit. Scanning one
// coefficient at a time over a few passes converges to the same optimum in ~200 evaluations.
function fit(rows, fn, grid) {
  const keys = Object.keys(grid);
  const cur = {};
  for (const k of keys) {
    const [lo, hi] = grid[k];
    cur[k] = (lo + hi) / 2;
  }
  const mse = (c) => mean(rows, (r) => (fn(r, c) - act(r)) ** 2);
  let best = mse(cur);
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const k of keys) {
      const [lo, hi, step] = grid[k];
      let bestV = cur[k];
      for (let v = lo; v <= hi + 1e-9; v += step) {
        cur[k] = v;
        const m = mse(cur);
        if (m < best - 1e-12) {
          best = m;
          bestV = v;
          improved = true;
        }
      }
      cur[k] = bestV;
    }
    if (!improved) break;
  }
  return { ...cur, mse: best };
}

console.log('');
console.log('=== 3. CROSS-SEASON: does weather beat the LINE? ===');
console.log('train->test   MAE base   MAE +weather   MAE line   verdict');
const gridBase = { k: [0.5, 1.6, 0.05], c: [-10, 15, 1] };
const gridWx = {
  k: [0.5, 1.6, 0.05],
  c: [-10, 15, 1],
  wind: [-1.0, 0.5, 0.05],
  temp: [-0.4, 0.4, 0.05],
  precip: [-8, 8, 2]
};
let wxBeatsLine = 0;
let baseBeatsLine = 0;
let pairs = 0;
for (const tr of SEASONS) {
  for (const te of SEASONS) {
    if (te === tr) continue;
    const train = rowsBySeason[tr];
    const test = rowsBySeason[te];
    if (!train.length || !test.length) continue;
    const fb = fit(train, base, gridBase);
    const fw = fit(train, withWx, gridWx);
    const mb = mean(test, (r) => Math.abs(base(r, fb) - act(r)));
    const mw = mean(test, (r) => Math.abs(withWx(r, fw) - act(r)));
    const ml = mean(test, (r) => Math.abs(r.overUnder - act(r)));
    pairs += 1;
    if (mw < ml) wxBeatsLine += 1;
    if (mb < ml) baseBeatsLine += 1;
    console.log(
      `${tr}->${te}     ${mb.toFixed(3)}      ${mw.toFixed(3)}          ${ml.toFixed(3)}      ` +
        `${mw < ml ? 'weather BEATS line' : 'weather LOSES to line'} | wind ${fw.wind.toFixed(2)} temp ${fw.temp.toFixed(2)} precip ${fw.precip.toFixed(1)}`
    );
  }
}
console.log('');
console.log(`base model beats the line in ${baseBeatsLine}/${pairs} pairs`);
console.log(`weather model beats the line in ${wxBeatsLine}/${pairs} pairs`);
console.log('The only number that matters: if weather does not get the model UNDER the line, the');
console.log('market already prices it and the feature cannot make money.');
