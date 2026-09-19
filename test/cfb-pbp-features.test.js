const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWalkForwardCfbFeatures } = require('../lib/cfb-pbp-features');

function summary(overrides = {}) {
  return {
    plays: 10,
    epaSum: 2,
    successSum: 6,
    explosivePlays: 2,
    earlyDownPlays: 6,
    earlyDownPasses: 3,
    earlyDownEpaSum: 1.2,
    passingDownPlays: 4,
    passingDownEpaSum: 0.8,
    dropbacks: 8,
    sacksAllowed: 1,
    turnovers: 1,
    havocEvents: 2,
    possessionSeconds: 300,
    scoringOpportunities: 2,
    scoringOpportunityPoints: 7,
    ...overrides
  };
}

function game(gameId, startDate, home, away, teamIds = ['home-team', 'away-team'], season = 2026) {
  return {
    gameId,
    season,
    startDate,
    homeTeamId: teamIds[0],
    awayTeamId: teamIds[1],
    home: summary(home),
    away: summary(away)
  };
}

test('first game has null metrics and zero prior games observed', () => {
  const [row] = buildWalkForwardCfbFeatures([game('g1', '2026-01-01T12:00:00Z', {}, {})]);

  assert.equal(row.features.homeOffEpa, null);
  assert.equal(row.features.awayOffEpa, null);
  assert.equal(row.features.homeDefEpaAllowed, null);
  assert.equal(row.features.awayDefEpaAllowed, null);
  assert.equal(row.features.homeGamesObserved, 0);
  assert.equal(row.features.awayGamesObserved, 0);
});

test('second game sees the first game rates when minGames is one', () => {
  const rows = buildWalkForwardCfbFeatures(
    [game('g1', '2026-01-01T12:00:00Z', { epaSum: 4 }, { epaSum: -2 }), game('g2', '2026-01-02T12:00:00Z', {}, {})],
    { minGames: 1 }
  );

  assert.equal(rows[1].features.homeOffEpa, 0.4);
  assert.equal(rows[1].features.awayOffEpa, -0.2);
  assert.equal(rows[1].features.homeGamesObserved, 1);
  assert.equal(rows[1].features.awayGamesObserved, 1);
});

test('havoc and pace derive from each team summary and map defense from opponent offense', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game(
        'g1',
        '2026-01-01T12:00:00Z',
        { havocEvents: 2, possessionSeconds: 300 },
        { havocEvents: 4, possessionSeconds: 600 }
      ),
      game('g2', '2026-01-02T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );
  assert.equal(rows[1].features.homeOffHavocAllowed, 0.2);
  assert.equal(rows[1].features.awayOffHavocAllowed, 0.4);
  assert.equal(rows[1].features.homeDefHavoc, 0.4);
  assert.equal(rows[1].features.awayDefHavoc, 0.2);
  assert.equal(rows[1].features.homePace, 2);
  assert.equal(rows[1].features.awayPace, 1);
});

test('pace ignores zero, null, and nonfinite possession seconds without updating readiness', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', { possessionSeconds: 0 }, { possessionSeconds: null }),
      game('g2', '2026-01-02T12:00:00Z', { possessionSeconds: Infinity }, { possessionSeconds: -1 }),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );
  assert.equal(rows[2].features.homePace, null);
  assert.equal(rows[2].features.awayPace, null);
});

test('havoc and pace each use independent per-metric minGames readiness', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game(
        'g1',
        '2026-01-01T12:00:00Z',
        { havocEvents: 2, possessionSeconds: null },
        { havocEvents: null, possessionSeconds: 300 }
      ),
      game(
        'g2',
        '2026-01-02T12:00:00Z',
        { havocEvents: null, possessionSeconds: 300 },
        { havocEvents: 2, possessionSeconds: null }
      ),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 2 }
  );
  assert.equal(rows[2].features.homeOffHavocAllowed, null);
  assert.equal(rows[2].features.homePace, null);
  assert.equal(rows[2].features.awayOffHavocAllowed, null);
  assert.equal(rows[2].features.awayPace, null);
});

test('new seasons reset team state and are included on output rows', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', { epaSum: 4 }, {}, undefined, 2025),
      game('g2', '2026-01-02T12:00:00Z', {}, {}, undefined, 2026),
      game('g3', '2026-01-03T12:00:00Z', {}, {}, undefined, 2026)
    ],
    { minGames: 1 }
  );

  assert.equal(rows[0].season, 2025);
  assert.equal(rows[1].season, 2026);
  assert.equal(rows[1].features.homeGamesObserved, 0);
  assert.equal(rows[1].features.homeOffEpa, null);
  assert.equal(rows[2].features.homeGamesObserved, 1);
  assert.equal(rows[2].features.homeOffEpa, 0.2);
});

