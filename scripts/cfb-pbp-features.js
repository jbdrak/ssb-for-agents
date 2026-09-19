'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { homeLine } = require('../lib/line-model');

const DEFAULT_SEASONS = [2021, 2022, 2023, 2024, 2025];
const DATA_ROOT = path.join(os.homedir(), '.ssb-for-agents', 'data');

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildSummarySql(parquetPaths) {
  if (!Array.isArray(parquetPaths) || parquetPaths.length === 0) throw new Error('parquetPaths must not be empty');
  const files = parquetPaths.map(sqlString).join(', ');
  return `WITH plays AS (
  SELECT * FROM read_parquet([${files}], union_by_name = true)
  WHERE game_id IS NOT NULL AND start_date IS NOT NULL AND pos_team IS NOT NULL
    AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL AND EPA IS NOT NULL
    AND (COALESCE(rush, 0) > 0 OR COALESCE(pass, 0) > 0 OR COALESCE(pass_attempt, 0) > 0 OR COALESCE(sack, 0) > 0)
    AND NOT COALESCE(TRY_CAST(kick_play AS BOOLEAN), false)
    AND (wp_before IS NULL OR wp_before BETWEEN 0.05 AND 0.95)
), drive_summary AS (
  SELECT season, game_id, pos_team, drive_id,
    MAX(CASE WHEN drive_start_yards_to_goal <= 40 THEN 1 ELSE 0 END) AS scoringOpportunity,
    MAX(drive_pts) AS scoringOpportunityPoints,
    MAX(CASE
      WHEN drive_time_minutes_elapsed IS NOT NULL AND drive_time_minutes_elapsed >= 0
       AND drive_time_seconds_elapsed IS NOT NULL AND drive_time_seconds_elapsed >= 0
      THEN drive_time_minutes_elapsed * 60 + drive_time_seconds_elapsed
      ELSE NULL
    END) AS possessionSeconds
  FROM plays
  GROUP BY season, game_id, pos_team, drive_id
), play_summary AS (
  SELECT season, year, game_id, start_date, home_team_id, away_team_id, home_team, away_team, pos_team,
    COUNT(*) AS plays,
    SUM(EPA) AS epaSum,
    SUM(CASE WHEN COALESCE(success, 0) > 0 THEN 1 ELSE 0 END) AS successSum,
    SUM(CASE WHEN yards_gained >= 15 THEN 1 ELSE 0 END) AS explosivePlays,
    SUM(CASE WHEN down IN (1, 2) THEN 1 ELSE 0 END) AS earlyDownPlays,
    SUM(CASE WHEN down IN (1, 2) AND (COALESCE(pass, 0) > 0 OR COALESCE(pass_attempt, 0) > 0) THEN 1 ELSE 0 END) AS earlyDownPasses,
    SUM(CASE WHEN down IN (1, 2) THEN EPA ELSE 0 END) AS earlyDownEpaSum,
    SUM(CASE WHEN (down = 2 AND distance >= 7) OR (down IN (3, 4) AND distance >= 5) THEN 1 ELSE 0 END) AS passingDownPlays,
    SUM(CASE WHEN (down = 2 AND distance >= 7) OR (down IN (3, 4) AND distance >= 5) THEN EPA ELSE 0 END) AS passingDownEpaSum,
    SUM(CASE WHEN COALESCE(pass, 0) > 0 OR COALESCE(pass_attempt, 0) > 0 OR COALESCE(sack, 0) > 0 THEN 1 ELSE 0 END) AS dropbacks,
    SUM(CASE WHEN COALESCE(sack, 0) > 0 THEN 1 ELSE 0 END) AS sacksAllowed,
    SUM(CASE WHEN COALESCE(turnover, 0) > 0 OR COALESCE(turnover_indicator, 0) > 0 THEN 1 ELSE 0 END) AS turnovers,
    SUM(CASE WHEN COALESCE(sack, 0) > 0 OR COALESCE(turnover, 0) > 0
      OR COALESCE(turnover_indicator, 0) > 0 OR COALESCE(stuffed_run, 0) > 0
      OR COALESCE(pass_breakup_stat, 0) > 0 OR COALESCE(fumble_forced_stat, 0) > 0
      THEN 1 ELSE 0 END) AS havocEvents
  FROM plays
  GROUP BY season, year, game_id, start_date, home_team_id, away_team_id, home_team, away_team, pos_team
)
SELECT p.*,
  COALESCE(d.scoringOpportunities, 0) AS scoringOpportunities,
  COALESCE(d.scoringOpportunityPoints, 0) AS scoringOpportunityPoints,
  d.possessionSeconds
FROM play_summary p
LEFT JOIN (
  SELECT season, game_id, pos_team, SUM(scoringOpportunity) AS scoringOpportunities,
    SUM(CASE WHEN scoringOpportunity = 1 THEN scoringOpportunityPoints ELSE 0 END) AS scoringOpportunityPoints,
    SUM(possessionSeconds) AS possessionSeconds
  FROM drive_summary
  GROUP BY season, game_id, pos_team
) d USING (season, game_id, pos_team)
ORDER BY season, start_date, game_id, pos_team`;
}

