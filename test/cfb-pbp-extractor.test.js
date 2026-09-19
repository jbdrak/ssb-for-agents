'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  buildSummarySql,
  summariesToGames,
  attachEspnMarket,
  countFeatureReadyRows,
  finiteOrNull,
  homeLine,
  parseArgs
} = require('../scripts/cfb-pbp-features');

test('summary SQL contains causal filters, aggregates, and drive-level opportunity grouping', () => {
  const sql = buildSummarySql(['/tmp/a.parquet', '/tmp/b.parquet']);
  assert.match(sql, /union_by_name\s*=\s*true/i);
  assert.match(sql, /game_id\s+IS\s+NOT\s+NULL/i);
  assert.match(sql, /start_date\s+IS\s+NOT\s+NULL/i);
  assert.match(sql, /pos_team\s+IS\s+NOT\s+NULL/i);
  assert.match(sql, /EPA\s+IS\s+NOT\s+NULL/i);
  assert.match(
    sql,
    /\(COALESCE\(rush,\s*0\)\s*>\s*0\s+OR\s+COALESCE\(pass,\s*0\)\s*>\s*0\s+OR\s+COALESCE\(pass_attempt,\s*0\)\s*>\s*0\s+OR\s+COALESCE\(sack,\s*0\)\s*>\s*0\)/i
  );
  assert.doesNotMatch(sql, /COALESCE\(offense_play,\s*''\)\s*<>\s*''/i);
  assert.match(sql, /NOT\s+COALESCE\(TRY_CAST\(kick_play\s+AS\s+BOOLEAN\),\s*false\)/i);
  assert.match(sql, /wp_before\s+IS\s+NULL.*BETWEEN\s+0\.05\s+AND\s+0\.95/is);
  for (const alias of [
    'epaSum',
    'successSum',
    'explosivePlays',
    'earlyDownPasses',
    'passingDownEpaSum',
    'dropbacks',
    'sacksAllowed',
    'turnovers',
    'havocEvents',
    'possessionSeconds'
  ]) {
    assert.match(sql, new RegExp(`AS\\s+${alias}`, 'i'));
  }
  assert.match(sql, /GROUP BY[\s\S]*drive/i);
  assert.match(sql, /scoringOpportunities/i);
  assert.match(
    sql,
    /COALESCE\(sack,\s*0\)\s*>\s*0[\s\S]*COALESCE\(stuffed_run,\s*0\)\s*>\s*0[\s\S]*COALESCE\(pass_breakup_stat,\s*0\)\s*>\s*0[\s\S]*COALESCE\(fumble_forced_stat,\s*0\)\s*>\s*0/i
  );
  assert.match(sql, /drive_time_minutes_elapsed\s*\*\s*60\s*\+\s*drive_time_seconds_elapsed/i);
  assert.match(sql, /SUM\(possessionSeconds\)/i);
  assert.doesNotMatch(sql, /SUM\(.*drive_time_minutes_elapsed/i);
  assert.doesNotMatch(sql, /margin|score|winner|outcome/i);
});

const HAS_DUCKDB = spawnSync('duckdb', ['-version'], { stdio: 'ignore' }).status === 0;

test('summary SQL counts havoc once per play and possession time once per drive', { skip: !HAS_DUCKDB }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-pbp-fixture-'));
  const parquetPath = path.join(dir, 'plays.parquet');
  const fixtureSql = `
    CREATE TABLE fixture AS SELECT * FROM (VALUES
      (2025, 2025, 'g1', '2025-09-01', 1, 2, 'Home', 'Away', 'Home', 1, 50, 0, 2, 30, 0.1, 0, 1, 1, 1, 0, 0.5, 1, -5, 1, 10, 1, 1, 1, 1, 1),
      (2025, 2025, 'g1', '2025-09-01', 1, 2, 'Home', 'Away', 'Home', 1, 50, 0, 2, 30, 0.1, 1, 0, 0, 0, 0, 0.5, 1, 3, 2, 5, 0, 0, 0, 0, 0),
      (2025, 2025, 'g1', '2025-09-01', 1, 2, 'Home', 'Away', 'Home', 2, 50, 0, 0, 0, 0.1, 1, 0, 0, 0, 0, 0.5, 1, 2, 1, 10, 0, 0, 0, 0, 0),
      (2025, 2025, 'g1', '2025-09-01', 1, 2, 'Home', 'Away', 'Home', 3, 50, 0, NULL, NULL, 0.1, 1, 0, 0, 0, 0, 0.5, 1, 1, 1, 10, 0, 0, 0, 0, 0)
    ) AS t(season, year, game_id, start_date, home_team_id, away_team_id, home_team, away_team,
      pos_team, drive_id, drive_start_yards_to_goal, drive_pts, drive_time_minutes_elapsed,
      drive_time_seconds_elapsed, EPA, rush, pass, pass_attempt, sack, kick_play, wp_before,
      success, yards_gained, down, distance, turnover, turnover_indicator, stuffed_run,
      pass_breakup_stat, fumble_forced_stat);
    COPY fixture TO '${parquetPath.replaceAll("'", "''")}' (FORMAT PARQUET);
  `;

  try {
    execFileSync('duckdb', ['-c', fixtureSql], { encoding: 'utf8' });
    const rows = JSON.parse(
      execFileSync('duckdb', ['-json', '-c', buildSummarySql([parquetPath])], { encoding: 'utf8' })
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].plays), 4);
    assert.equal(Number(rows[0].havocEvents), 1);
    assert.equal(Number(rows[0].possessionSeconds), 150);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summariesToGames maps exact home and away identities and rejects incomplete or mismatched games', () => {
  const rows = [
    {
      season: 2024,
      game_id: 'g1',
      start_date: '2024-09-01',
      home_team_id: 'h',
      away_team_id: 'a',
      home_team: 'Home',
      away_team: 'Away',
      pos_team: 'Home',
      dropbacks: '1',
      plays: '2',
      havocEvents: '1',
      possessionSeconds: '120'
    },
    {
      season: 2024,
      game_id: 'g1',
      start_date: '2024-09-01',
      home_team_id: 'h',
      away_team_id: 'a',
      home_team: 'Home',
      away_team: 'Away',
      pos_team: 'Away',
      dropbacks: 2,
      plays: 3
    },
    {
      season: 2024,
      game_id: 'g2',
      start_date: '2024-09-01',
      home_team_id: 'h2',
      away_team_id: 'a2',
      home_team: 'Home 2',
      away_team: 'Away 2',
      pos_team: 'Home 2'
    },
    {
      season: 2024,
      game_id: 'g3',
      start_date: '2024-09-01',
      home_team_id: 'h3',
      away_team_id: 'a3',
      home_team: 'Home 3',
      away_team: 'Away 3',
      pos_team: 'Other'
    },
    {
      season: 2024,
      game_id: null,
      start_date: '2024-09-01',
      home_team_id: 'h4',
      away_team_id: 'a4',
      home_team: 'Home 4',
      away_team: 'Away 4',
      pos_team: 'Home 4'
    },
    {
      season: 2024,
      game_id: 'g5',
      start_date: 'not-a-date',
      home_team_id: 'h5',
      away_team_id: 'a5',
      home_team: 'Home 5',
      away_team: 'Away 5',
      pos_team: 'Home 5'
    },
    {
      season: 2024,
      game_id: 'g6',
      start_date: '2024-09-01',
      home_team_id: null,
      away_team_id: 'a6',
      home_team: 'Home 6',
      away_team: 'Away 6',
      pos_team: 'Home 6'
    },
    {
      season: 2024,
      game_id: 'g7',
      start_date: '2024-09-01',
      home_team_id: 'h7',
      away_team_id: 'a7',
      home_team: null,
      away_team: 'Away 7',
      pos_team: 'Away 7'
    },
    {
      season: 2024,
      game_id: 'g8',
      start_date: '2024-09-01',
      home_team_id: 'h8',
      away_team_id: 'a8',
      home_team: 'Home 8',
      away_team: 'Away 8',
      pos_team: 'Home 8'
    },
    {
      season: 2023,
      game_id: 'g8',
      start_date: '2024-09-01',
      home_team_id: 'h8',
      away_team_id: 'a8',
      home_team: 'Home 8',
      away_team: 'Away 8',
      pos_team: 'Away 8'
    }
  ];
  const result = summariesToGames(rows);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].gameId, 'g1');
  assert.equal(result.games[0].season, 2024);
  assert.equal(result.games[0].home.plays, 2);
  assert.equal(result.games[0].home.dropbacks, 1);
  assert.equal(result.games[0].home.havocEvents, 1);
  assert.equal(result.games[0].home.possessionSeconds, 120);
  assert.equal(result.games[0].away.plays, 3);
  assert.equal(result.exclusions.oneSided, 1);
  assert.equal(result.exclusions.identityMismatch, 1);
  assert.equal(result.exclusions.malformed, 5);
});