test("a game's own summary never enters its own feature row", () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', { epaSum: 100 }, { epaSum: -100 }),
      game('g2', '2026-01-02T12:00:00Z', { epaSum: 50 }, { epaSum: -50 })
    ],
    { minGames: 1 }
  );

  assert.equal(rows[0].features.homeOffEpa, null);
  assert.equal(rows[1].features.homeOffEpa, 10);
  assert.equal(rows[1].features.awayOffEpa, -10);
});

test('same normalized kickoff instant games are both snapshotted before either updates state', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01', { havocEvents: 1, possessionSeconds: 300 }, {}),
      game('g2', '2026-01-01T00:00:00Z', { havocEvents: 4, possessionSeconds: 600 }, {}),
      game('g3', '2026-01-02T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );

  assert.equal(rows[0].features.homeGamesObserved, 0);
  assert.equal(rows[1].features.homeGamesObserved, 0);
  assert.equal(rows[2].features.homeGamesObserved, 2);
  assert.equal(rows[2].features.homeOffHavocAllowed, 0.205);
  assert.equal(rows[2].features.homeDefHavoc, 0.2);
  assert.equal(rows[2].features.awayOffHavocAllowed, 0.2);
  assert.equal(rows[2].features.awayDefHavoc, 0.205);
  assert.equal(rows[2].features.homePace, 1.65);
  assert.equal(rows[2].features.awayPace, 2);
});

test('zero dropbacks do not overwrite a prior sack rate', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', {}, {}),
      game('g2', '2026-01-02T12:00:00Z', { sacksAllowed: 3, dropbacks: 0, plays: 10 }, {}),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );

  assert.equal(rows[1].features.homeSackRateAllowed, 0.125);
  assert.equal(rows[2].features.homeSackRateAllowed, 0.125);
});

test('defense metrics update from opponent offense, not own offense', () => {
  const rows = buildWalkForwardCfbFeatures(
    [game('g1', '2026-01-01T12:00:00Z', { epaSum: 90 }, { epaSum: 10 }), game('g2', '2026-01-02T12:00:00Z', {}, {})],
    { minGames: 1 }
  );

  assert.equal(rows[1].features.homeDefEpaAllowed, 1);
  assert.equal(rows[1].features.awayDefEpaAllowed, 9);
});

test('third game applies fixed-alpha EWMA to prior game-level observations', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', { epaSum: 10 }, {}),
      game('g2', '2026-01-02T12:00:00Z', { epaSum: 20 }, {}),
      game('g3', '2026-01-03T12:00:00Z', { epaSum: 30 }, {})
    ],
    { alpha: 0.35, minGames: 1 }
  );

  assert.equal(rows[1].features.homeOffEpa, 1);
  assert.equal(rows[2].features.homeOffEpa, 1.35);
});

test('zero denominators and null observations do not create non-finite values or overwrite prior state', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', {}, {}),
      game(
        'g2',
        '2026-01-02T12:00:00Z',
        {
          plays: 0,
          earlyDownPlays: 0,
          passingDownPlays: 0,
          scoringOpportunities: 0
        },
        {}
      ),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );

  assert.equal(rows[1].features.homeOffEpa, 0.2);
  assert.equal(rows[1].features.homeEarlyDownPassRate, 0.5);
  assert.equal(rows[2].features.homeOffEpa, 0.2);
  assert.equal(rows[2].features.homeEarlyDownPassRate, 0.5);
  assert.equal(rows[2].features.homeSackRateAllowed, 0.125);
  assert.equal(rows[2].features.homeFinishingDrives, 3.5);
  for (const value of Object.values(rows[2].features)) {
    assert.ok(value === null || Number.isFinite(value) || Number.isInteger(value));
  }
});

test('all-invalid games do not count toward gamesObserved or minGames readiness', () => {
  const invalid = Object.fromEntries(Object.keys(summary()).map((key) => [key, NaN]));
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', {}, {}),
      game('g2', '2026-01-02T12:00:00Z', invalid, invalid),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 2 }
  );

  assert.equal(rows[2].features.homeGamesObserved, 1);
  assert.equal(rows[2].features.homeOffEpa, null);
});

test('readiness is tracked independently for each metric', () => {
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', {}, {}),
      game('g2', '2026-01-02T12:00:00Z', { scoringOpportunities: NaN }, {}),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 2 }
  );

  assert.equal(rows[2].features.homeOffEpa, 0.2);
  assert.equal(rows[2].features.homeFinishingDrives, null);
});

