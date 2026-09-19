'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FEATURES_SCRIPT = path.join(__dirname, '..', 'scripts', 'mlb-statcast-features.py');
const COLLECT_SCRIPT = path.join(__dirname, '..', 'scripts', 'mlb-statcast-collect.py');

const HEADER = [
  'game_date',
  'game_pk',
  'pitcher',
  'batter',
  'events',
  'description',
  'home_team',
  'away_team',
  'inning_topbot',
  'launch_speed',
  'launch_angle',
  'estimated_woba_using_speedangle'
];

function pitch(values) {
  return HEADER.map((column) => values[column] ?? '').join(',');
}

function fixtureCsv() {
  const rows = [HEADER.join(',')];
  // Day 1, game 100: HOU (home) vs NYY (away).
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P1',
      batter: 'NYY1',
      events: 'strikeout',
      description: 'called_strike',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P1',
      batter: 'NYY2',
      events: 'walk',
      description: 'ball',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P9',
      batter: 'NYY3',
      description: 'ball',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P9',
      batter: 'NYY3',
      events: 'field_out',
      description: 'hit_into_play',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Top',
      launch_speed: '85',
      launch_angle: '10',
      estimated_woba_using_speedangle: '0.2'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P2',
      batter: 'HOU1',
      events: 'single',
      description: 'hit_into_play',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Bot',
      launch_speed: '100',
      launch_angle: '20',
      estimated_woba_using_speedangle: '0.9'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '100',
      pitcher: 'P2',
      batter: 'HOU2',
      events: 'field_out',
      description: 'hit_into_play',
      home_team: 'HOU',
      away_team: 'NYY',
      inning_topbot: 'Bot',
      launch_speed: '80',
      launch_angle: '5',
      estimated_woba_using_speedangle: '0.15'
    })
  );
  // Day 1, game 101: LAD (home) vs SF (away).
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '101',
      pitcher: 'Q1',
      batter: 'SF1',
      events: 'strikeout',
      description: 'swinging_strike',
      home_team: 'LAD',
      away_team: 'SF',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '101',
      pitcher: 'Q2',
      batter: 'LAD1',
      events: 'walk',
      description: 'ball',
      home_team: 'LAD',
      away_team: 'SF',
      inning_topbot: 'Bot'
    })
  );
  // Day 1, game 103: SF (home) vs HOU (away) — same-day second game for HOU.
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '103',
      pitcher: 'Q9',
      batter: 'HOU9',
      events: 'strikeout',
      description: 'called_strike',
      home_team: 'SF',
      away_team: 'HOU',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-01',
      game_pk: '103',
      pitcher: 'R9',
      batter: 'SF9',
      events: 'single',
      description: 'hit_into_play',
      home_team: 'SF',
      away_team: 'HOU',
      inning_topbot: 'Bot',
      launch_speed: '99',
      launch_angle: '25',
      estimated_woba_using_speedangle: '0.8'
    })
  );
  // Day 2, game 102: HOU (home) vs LAD (away).
  rows.push(
    pitch({
      game_date: '2024-06-02',
      game_pk: '102',
      pitcher: 'R1',
      batter: 'LAD9',
      events: 'strikeout',
      description: 'swinging_strike',
      home_team: 'HOU',
      away_team: 'LAD',
      inning_topbot: 'Top'
    })
  );
  rows.push(
    pitch({
      game_date: '2024-06-02',
      game_pk: '102',
      pitcher: 'Q1',
      batter: 'HOU8',
      events: 'walk',
      description: 'ball',
      home_team: 'HOU',
      away_team: 'LAD',
      inning_topbot: 'Bot'
    })
  );
  return `${rows.join('\n')}\n`;
}

function runFeatures(cacheDir, extraArgs = []) {
  return spawnSync('python3', [FEATURES_SCRIPT, '--cache-dir', cacheDir, ...extraArgs], { encoding: 'utf8' });
}

function setupCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statcast-contract-'));
  const csvDir = path.join(dir, 'raw', 'csv');
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(path.join(csvDir, 'savant-2024-06-01_2024-06-02.csv'), fixtureCsv(), 'utf8');
  return dir;
}

function loadFeatures(cacheDir) {
  const out = path.join(cacheDir, 'features.jsonl');
  return fs
    .readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('features builder emits one row per game-team with null priors on day one', () => {
  const dir = setupCache();
  try {
    const result = runFeatures(dir, ['--out', path.join(dir, 'features.jsonl')]);
    assert.equal(result.status, 0, result.stderr);
    const rows = loadFeatures(dir);
    assert.equal(rows.length, 8);
    for (const row of rows.filter((candidate) => candidate.game_date === '2024-06-01')) {
      assert.equal(row.teamBatGames, 0);
      assert.equal(row.starterGames, 0);
      assert.equal(row.teamBatXwoba20, null);
      assert.equal(row.teamBatKRate20, null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same-day games cannot see each other even for the same team', () => {
  const dir = setupCache();
  try {
    const result = runFeatures(dir, ['--out', path.join(dir, 'features.jsonl')]);
    assert.equal(result.status, 0, result.stderr);
    const rows = loadFeatures(dir);
    // HOU plays twice on day one (games 100 and 103); both snapshots must show zero priors.
    const houDayOne = rows.filter((row) => row.game_date === '2024-06-01' && row.team === 'HOU');
    assert.equal(houDayOne.length, 2);
    for (const row of houDayOne) assert.equal(row.teamBatGames, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('day-two rows reflect both prior-day games and only those games', () => {
  const dir = setupCache();
  try {
    const result = runFeatures(dir, ['--out', path.join(dir, 'features.jsonl')]);
    assert.equal(result.status, 0, result.stderr);
    const rows = loadFeatures(dir);
    const hou = rows.find((row) => row.game_pk === '102' && row.team === 'HOU');
    // HOU batting day one: game 100 (2 PA, 0 K, xwOBA 0.9 + 0.15) + game 103 (1 PA, 1 K).
    assert.equal(hou.teamBatGames, 2);
    assert.equal(hou.teamBatKRate20, 1 / 3);
    assert.equal(hou.teamBatXwoba20, 1.05 / 2);
    // HOU pitching day one allowed: game 100 (3 PA, 1 K, xwOBA 0.2 on 1) + game 103 (1 PA, 0 K, xwOBA 0.8).
    assert.equal(hou.teamPitXwobaAllowed20, 1.0 / 2);
    // Bullpen: P9 threw 2 non-starter pitches for HOU on day one; nothing else.
    assert.equal(hou.bullpenPitches7d, 2);
    assert.equal(hou.bullpenPitches1d, 2);
    // Unknown day-two starter R1 has no history: starter metrics stay null.
    assert.equal(hou.starter, 'R1');
    assert.equal(hou.starterGames, 0);
    assert.equal(hou.starterKRate8, null);
    // LAD starter Q1 pitched day one (1 K in 1 PA) so day-two LAD carries it.
    const lad = rows.find((row) => row.game_pk === '102' && row.team === 'LAD');
    assert.equal(lad.starter, 'Q1');
    assert.equal(lad.starterGames, 1);
    assert.equal(lad.starterKRate8, 1);
    // LAD batting day one: one walk in one PA.
    assert.equal(lad.teamBatGames, 1);
    assert.equal(lad.teamBatBBRate20, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required columns fail loudly instead of producing silent nulls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statcast-contract-'));
  try {
    const csvDir = path.join(dir, 'raw', 'csv');
    fs.mkdirSync(csvDir, { recursive: true });
    fs.writeFileSync(path.join(csvDir, 'savant-bad.csv'), 'game_date,game_pk\n2024-06-01,1\n', 'utf8');
    const result = runFeatures(dir, ['--out', path.join(dir, 'features.jsonl')]);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collector rejects an inverted date range without touching the network', () => {
  const result = spawnSync('python3', [COLLECT_SCRIPT, '--start', '2024-06-02', '--end', '2024-06-01'], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
});
