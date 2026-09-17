'use strict';

// Massey games-board adapter (`massey_games`).
//
// The fixtures below are hand-built in the games board's DISPLAYED values and
// then run through the same per-cell obfuscation the page applies, so the
// decoder has real work to do rather than a payload it can pass through. The
// column layout mirrors the verified live board (2026-09-17): Date | time |
// Team | opponent | - | Stand | opp Stand | Scr | opp Scr | Pred | opp Pred |
// Pwin | opp Pwin | MOV | Spread | Total | O/U.

const test = require('node:test');
const assert = require('node:assert/strict');

const games = require('../lib/ratings-sources/massey-games.js');
const { canonicalTeam } = require('../lib/ssb-ratings-team-aliases.js');
const { supportedLeagues } = require('../lib/ssb-ratings-contract.js');

// `decodeSeed` reads everything after index 32, so the prefix is arbitrary.
const OBFU = 'aec37dc7aaeb'.padEnd(32, '0') + '7';

const GAMES_CI = [
  { title: 'Date' },
  {},
  { title: 'Team' },
  {},
  {},
  { title: 'Stand' },
  {},
  { title: 'Scr', gfac: 1 },
  { gfac: 1 },
  { title: 'Pred', gfac: 2 },
  { gfac: 2 },
  { title: 'Pwin', gfac: 2, decimals: 0 },
  { gfac: 2, decimals: 0 },
  { title: 'MOV', gfac: 2, decimals: 1 },
  { title: 'Spread', gfac: 2, decimals: 1 },
  { title: 'Total', gfac: 2, decimals: 1 },
  { title: 'O/U', gfac: 2, decimals: 1 }
];

/** The inverse of the page's per-cell obfuscation; walks columns like the page. */
function obfuscateRows(rows, columns, obfu) {
  let key = parseInt(String(obfu).slice(32), 10);
  const encoded = rows.map((row) => row.slice());
  for (let c = 0; c < columns.length; c++) {
    const type = columns[c].gfac;
    if (!type) continue;
    for (let r = 0; r < encoded.length; r++) {
      key = (0x1fb9 * key + 0x4d2) % 0x400;
      const value = encoded[r][c];
      if (typeof value !== 'number') continue;
      encoded[r][c] = type === 1 ? value + key : value * (key + 1);
    }
  }
  return encoded;
}

function payloadFor(rows, { columns = GAMES_CI, statuses = null } = {}) {
  return {
    CI: columns,
    DI: obfuscateRows(rows, columns, OBFU),
    RI: (statuses || rows.map(() => 'Scheduled')).map((s) => ({ style: `rcMLB rc${s}` })),
    timestamp: Date.parse('2026-09-17T14:35:00Z'),
    dtbase: '20260917'
  };
}

const MLB_ROW = [
  'Thu 09.17',
  '12:35.PM.ET',
  'Brewers | K Harrison',
  '@ Pirates | B Dotel',
  '',
  '# 1 (95-57)',
  '# 13 (75-77)',
  0,
  0,
  5,
  4,
  60.9649,
  39.0145,
  -1.5,
  1.5,
  9.5,
  9
];
const NFL_ROW = [
  'Thu 09.17',
  '8:15.PM.ET',
  'Detroit',
  '@ Buffalo',
  '',
  '# 8 (1-0)',
  '# 2 (1-0)',
  0,
  0,
  24,
  27,
  40.9743,
  58.5049,
  5.5,
  -3.5,
  51.5,
  55
];

function normalizeFrom(payload, league) {
  const table = games.masseyGamesTable({ payload, obfu: OBFU, league });
  return table;
}

/**
 * The JSON `fetchMasseyGames` hands the normalizer: the decoded table plus the
 * page URL, which the contract requires as provenance on every record.
 */
const PAGE_URL = 'https://masseyratings.com/mlb/mlb/games';

function rawFrom(payload, league) {
  const table = games.masseyGamesTable({ payload, obfu: OBFU, league, fetchedAt: '2026-09-17T14:35:01Z' });
  return JSON.stringify({ ...table, sourceUrl: PAGE_URL });
}