test('homeLine converts ESPN home-perspective spread to model home line', () => {
  assert.equal(homeLine(13.5), -13.5);
  assert.equal(homeLine(-7), 7);
});

test('ESPN attachment joins exact event IDs and keeps market/outcome top-level', () => {
  const features = [{ gameId: 123, startDate: '2025-09-01', features: { homeOffEpa: 0.2 } }];
  const source = new Map([
    [
      '123',
      {
        eventId: '123',
        season: 2025,
        neutralSite: false,
        home: { name: 'H', score: 24 },
        away: { name: 'A', score: 17 },
        odds: {
          provider: 'book',
          spreadOpen: 13.5,
          spreadClose: 10.5,
          homeSpreadOdds: -110,
          awaySpreadOdds: -110
        }
      }
    ]
  ]);
  const rows = attachEspnMarket(features, source);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventId, '123');
  assert.equal(rows[0].openingHomeLine, -13.5);
  assert.equal(rows[0].closingHomeLine, -10.5);
  assert.equal(rows[0].margin, 7);
  assert.equal(rows[0].features.openingHomeLine, undefined);
  assert.equal(rows[0].features.margin, undefined);
  assert.deepEqual(features[0], {
    gameId: 123,
    startDate: '2025-09-01',
    features: { homeOffEpa: 0.2 }
  });
});

