'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildCfbResidualRows,
  expandingSeasonPredictions,
  summarizeCfbPredictions,
  clusterBootstrapMae
} = require('../lib/cfb-residual-validation');

const DATA_ROOT = path.join(os.homedir(), '.ssb-for-agents', 'data');
const DEFAULT_IN = path.join(DATA_ROOT, 'cfb-pbp-features.json');
const DEFAULT_SEASONS = [2023, 2024, 2025];

function parseArgs(argv) {
  const options = { in: DEFAULT_IN, seasons: DEFAULT_SEASONS, bootstrap: 2000 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--in') {
      const raw = argv[++i];
      if (raw == null || raw.trim() === '' || raw.trim().startsWith('--')) throw new Error('--in requires a value');
      options.in = raw;
    } else if (argv[i] === '--seasons') {
      const raw = argv[++i];
      if (raw == null || raw.trim() === '' || raw.trim().startsWith('--'))
        throw new Error('--seasons requires a value');
      const tokens = raw.split(',').map((token) => token.trim());
      const seasons = tokens.map(Number);
      if (
        tokens.some((token) => token === '') ||
        seasons.some((season) => !Number.isFinite(season) || !Number.isInteger(season)) ||
        new Set(seasons).size !== seasons.length
      )
        throw new Error('--seasons must contain unique finite integers');
      options.seasons = seasons;
    } else if (argv[i] === '--bootstrap') {
      const raw = Number(argv[++i]);
      if (!Number.isInteger(raw) || raw <= 0) throw new Error('--bootstrap must be a positive integer');
      options.bootstrap = raw;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function seededGauss(seed) {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  const uniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296 || 0.5;
  };
  return () => {
    const u = uniform();
    const v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function placeboImprovements(predictions, draws = 3) {
  const sq = predictions.reduce((sum, row) => sum + (row.correctedPrediction - row.baselinePrediction) ** 2, 0);
  const sd = Math.sqrt(sq / predictions.length);
  const results = [];
  for (let draw = 1; draw <= draws; draw += 1) {
    const gauss = seededGauss(draw);
    let base = 0;
    let fake = 0;
    for (const row of predictions) {
      base += Math.abs(row.actual - row.baselinePrediction);
      fake += Math.abs(row.actual - (row.baselinePrediction + gauss() * sd));
    }
    results.push({ draw, sd, improvement: base / predictions.length - fake / predictions.length });
  }
  return results;
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function main(argv = process.argv) {
  const options = parseArgs(argv);
  const payload = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  const extracted = (payload.rows || []).filter((row) => options.seasons.includes(row.season));
  const { rows, exclusions } = buildCfbResidualRows(extracted);

  console.log(`input rows=${extracted.length} eligible=${rows.length} exclusions=${JSON.stringify(exclusions)}`);
  for (const season of options.seasons) {
    const eligible = rows.filter((row) => row.season === season).length;
    console.log(`  ${season}: eligible=${eligible}`);
  }

  const predictions = expandingSeasonPredictions(rows);
  console.log(
    `predictions=${predictions.length} (each game appears once: ${new Set(predictions.map((p) => p.gameId)).size})`
  );

  const summary = summarizeCfbPredictions(predictions);
  console.log('');
  console.log('=== MAE vs opening line (executable baseline) ===');
  console.log(
    `pooled: baseline=${fmt(summary.baselineMae)} corrected=${fmt(summary.correctedMae)} improvement=${fmt(summary.improvement)}`
  );
  for (const [season, seasonSummary] of Object.entries(summary.perSeason)) {
    console.log(
      `  ${season}: n=${predictions.filter((p) => p.season === Number(season)).length} ` +
        `baseline=${fmt(seasonSummary.baselineMae)} corrected=${fmt(seasonSummary.correctedMae)} ` +
        `improvement=${fmt(seasonSummary.improvement)}`
    );
  }

  console.log('');
  console.log('=== closing line (later diagnostic only, not executable) ===');
  console.log(`closing MAE=${fmt(summary.closingMae)}`);
  const movement = summary.movement;
  console.log(
    `moved=${movement.movedCount} corrected=${movement.correctionCount} ` +
      `same-direction=${movement.sameDirectionCount} rate=${fmt(movement.sameDirectionRate)}`
  );

  console.log('');
  console.log(`=== cluster bootstrap (${options.bootstrap} iterations, game+week clusters) ===`);
  const boot = clusterBootstrapMae(predictions, { iterations: options.bootstrap });
  console.log(
    `median=${fmt(boot.median)} 95% CI=[${fmt(boot.p2_5)}, ${fmt(boot.p97_5)}] ` +
      `improved=${(boot.improvedFraction * 100).toFixed(1)}%`
  );

  console.log('');
  console.log('=== placebo (same disagreement spread, zero information) ===');
  for (const placebo of placeboImprovements(predictions)) {
    console.log(`  draw ${placebo.draw}: sd=${fmt(placebo.sd)} improvement=${fmt(placebo.improvement)}`);
  }

  const seasonsImproved = Object.values(summary.perSeason).filter((s) => s.improvement > 0).length;
  const seasonCount = Object.keys(summary.perSeason).length;
  const ciPasses = boot.p2_5 > 0;
  console.log('');
  console.log(`verdict inputs: seasons-improved=${seasonsImproved}/${seasonCount} bootstrap-CI-above-zero=${ciPasses}`);
  if (summary.improvement > 0 && ciPasses && seasonsImproved === seasonCount) {
    console.log('VERDICT: PASS (historical gate) — proceed to shadow picks and CLV before any betting use');
  } else {
    console.log('VERDICT: NO-GO (research-only) — do not promote; tuning until green is not allowed');
  }
  return { rows, predictions, summary, boot };
}

module.exports = { parseArgs, placeboImprovements, main };
if (require.main === module) main();