/**
 * Decoded numbers are exact from the real board, but re-obfuscating a fixture
 * multiplies then divides by the same keystream, so the fixture round-trip
 * carries float noise. Numeric assertions compare within that noise; identity
 * and structure assertions stay exact.
 */
function near(actual, expected, label) {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-6,
    `${label}: expected ~${expected}, got ${actual}`
  );
}

test('massey_games: the contract exposes the source and its leagues', () => {
  assert.equal(games.SOURCE, 'massey_games');
  assert.equal(games.METHOD, 'games');
  assert.deepEqual(supportedLeagues('massey_games'), ['MLB', 'MLS', 'NBA', 'NCAAB', 'NCAAF', 'NFL', 'NHL', 'WNBA']);
});

test('massey_games: an unsupported league is reported, not fetched', () => {
  assert.match(games.unsupportedReason('TENNIS'), /not published by massey/);
  assert.match(games.unsupportedReason('UFC'), /not published by massey/);
  assert.match(games.unsupportedReason('nonsense'), /not a recognized league code/);
  assert.equal(games.unsupportedReason('MLB'), null);
  assert.equal(games.unsupportedReason('CFB'), null); // the CLI spelling
  assert.equal(games.pageUrlFor('CFB'), 'https://masseyratings.com/cf/fbs/games');
});

test('massey_games: the table reads both sides of a fixture', () => {
  const table = normalizeFrom(payloadFor([MLB_ROW]), 'MLB');
  assert.equal(table.games.length, 1);
  const game = table.games[0];
  assert.equal(game.away, 'Brewers');
  assert.equal(game.home, 'Pirates');
  near(game.awayPred, 5, 'awayPred');
  near(game.homePred, 4, 'homePred');
  near(game.awayPwin, 60.9649, 'awayPwin');
  near(game.homePwin, 39.0145, 'homePwin');
  near(game.spread, 1.5, 'spread');
  near(game.total, 9.5, 'total');
});

test('massey_games: teamA is the HOME side and carries the home win probability', () => {
  const normalized = games.normalizeMasseyGames({
    raw: rawFrom(payloadFor([MLB_ROW]), 'MLB'),
    league: 'MLB',
    fetchedAt: '2026-09-17T14:35:01Z'
  });
  assert.equal(normalized.coverage, 'full');
  assert.equal(normalized.records.length, 1);
  const record = normalized.records[0];
  assert.equal(record.teamA, 'Pittsburgh Pirates'); // home
  assert.equal(record.teamB, 'Milwaukee Brewers'); // away
  near(record.predictedScoreA, 4, 'predictedScoreA'); // home
  near(record.predictedScoreB, 5, 'predictedScoreB'); // away
  near(record.predictedTotal, 9, 'predictedTotal');
  near(record.predictedMargin, -1, 'predictedMargin'); // home - away
  near(record.modelWinProbability, 0.390145, 'modelWinProbability');
  assert.equal(record.modelWinProbabilityKind, 'published');
  near(record.marketCurrent, 1.5, 'marketCurrent'); // the home side's printed spread
  assert.equal(record.marketOpen, null);
  assert.equal(record.neutral, false);
  assert.equal(record.asOf, '2026-09-17');
  assert.equal(record.season, 2026);
  assert.equal(record.method, 'games');
});

test('massey_games: a city-only NFL board resolves through the alias registry', () => {
  const normalized = games.normalizeMasseyGames({
    raw: rawFrom(payloadFor([NFL_ROW]), 'NFL'),
    league: 'NFL',
    fetchedAt: '2026-09-17T14:35:01Z'
  });
  assert.equal(normalized.records.length, 1);
  const record = normalized.records[0];
  assert.equal(record.matchStatus, 'unmatched');
  assert.equal(record.teamA, 'Buffalo Bills'); // home
  assert.equal(record.teamB, 'Detroit Lions'); // away
  near(record.modelWinProbability, 0.585049, 'modelWinProbability');
  near(record.predictedMargin, 3, 'predictedMargin'); // home - away
});