test('ESPN attachment leaves missing open null and falls back to odds.spread for close', () => {
  const [row] = attachEspnMarket([{ gameId: 'x', features: {} }], {
    x: {
      eventId: 'x',
      home: { score: 3 },
      away: { score: 0 },
      odds: { spread: -7 }
    }
  });
  assert.equal(row.openingHomeLine, null);
  assert.equal(row.closingHomeLine, 7);
});

test('ESPN attachment falls back when spreadClose is unusable', () => {
  for (const spreadClose of [null, '', '  ', 'NaN', 'Infinity', 'not-a-number']) {
    const gameId = `close-${String(spreadClose)}`;
    const [row] = attachEspnMarket([{ gameId, season: 2025, features: {} }], {
      [gameId]: { eventId: gameId, odds: { spreadClose, spread: -7 } }
    });
    assert.equal(row.closingHomeLine, 7, `spreadClose=${String(spreadClose)}`);
  }
});

test('ESPN attachment does not join an arbitrary key to a different event ID', () => {
  const [row] = attachEspnMarket([{ gameId: '123', features: {} }], { 123: { eventId: '456' } });
  assert.deepEqual(row, { gameId: '123', features: {} });
});

test('ESPN attachment preserves the feature-row season when the event omits it', () => {
  const [row] = attachEspnMarket([{ gameId: 'season', season: 2024, features: {} }], {
    season: { eventId: 'season', odds: {} }
  });
  assert.equal(row.season, 2024);
});