test('nonfinite and nonnumeric observations neither overwrite state nor create nonfinite output', () => {
  const invalid = Object.fromEntries(
    Object.keys(summary()).map((key, index) => [
      key,
      index % 3 === 0 ? NaN : index % 3 === 1 ? Infinity : 'not-a-number'
    ])
  );
  const rows = buildWalkForwardCfbFeatures(
    [
      game('g1', '2026-01-01T12:00:00Z', {}, {}),
      game('g2', '2026-01-02T12:00:00Z', invalid, invalid),
      game('g3', '2026-01-03T12:00:00Z', {}, {})
    ],
    { minGames: 1 }
  );

  assert.equal(rows[2].features.homeOffEpa, 0.2);
  assert.equal(rows[2].features.homeGamesObserved, 1);
  for (const value of Object.values(rows[2].features)) {
    assert.ok(value === null || Number.isFinite(value));
  }
});

test('input order is irrelevant and output is chronological', () => {
  const chronological = [
    game('g1', '2026-01-01T12:00:00Z', {}, {}),
    game('g2', '2026-01-02T12:00:00Z', {}, {}),
    game('g3', '2026-01-03T12:00:00Z', {}, {})
  ];
  const shuffled = [chronological[2], chronological[0], chronological[1]];

  const expected = buildWalkForwardCfbFeatures(chronological, { minGames: 1 });
  const actual = buildWalkForwardCfbFeatures(shuffled, { minGames: 1 });
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    actual.map(({ gameId }) => gameId),
    ['g1', 'g2', 'g3']
  );
});

test('equal timestamps sort by gameId regardless of input order', () => {
  const games = [
    game('z-game', '2026-01-01T00:00:00Z', { epaSum: 10 }, {}),
    game('a-game', '2026-01-01', { epaSum: 20 }, {}),
    game('m-game', '2026-01-01T00:00:00Z', { epaSum: 30 }, {})
  ];
  const expected = buildWalkForwardCfbFeatures(games, { minGames: 1 });
  const actual = buildWalkForwardCfbFeatures([games[1], games[2], games[0]], { minGames: 1 });

  assert.deepEqual(actual, expected);
  assert.deepEqual(
    actual.map(({ gameId }) => gameId),
    ['a-game', 'm-game', 'z-game']
  );
});

test('invalid alpha and minGames values throw clear errors', () => {
  assert.throws(() => buildWalkForwardCfbFeatures([], { alpha: 0 }), /alpha.*\(0, 1\]/i);
  assert.throws(() => buildWalkForwardCfbFeatures([], { alpha: 1.1 }), /alpha.*\(0, 1\]/i);
  assert.throws(() => buildWalkForwardCfbFeatures([], { minGames: 0 }), /minGames.*positive integer/i);
  assert.throws(() => buildWalkForwardCfbFeatures([], { minGames: 1.5 }), /minGames.*positive integer/i);
});

test('invalid games fail with game-specific validation errors', () => {
  assert.throws(() => buildWalkForwardCfbFeatures(null), /games must be an array/i);
  assert.throws(
    () => buildWalkForwardCfbFeatures([game('bad-date', 'not-a-date', {}, {})]),
    /bad-date.*invalid startDate/i
  );
  const numericDate = game('numeric-date', '2026-01-01T00:00:00Z', {}, {});
  numericDate.startDate = 0;
  assert.throws(() => buildWalkForwardCfbFeatures([numericDate]), /numeric-date.*invalid startDate/i);
  assert.throws(() => buildWalkForwardCfbFeatures([game('', '2026-01-01', {}, {})]), /index 0.*nonempty gameId/i);
  assert.throws(
    () => buildWalkForwardCfbFeatures([game('same-team', '2026-01-01', {}, {}, ['same', 'same'])]),
    /same-team.*distinct.*homeTeamId.*awayTeamId/i
  );
  assert.throws(
    () => buildWalkForwardCfbFeatures([{ ...game('missing-summary', '2026-01-01', {}, {}), away: null }]),
    /missing-summary.*away summary object/i
  );
  assert.throws(
    () => buildWalkForwardCfbFeatures([game('bad-season', '2026-01-01', {}, {}, undefined, 2026.5)]),
    /bad-season.*finite integer season/i
  );
});

test('inputs are not mutated', () => {
  const input = [game('g1', '2026-01-01T12:00:00Z', {}, {})];
  const before = structuredClone(input);
  buildWalkForwardCfbFeatures(input);
  assert.deepEqual(input, before);
});