test('massey_games: a SOCCER board prints a country prefix that is stripped', () => {
  const row = [
    'Thu 09.17',
    '7:30.PM.ET',
    'USA/New York',
    '@ USA/NYC FC',
    '',
    '# 1',
    '# 2',
    0,
    0,
    1,
    1,
    48.9688,
    51.0312,
    0.5,
    -0.5,
    2.5,
    2
  ];
  const table = normalizeFrom(payloadFor([row]), 'MLS');
  assert.equal(table.games[0].away, 'New York');
  assert.equal(table.games[0].home, 'NYC FC');
  assert.equal(canonicalTeam(table.games[0].away, 'MLS'), 'Red Bull New York');
  assert.equal(canonicalTeam(table.games[0].home, 'MLS'), 'New York City FC');
});

test('massey_games: a settled row is dropped, not scored', () => {
  const payload = payloadFor([MLB_ROW, NFL_ROW], { statuses: ['Scheduled', 'Final'] });
  const table = games.masseyGamesTable({ payload, obfu: OBFU, league: 'MLB' });
  assert.equal(table.games.length, 1);
  assert.equal(table.settledSkipped, 1);
});

test('massey_games: a row without the @ marker has no verified venue and is dropped', () => {
  const noMarker = MLB_ROW.slice();
  noMarker[3] = 'Pirates | B Dotel'; // venue unmarked
  const table = games.masseyGamesTable({ payload: payloadFor([noMarker]), obfu: OBFU, league: 'MLB' });
  assert.equal(table.games.length, 0);
});

test('massey_games: a board whose rows are all settled reports why, not an empty table', () => {
  const payload = payloadFor([MLB_ROW], { statuses: ['Final'] });
  const raw = rawFrom(payload, 'MLB');
  const normalized = games.normalizeMasseyGames({ raw, league: 'MLB', fetchedAt: '2026-09-17T14:35:01Z' });
  assert.equal(normalized.coverage, 'unavailable');
  assert.equal(normalized.records.length, 0);
  assert.match(normalized.unresolvedReason, /only settled fixtures/);
});

test('massey_games: a vendor reorder drops the Pwin column and fails loudly', () => {
  const columns = GAMES_CI.filter((column) => column.title !== 'Pwin' && column.decimals !== 0);
  const payload = { CI: columns, DI: obfuscateRows([MLB_ROW], columns, OBFU), RI: [{ style: 'rcMLB rcScheduled' }] };
  assert.throws(() => games.masseyGamesTable({ payload, obfu: OBFU, league: 'MLB' }), /no Pwin column/);
});

test('massey_games: a raw that is not the expected table fails closed', () => {
  const normalized = games.normalizeMasseyGames({
    raw: '<html>nope</html>',
    league: 'MLB',
    fetchedAt: '2026-09-17T14:35:01Z'
  });
  assert.equal(normalized.coverage, 'unavailable');
  assert.equal(normalized.records.length, 0);
});

test('massey_games: the NFL and WNBA city spellings the board prints all resolve', () => {
  const nfl = [
    'Arizona',
    'Atlanta',
    'Baltimore',
    'Buffalo',
    'Carolina',
    'Chicago',
    'Cincinnati',
    'Cleveland',
    'Dallas',
    'Denver',
    'Detroit',
    'Green Bay',
    'Houston',
    'Indianapolis',
    'Jacksonville',
    'Kansas City',
    'LA Chargers',
    'LA Rams',
    'Las Vegas',
    'Miami',
    'Minnesota',
    'NY Giants',
    'NY Jets',
    'New England',
    'New Orleans',
    'Philadelphia',
    'Pittsburgh',
    'San Francisco',
    'Seattle',
    'Tampa Bay',
    'Tennessee',
    'Washington'
  ];
  const wnba = [
    'Atlanta',
    'Chicago',
    'Connecticut',
    'Dallas',
    'Golden State',
    'Indiana',
    'Las Vegas',
    'Los Angeles',
    'Minnesota',
    'New York',
    'Phoenix',
    'Portland',
    'Seattle',
    'Toronto',
    'Washington'
  ];
  for (const name of nfl) assert.ok(canonicalTeam(name, 'NFL'), `NFL ${name} should resolve`);
  for (const name of wnba) assert.ok(canonicalTeam(name, 'WNBA'), `WNBA ${name} should resolve`);
});
