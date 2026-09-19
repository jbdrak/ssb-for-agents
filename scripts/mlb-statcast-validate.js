'use strict';
/**
 * MLB Statcast residual validator (Task 6).
 *
 * Primary executable target: outcome residual vs the earliest timestamped
 * two-way market snapshot (ESPN homeOpen/awayOpen). Predictions use ONLY the
 * open line plus walk-forward Statcast features; profit is scored at the
 * open's exact prices. The de-vigged CLOSE is a later diagnostic only.
 *
 * Probability space, not log-odds: the plan names log-odds, but the true
 * win probability is unobserved so a log-odds target cannot be built without
 * inventing data. Probability-space residual (outcome minus de-vigged open)
 * matches the repo's validated team-validate.js methodology exactly.
 *
 * Verdict is PASS only if every applicable gate in
 * docs/plans/2026-09-19-market-residual-models.md holds. A negative verdict
 * is valid; tuning until green is not.
 *
 * Usage:
 *   node scripts/mlb-statcast-validate.js [--seasons 2023,2024,2025] [--bootstrap 2000]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertUniqueGameIds,
  fitResidualModel,
  predictMarketResidual,
  compareMae
} = require('../lib/market-residual-model');
const { selectRidgeChronologically, clusterBootstrapMae, cfbClusterKey } = require('../lib/cfb-residual-validation');

const DATA_ROOT = path.join(os.homedir(), '.ssb-for-agents', 'data');
const STATCAST_ROOT = path.join(DATA_ROOT, 'statcast');
const THRESHOLDS = [0.02, 0.03, 0.04, 0.05, 0.07];
// Savant abbreviations that differ from ESPN's.
const ABBR_ALIASES = { AZ: 'ARI', CWS: 'CHW' };
const alias = (abbr) => ABBR_ALIASES[abbr] || abbr;

function parseArgs(argv) {
  const options = { seasons: [2023, 2024, 2025], bootstrap: 2000 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--seasons') {
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

function americanToProb(moneyline) {
  if (!Number.isFinite(moneyline) || moneyline === 0) return null;
  return moneyline > 0 ? 100 / (moneyline + 100) : -moneyline / (-moneyline + 100);
}

function devigPair(homeMl, awayMl) {
  const home = americanToProb(homeMl);
  const away = americanToProb(awayMl);
  if (home == null || away == null || home + away <= 0) return null;
  return { home: home / (home + away), away: away / (home + away) };
}

function payout(moneyline) {
  if (!Number.isFinite(moneyline) || moneyline === 0) return null;
  return moneyline > 0 ? moneyline / 100 : 100 / -moneyline;
}

function espnDateToIso(raw) {
  const text = String(raw);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function loadFeatures() {
  const file = path.join(STATCAST_ROOT, 'features.jsonl');
  const byKey = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const key = `${row.game_date}|${alias(row.team)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return byKey;
}

function loadEvents(seasons) {
  const events = [];
  for (const season of seasons) {
    const file = path.join(DATA_ROOT, `mlb-${season}.json`);
    for (const event of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      events.push({ ...event, season });
    }
  }
  return events;
}

function diff(home, away) {
  return Number.isFinite(home) && Number.isFinite(away) ? home - away : null;
}

function buildRows(seasons) {
  const features = loadFeatures();
  const events = loadEvents(seasons);
  const rows = [];
  const exclusions = {};
  const exclude = (reason) => {
    exclusions[reason] = (exclusions[reason] || 0) + 1;
  };
  const byDateTeams = new Map();
  for (const event of events) {
    const date = espnDateToIso(event.date);
    const key = `${date}|${event.home.abbr}|${event.away.abbr}`;
    if (!byDateTeams.has(key)) byDateTeams.set(key, []);
    byDateTeams.get(key).push(event);
  }
  const seenGameIds = new Set();
  for (const [key, matches] of byDateTeams) {
    if (matches.length !== 1) {
      exclude('ambiguous_date_matchup');
      continue;
    }
    const event = matches[0];
    if (event.home.abbr === 'AL' || event.home.abbr === 'NL') {
      exclude('all_star');
      continue;
    }
    const homeRows = features.get(`${key.split('|')[0]}|${event.home.abbr}`) || [];
    const awayRows = features.get(`${key.split('|')[0]}|${event.away.abbr}`) || [];
    const home = homeRows.find((row) => row.opponent === alias(event.away.abbr) || row.opponent === event.away.abbr);
    const away = awayRows.find((row) => row.opponent === alias(event.home.abbr) || row.opponent === event.home.abbr);
    const open = devigPair(Number(event.odds?.homeOpen), Number(event.odds?.awayOpen));
    const close = devigPair(Number(event.odds?.homeClose), Number(event.odds?.awayClose));
    if (!home || !away) {
      exclude('missing_statcast_rows');
      continue;
    }
    if (!open) {
      exclude('missing_open');
      continue;
    }
    const homeScore = Number(event.home?.score);
    const awayScore = Number(event.away?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      exclude('missing_score');
      continue;
    }
    const gameId = `mlb-${event.season}-${key}`;
    if (seenGameIds.has(gameId)) {
      exclude('duplicate_game');
      continue;
    }
    seenGameIds.add(gameId);
    const featureVector = [
      diff(home.teamBatXwoba20, away.teamBatXwoba20),
      diff(home.teamBatKRate20, away.teamBatKRate20),
      diff(home.teamBatBBRate20, away.teamBatBBRate20),
      diff(home.teamPitXwobaAllowed20, away.teamPitXwobaAllowed20),
      diff(home.starterKRate8, away.starterKRate8),
      diff(home.starterBBRate8, away.starterBBRate8),
      diff(home.starterXwobaAllowed8, away.starterXwobaAllowed8),
      diff(home.starterWhiffRate8, away.starterWhiffRate8),
      diff(home.bullpenPitches1d, away.bullpenPitches1d),
      diff(home.bullpenPitches3d, away.bullpenPitches3d),
      diff(home.bullpenPitches7d, away.bullpenPitches7d),
      Number.isFinite(home.teamBatGames) && Number.isFinite(away.teamBatGames)
        ? Math.min(home.teamBatGames, away.teamBatGames)
        : null
    ];
    rows.push({
      gameId,
      season: event.season,
      startDate: `${key.split('|')[0]}T12:00:00Z`,
      baseline: open.home,
      outcome: homeScore > awayScore ? 1 : 0,
      features: featureVector,
      park: event.home.abbr,
      openHomeMl: Number(event.odds.homeOpen),
      openAwayMl: Number(event.odds.awayOpen),
      closeHomeMl: Number(event.odds?.homeClose),
      closeAwayMl: Number(event.odds?.awayClose),
      closeHomeProb: close ? close.home : null,
      clusterKey: cfbClusterKey(event.season, `${key.split('|')[0]}T12:00:00Z`)
    });
  }
  return { rows, exclusions };
}

function withParkOneHot(rows, parks) {
  return rows.map((row) => ({
    ...row,
    features: [...row.features, ...parks.map((park) => (row.park === park ? 1 : 0))]
  }));
}

function expandingPredictions(rows) {
  assertUniqueGameIds(rows);
  const seasons = [...new Set(rows.map((row) => row.season))].sort((a, b) => a - b);
  const predictions = [];
  for (let index = 1; index < seasons.length; index += 1) {
    const season = seasons[index];
    const trainingSeasons = seasons.filter((candidate) => candidate < season);
    const training = rows.filter((row) => trainingSeasons.includes(row.season));
    const test = rows.filter((row) => row.season === season);
    const parks = [...new Set(training.map((row) => row.park))].sort();
    const selection = selectRidgeChronologically(withParkOneHot(training, parks));
    const model = fitResidualModel(withParkOneHot(training, parks), { ridge: selection.ridge, groupField: 'season' });
    for (const row of test) {
      const corrected = predictMarketResidual(model, withParkOneHot([row], parks)[0]);
      predictions.push({
        ...row,
        actual: row.outcome,
        baselinePrediction: row.baseline,
        correctedPrediction: corrected,
        ridge: selection.ridge
      });
    }
  }
  return predictions;
}

function simulate(predictions, probabilityOf, threshold) {
  let n = 0;
  let wins = 0;
  let pnl = 0;
  for (const row of predictions) {
    const prob = probabilityOf(row);
    const edge = prob - row.openHomeProb;
    const side = edge > threshold ? 'home' : -edge > threshold ? 'away' : null;
    if (!side) continue;
    const price = side === 'home' ? row.openHomeMl : row.openAwayMl;
    const pay = payout(price);
    if (pay == null) continue;
    n += 1;
    const won = side === 'home' ? row.actual === 1 : row.actual === 0;
    if (won) {
      wins += 1;
      pnl += pay;
    } else pnl -= 1;
  }
  return { n, wins, pnl, roi: n ? pnl / n : null, hit: n ? wins / n : null };
}

function main(argv = process.argv) {
  const options = parseArgs(argv);
  const { rows, exclusions } = buildRows(options.seasons);
  console.log(`eligible=${rows.length} exclusions=${JSON.stringify(exclusions)}`);
  for (const season of options.seasons) {
    console.log(`  ${season}: eligible=${rows.filter((row) => row.season === season).length}`);
  }
  if (rows.length === 0) throw new Error('no eligible rows');

  const predictions = expandingPredictions(rows);
  for (const row of predictions) row.openHomeProb = row.baseline;
  console.log(`predictions=${predictions.length} (each game once: ${new Set(predictions.map((p) => p.gameId)).size})`);

  const mae = compareMae(predictions);
  console.log('');
  console.log('=== Brier/MAE vs open (executable baseline) ===');
  console.log(
    `pooled: baseline=${mae.baselineMae.toFixed(4)} corrected=${mae.correctedMae.toFixed(4)} improvement=${mae.improvement.toFixed(4)}`
  );
  const perSeason = {};
  for (const season of [...new Set(predictions.map((p) => p.season))].sort()) {
    perSeason[season] = compareMae(predictions.filter((p) => p.season === season));
    const s = perSeason[season];
    console.log(
      `  ${season}: n=${predictions.filter((p) => p.season === season).length} baseline=${s.baselineMae.toFixed(4)} corrected=${s.correctedMae.toFixed(4)} improvement=${s.improvement.toFixed(4)}`
    );
  }

  console.log('');
  console.log('=== betting at OPEN prices (every threshold reported) ===');
  const modelProb = (row) => Math.min(0.99, Math.max(0.01, row.correctedPrediction));
  for (const threshold of THRESHOLDS) {
    const sim = simulate(predictions, modelProb, threshold);
    console.log(
      `  edge>${threshold}: n=${sim.n} hit=${sim.hit == null ? 'n/a' : (sim.hit * 100).toFixed(1) + '%'} ROI=${sim.roi == null ? 'n/a' : (sim.roi * 100).toFixed(2) + '%'}`
    );
  }

  console.log('');
  console.log('=== CLV (open to close, model direction) ===');
  const moved = predictions.filter((row) => Number.isFinite(row.closeHomeProb) && row.closeHomeProb !== row.baseline);
  const directed = moved.filter((row) => modelProb(row) !== row.baseline);
  const same = directed.filter(
    (row) => Math.sign(modelProb(row) - row.baseline) === Math.sign(row.closeHomeProb - row.baseline)
  ).length;
  console.log(
    `moved=${moved.length} directed=${directed.length} same-direction=${same} rate=${directed.length ? (same / directed.length).toFixed(3) : 'n/a'}`
  );

  console.log('');
  console.log(`=== cluster bootstrap (${options.bootstrap} iterations) ===`);
  const boot = clusterBootstrapMae(predictions, { iterations: options.bootstrap });
  console.log(
    `median=${boot.median.toFixed(4)} 95% CI=[${boot.p2_5.toFixed(4)}, ${boot.p97_5.toFixed(4)}] improved=${(boot.improvedFraction * 100).toFixed(1)}%`
  );

  console.log('');
  console.log('=== placebo (same disagreement spread, zero information) ===');
  const sq = predictions.reduce((sum, row) => sum + (row.correctedPrediction - row.baseline) ** 2, 0);
  const sd = Math.sqrt(sq / predictions.length);
  let seed = 7;
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    while (v === 0) v = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (const draw of [1, 2, 3]) {
    let base = 0;
    let fake = 0;
    for (const row of predictions) {
      base += Math.abs(row.outcome - row.baseline);
      fake += Math.abs(row.outcome - (row.baseline + gauss() * sd));
    }
    console.log(
      `  draw ${draw}: sd=${sd.toFixed(4)} improvement=${(base / predictions.length - fake / predictions.length).toFixed(4)}`
    );
  }

  const seasonsImproved = Object.values(perSeason).filter((s) => s.improvement > 0).length;
  const seasonCount = Object.keys(perSeason).length;
  console.log('');
  console.log(
    `verdict inputs: seasons-improved=${seasonsImproved}/${seasonCount} bootstrap-CI-above-zero=${boot.p2_5 > 0}`
  );
  if (mae.improvement > 0 && boot.p2_5 > 0 && seasonsImproved === seasonCount) {
    console.log('VERDICT: PASS (historical gate) — proceed to shadow picks and CLV before any betting use');
  } else {
    console.log('VERDICT: NO-GO (research-only) — do not promote; tuning until green is not allowed');
  }
  return { rows, predictions, mae, boot };
}

module.exports = { parseArgs, americanToProb, devigPair, payout, buildRows, expandingPredictions, simulate, main };
if (require.main === module) main();
