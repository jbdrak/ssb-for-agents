'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getPlayResult,
  fetchEspnScoreboard,
  findMatch,
  clearCache,
  ESPN_LEAGUE_PATH
} = require('../lib/ssb-espn-resolver');

function makeComp({
  homeTeam = 'Lakers',
  awayTeam = 'Celtics',
  homeScore = '110',
  awayScore = '105',
  isFinal = true,
  winner = 'Lakers',
  date = '2026-08-26T00:00Z'
} = {}) {
  return { homeTeam, awayTeam, homeScore, awayScore, status: 'Final', isFinal, winner, date };
}

describe('findMatch', () => {
  const comps = [
    makeComp({ homeTeam: 'Lakers', awayTeam: 'Celtics' }),
    makeComp({ homeTeam: 'Heat', awayTeam: 'Bucks' })
  ];

  it('returns the best similarity match above threshold', () => {
    const m = findMatch(comps, 'Los Angeles Lakers');
    assert.equal(m.homeTeam, 'Lakers');
  });

  it('returns null when best similarity is below threshold', () => {
    const m = findMatch(comps, 'Zzzz Unknown Team', 0.99);
    assert.equal(m, null);
  });

  it('handles empty competition list', () => {
    assert.equal(findMatch([], 'Lakers'), null);
  });
});

describe('getPlayResult — pure branches', () => {
  beforeEach(() => clearCache());
  afterEach(() => clearCache());

  it('returns null for missing play/league/selection', async () => {
    assert.equal(await getPlayResult(null), null);
    assert.equal(await getPlayResult({}), null);
    assert.equal(await getPlayResult({ league: 'NBA' }), null);
    assert.equal(await getPlayResult({ selection: 'X' }), null);
  });

  it('returns null for unsupported league', async () => {
    assert.equal(await getPlayResult({ league: 'CRICKET', selection: 'X' }), null);
  });

  it('maps every supported league to an ESPN path', () => {
    for (const league of ['NBA', 'WNBA', 'NCAAB', 'MLB', 'NFL', 'NCAAF', 'NHL', 'TENNIS', 'UFC']) {
      assert.ok(ESPN_LEAGUE_PATH[league], `${league} should map to an ESPN path`);
    }
  });

  it('returns null when no competitions resolve', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ events: [] }) });
    try {
      assert.equal(await getPlayResult({ league: 'NBA', selection: 'Lakers', market: 'Moneyline' }), null);
    } finally {
      global.fetch = orig;
    }
  });

  it('returns null when selection does not match any game', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        events: [
          {
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Lakers' }, score: '110' },
                  { homeAway: 'away', team: { displayName: 'Celtics' }, score: '105' }
                ],
                status: { type: { state: 'post', description: 'Final' } }
              }
            ]
          }
        ]
      })
    });
    try {
      assert.equal(await getPlayResult({ league: 'NBA', selection: 'Unknown Team X', market: 'Moneyline' }), null);
    } finally {
      global.fetch = orig;
    }
  });

  it('returns null when the matched game is not final', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        events: [
          {
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Lakers' }, score: '50' },
                  { homeAway: 'away', team: { displayName: 'Celtics' }, score: '48' }
                ],
                status: { type: { state: 'in', description: 'Halftime' } }
              }
            ]
          }
        ]
      })
    });
    try {
      assert.equal(await getPlayResult({ league: 'NBA', selection: 'Lakers', market: 'Moneyline' }), null);
    } finally {
      global.fetch = orig;
    }
  });

  it('returns win for a moneyline pick on the winner (case-insensitive)', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        events: [
          {
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Lakers' }, score: '110' },
                  { homeAway: 'away', team: { displayName: 'Celtics' }, score: '105' }
                ],
                status: { type: { state: 'post', description: 'Final' } }
              }
            ]
          }
        ]
      })
    });
    try {
      assert.equal(await getPlayResult({ league: 'nba', selection: 'lakers', market: 'Moneyline' }), 'win');
    } finally {
      global.fetch = orig;
    }
  });

  it('returns loss for a moneyline pick on the loser', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        events: [
          {
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Lakers' }, score: '110' },
                  { homeAway: 'away', team: { displayName: 'Celtics' }, score: '105' }
                ],
                status: { type: { state: 'post', description: 'Final' } }
              }
            ]
          }
        ]
      })
    });
    try {
      assert.equal(await getPlayResult({ league: 'NBA', selection: 'Celtics', market: 'Moneyline' }), 'loss');
    } finally {
      global.fetch = orig;
    }
  });

  it('returns null for non-Moneyline markets (line not captured)', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        events: [
          {
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Lakers' }, score: '110' },
                  { homeAway: 'away', team: { displayName: 'Celtics' }, score: '105' }
                ],
                status: { type: { state: 'post', description: 'Final' } }
              }
            ]
          }
        ]
      })
    });
    try {
      assert.equal(await getPlayResult({ league: 'NBA', selection: 'Lakers', market: 'Spread' }), null);
    } finally {
      global.fetch = orig;
    }
  });
});

describe('fetchEspnScoreboard — caching + paths', () => {
  beforeEach(() => clearCache());
  afterEach(() => clearCache());

  it('returns [] for an unknown league (no path)', async () => {
    const out = await fetchEspnScoreboard('CRICKET');
    assert.deepEqual(out, []);
  });

  it('parses a scoreboard into competitions and caches it', async () => {
    let calls = 0;
    const orig = global.fetch;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          events: [
            {
              competitions: [
                {
                  competitors: [
                    { homeAway: 'home', team: { displayName: 'Lakers' }, score: '110' },
                    { homeAway: 'away', team: { displayName: 'Celtics' }, score: '105' }
                  ],
                  status: { type: { state: 'post', description: 'Final' } }
                }
              ]
            }
          ]
        })
      };
    };
    try {
      const first = await fetchEspnScoreboard('NBA');
      assert.equal(first.length, 1);
      assert.equal(first[0].homeTeam, 'Lakers');
      // Second call should hit cache, not re-fetch.
      const second = await fetchEspnScoreboard('NBA');
      assert.equal(calls, 1, 'cache prevents a second fetch');
      assert.equal(second.length, 1);
    } finally {
      global.fetch = orig;
    }
  });

  it('skips non-ok responses and falls through', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
      const out = await fetchEspnScoreboard('NBA');
      assert.deepEqual(out, []);
    } finally {
      global.fetch = orig;
    }
  });

  it('maps TENNIS to both atp and wta endpoints', async () => {
    const urls = [];
    const orig = global.fetch;
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ events: [] }) };
    };
    try {
      await fetchEspnScoreboard('TENNIS');
      assert.ok(urls.some((u) => u.includes('/tennis/atp/scoreboard')));
      assert.ok(urls.some((u) => u.includes('/tennis/wta/scoreboard')));
    } finally {
      global.fetch = orig;
    }
  });

  it('handles missing teams / competitors gracefully', async () => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ events: [{ competitions: [{ competitors: [{ homeAway: 'home', team: {} }] }] }] })
    });
    try {
      const out = await fetchEspnScoreboard('NBA');
      assert.deepEqual(out, []);
    } finally {
      global.fetch = orig;
    }
  });
});

assert.ok(typeof ESPN_LEAGUE_PATH === 'object', 'ESPN_LEAGUE_PATH exported for reference');