test('ESPN attachment preserves explicit null and empty market values as null', () => {
  const [row] = attachEspnMarket([{ gameId: 'nulls', features: {} }], {
    nulls: {
      eventId: 'nulls',
      home: { score: null },
      away: { score: '' },
      odds: {
        spreadOpen: null,
        spreadClose: '  ',
        homeSpreadOdds: '',
        awaySpreadOdds: null
      }
    }
  });
  assert.equal(row.home.score, null);
  assert.equal(row.away.score, null);
  assert.equal(row.margin, null);
  assert.equal(row.openingHomeLine, null);
  assert.equal(row.closingHomeLine, null);
  assert.equal(row.homeSpreadOdds, null);
  assert.equal(row.awaySpreadOdds, null);
  for (const value of [null, undefined, '', '  ', 'NaN', 'Infinity', 'not-a-number'])
    assert.equal(finiteOrNull(value), null);
  for (const value of [0, 12.5, '12.5']) assert.equal(finiteOrNull(value), Number(value));
});

test('feature-ready coverage ignores games-observed counters', () => {
  const featureRows = [
    { gameId: 'cold', features: { homeGamesObserved: 0, awayGamesObserved: 0, homeOffEpa: null } },
    { gameId: 'ready', features: { homeGamesObserved: 2, awayGamesObserved: 2, homeOffEpa: 0.1 } },
    { gameId: 'string', features: { homeOffEpa: '0.1' } },
    { gameId: 'object', features: { homeOffEpa: {} } },
    { gameId: 'nan', features: { homeOffEpa: NaN } },
    { gameId: 'infinity', features: { homeOffEpa: Infinity } },
    { gameId: 'counter-only', features: { homeGamesObserved: 3, awayGamesObserved: 3 } },
    { gameId: 'other-season', features: { homeOffEpa: 0.2 } }
  ];
  const seasonRows = featureRows.filter(({ gameId }) => gameId !== 'other-season').map(({ gameId }) => ({ gameId }));
  assert.equal(countFeatureReadyRows(featureRows, seasonRows), 1);
});

test('summariesToGames classifies cross-row identity fields consistently', () => {
  const base = {
    season: 2024,
    game_id: 'g',
    start_date: '2024-09-01',
    home_team_id: 'h',
    away_team_id: 'a',
    home_team: 'Home',
    away_team: 'Away',
    plays: 1
  };
  const makeRows = (changes = {}) => [
    { ...base, pos_team: 'Home' },
    { ...base, pos_team: 'Away', ...changes }
  ];
  for (const changes of [
    { home_team_id: 'other' },
    { away_team_id: 'other' },
    { home_team: 'Other' },
    { away_team: 'Other' }
  ]) {
    const result = summariesToGames(makeRows(changes));
    assert.equal(result.games.length, 0);
    assert.equal(result.exclusions.identityMismatch, 1);
  }
  for (const changes of [{ season: 2023 }, { start_date: '2024-09-02' }]) {
    const result = summariesToGames(makeRows(changes));
    assert.equal(result.games.length, 0);
    assert.equal(result.exclusions.malformed, 1);
  }
});

test('parseArgs rejects missing or invalid seasons and output paths', () => {
  assert.throws(() => parseArgs(['node', 'script', '--seasons']), /--seasons requires a value/);
  assert.throws(() => parseArgs(['node', 'script', '--seasons', '']), /--seasons requires a value/);
  assert.throws(() => parseArgs(['node', 'script', '--seasons', '2024,2024']), /unique finite integers/);
  assert.throws(() => parseArgs(['node', 'script', '--seasons', '2024,2.5']), /unique finite integers/);
  assert.throws(() => parseArgs(['node', 'script', '--out']), /--out requires a value/);
  assert.throws(() => parseArgs(['node', 'script', '--out', '']), /--out requires a value/);
  assert.deepEqual(parseArgs(['node', 'script', '--seasons', '2024,2025', '--out', '/tmp/out.json']), {
    seasons: [2024, 2025],
    out: '/tmp/out.json'
  });
});

test('pure helpers do not mutate inputs', () => {
  const features = [{ gameId: 'x', features: { value: 1 } }];
  const espn = {
    x: { eventId: 'x', home: { score: 1 }, away: { score: 2 }, odds: {} }
  };
  const before = structuredClone({ features, espn });
  attachEspnMarket(features, espn);
  assert.deepEqual({ features, espn }, before);
});