function value(row, ...keys) {
  for (const key of keys) if (row[key] !== undefined) return row[key];
  return null;
}

function summaryFromRow(row) {
  const summary = {};
  for (const key of [
    'plays',
    'epaSum',
    'successSum',
    'explosivePlays',
    'earlyDownPlays',
    'earlyDownPasses',
    'earlyDownEpaSum',
    'passingDownPlays',
    'passingDownEpaSum',
    'dropbacks',
    'sacksAllowed',
    'turnovers',
    'havocEvents',
    'possessionSeconds',
    'scoringOpportunities',
    'scoringOpportunityPoints'
  ]) {
    summary[key] = finiteOrNull(
      value(
        row,
        key,
        key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
      )
    );
  }
  return summary;
}

function summariesToGames(rows) {
  const groups = new Map();
  const exclusions = { oneSided: 0, identityMismatch: 0, malformed: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawId = value(row, 'gameId', 'game_id');
    const season = value(row, 'season');
    const startDate = value(row, 'startDate', 'start_date');
    const homeId = value(row, 'homeTeamId', 'home_team_id');
    const awayId = value(row, 'awayTeamId', 'away_team_id');
    const homeName = value(row, 'homeTeam', 'home_team');
    const awayName = value(row, 'awayTeam', 'away_team');
    const posTeam = value(row, 'posTeam', 'pos_team');
    if (
      rawId == null ||
      String(rawId).trim() === '' ||
      !Number.isInteger(season) ||
      startDate == null ||
      Number.isNaN(Date.parse(startDate)) ||
      homeId == null ||
      String(homeId).trim() === '' ||
      awayId == null ||
      String(awayId).trim() === '' ||
      homeName == null ||
      String(homeName).trim() === '' ||
      awayName == null ||
      String(awayName).trim() === '' ||
      posTeam == null ||
      String(posTeam).trim() === ''
    ) {
      exclusions.malformed += 1;
      continue;
    }
    const id = String(rawId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const games = [];
  for (const [gameId, group] of groups) {
    const first = group[0];
    const sameField = (keys) => {
      const expected = value(first, ...keys);
      return group.every((row) => value(row, ...keys) === expected);
    };
    if (!sameField(['season']) || !sameField(['startDate', 'start_date'])) {
      exclusions.malformed += 1;
      continue;
    }
    if (
      !sameField(['homeTeamId', 'home_team_id']) ||
      !sameField(['awayTeamId', 'away_team_id']) ||
      !sameField(['homeTeam', 'home_team']) ||
      !sameField(['awayTeam', 'away_team'])
    ) {
      exclusions.identityMismatch += 1;
      continue;
    }
    const homeName = value(first, 'homeTeam', 'home_team');
    const awayName = value(first, 'awayTeam', 'away_team');
    const identities = new Set(group.map((row) => value(row, 'posTeam', 'pos_team')));
    const home = group.filter((row) => value(row, 'posTeam', 'pos_team') === homeName);
    const away = group.filter((row) => value(row, 'posTeam', 'pos_team') === awayName);
    if (identities.size > 2) {
      exclusions.identityMismatch += 1;
      continue;
    }
    if (home.length !== 1 || away.length !== 1) {
      if (home.length + away.length === 1) exclusions.oneSided += 1;
      else exclusions.identityMismatch += 1;
      continue;
    }
    const homeRow = home[0];
    const awayRow = away[0];
    const game = {
      gameId,
      season: value(first, 'season'),
      startDate: value(first, 'startDate', 'start_date'),
      homeTeamId: String(value(first, 'homeTeamId', 'home_team_id')),
      awayTeamId: String(value(first, 'awayTeamId', 'away_team_id')),
      home: summaryFromRow(homeRow),
      away: summaryFromRow(awayRow)
    };
    if (
      String(value(homeRow, 'posTeam', 'pos_team')) !== String(homeName) ||
      String(value(awayRow, 'posTeam', 'pos_team')) !== String(awayName)
    ) {
      exclusions.identityMismatch += 1;
      continue;
    }
    games.push(game);
  }
  return { games, exclusions };
}

function asEspnMap(input) {
  const map = new Map();
  const events = input instanceof Map ? input.values() : Array.isArray(input) ? input : Object.values(input || {});
  for (const event of events) {
    if (event && event.eventId != null) map.set(String(event.eventId), event);
  }
  return map;
}

function finiteOrNull(valueToCheck) {
  if (valueToCheck == null || (typeof valueToCheck === 'string' && valueToCheck.trim() === '')) return null;
  const number = Number(valueToCheck);
  return Number.isFinite(number) ? number : null;
}

function hasModeledMetric(row) {
  return Object.entries(row?.features || {}).some(
    ([key, metric]) => !key.endsWith('GamesObserved') && Number.isFinite(metric)
  );
}

function countFeatureReadyRows(featureRows, seasonRows) {
  const seasonGameIds = new Set((Array.isArray(seasonRows) ? seasonRows : []).map((row) => String(row.gameId)));
  return (Array.isArray(featureRows) ? featureRows : []).filter(
    (row) => seasonGameIds.has(String(row.gameId)) && hasModeledMetric(row)
  ).length;
}

function attachEspnMarket(featureRows, espnGamesById) {
  const events = asEspnMap(espnGamesById);
  return (Array.isArray(featureRows) ? featureRows : []).map((row) => {
    const event = events.get(String(row.gameId));
    if (!event) return { ...row };
    const odds = event.odds || {};
    const homeScore = finiteOrNull(event.home && event.home.score);
    const awayScore = finiteOrNull(event.away && event.away.score);
    const openSpread = finiteOrNull(odds.spreadOpen);
    const closeSpread = finiteOrNull(odds.spreadClose) ?? finiteOrNull(odds.spread);
    return {
      ...row,
      eventId: String(event.eventId),
      season: event.season ?? row.season ?? null,
      neutralSite: event.neutralSite === true,
      home: event.home ? { name: event.home.name ?? null, score: homeScore } : null,
      away: event.away ? { name: event.away.name ?? null, score: awayScore } : null,
      margin: homeScore != null && awayScore != null ? homeScore - awayScore : null,
      openingHomeLine: openSpread == null ? null : homeLine(openSpread),
      closingHomeLine: closeSpread == null ? null : homeLine(closeSpread),
      homeSpreadOdds: finiteOrNull(odds.homeSpreadOdds),
      awaySpreadOdds: finiteOrNull(odds.awaySpreadOdds),
      source: odds.provider ?? event.source ?? 'ESPN'
    };
  });
}

function parseArgs(argv) {
  const options = {
    seasons: DEFAULT_SEASONS,
    out: path.join(DATA_ROOT, 'cfb-pbp-features.json')
  };
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
    } else if (argv[i] === '--out') {
      const out = argv[++i];
      if (out == null || out.trim() === '' || out.trim().startsWith('--')) throw new Error('--out requires a value');
      options.out = out;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function loadSummaries(seasons) {
  const paths = seasons.map((season) => path.join(DATA_ROOT, 'cfbfastR', `play_by_play_${season}.parquet`));
  const rows = JSON.parse(
    execFileSync('duckdb', ['-json', '-c', buildSummarySql(paths)], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024
    })
  );
  return { rows, paths };
}

function main(argv = process.argv) {
  const { buildWalkForwardCfbFeatures } = require('../lib/cfb-pbp-features');
  const options = parseArgs(argv);
  const { rows: summaries, paths: parquetPaths } = loadSummaries(options.seasons);
  const converted = summariesToGames(summaries);
  const pregame = buildWalkForwardCfbFeatures(converted.games);
  const events = {};
  for (const season of options.seasons) {
    const sourcePath = path.join(DATA_ROOT, `college-football-${season}.json`);
    if (fs.existsSync(sourcePath))
      for (const event of JSON.parse(fs.readFileSync(sourcePath, 'utf8')))
        events[String(event.eventId)] = { ...event, season };
  }
  const rows = attachEspnMarket(pregame, events);
  const metadata = {
    seasons: options.seasons,
    generatedAt: new Date().toISOString(),
    rowCounts: {
      summaries: summaries.length,
      games: converted.games.length,
      featureRows: pregame.length,
      joined: rows.filter((row) => row.eventId).length
    },
    exclusions: converted.exclusions,
    sourcePaths: {
      parquet: parquetPaths,
      espn: options.seasons.map((season) => path.join(DATA_ROOT, `college-football-${season}.json`))
    }
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify({ metadata, rows }, null, 2)}\n`);
  for (const season of options.seasons) {
    const seasonRows = rows.filter((row) => row.season === season);
    console.log(
      `${season}: joined=${seasonRows.length} opening=${seasonRows.filter((row) => row.openingHomeLine != null).length} closing=${seasonRows.filter((row) => row.closingHomeLine != null).length} feature-ready=${countFeatureReadyRows(pregame, seasonRows)}`
    );
  }
  return { metadata, rows };
}

module.exports = {
  buildSummarySql,
  summariesToGames,
  attachEspnMarket,
  finiteOrNull,
  countFeatureReadyRows,
  parseArgs,
  homeLine,
  main
};
if (require.main === module) main();
