'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const {
  clearSoccerEventCache,
  getSoccerScoreboardUrl,
  fetchSoccerScoreboard,
  normalizeSoccerTeamName,
  resolveSoccerEventContext,
  enrichSoccerEventRows
} = require('../lib/soccer-event-context');

function scoreboardResponse(events) {
  return {
    ok: true,
    async json() {
      return { events };
    }
  };
}

function event({
  date = '2026-09-07T18:45:00Z',
  home = 'Udinese',
  away = 'Lazio',
  homeShort = home,
  awayShort = away,
  homeAway = true
} = {}) {
  const competitors = [
    {
      ...(homeAway ? { homeAway: 'home' } : {}),
      team: { displayName: home, shortDisplayName: homeShort }
    },
    {
      ...(homeAway ? { homeAway: 'away' } : {}),
      team: { displayName: away, shortDisplayName: awayShort }
    }
  ];
  return {
    date,
    competitions: [{ competitors, venue: { fullName: 'Bluenergy Stadium' } }]
  };
}

function row(overrides = {}) {
  return {
    league: 'Soccer',
    leagueName: 'Serie A',
    start: '2026-09-07T18:45:00.000Z',
    homeTeam: 'Lazio',
    awayTeam: 'Udinese',
    ...overrides
  };
}

describe('soccer event context', () => {
  beforeEach(() => clearSoccerEventCache());

  it('builds competition-scoped ESPN scoreboard URLs', () => {
    assert.equal(
      getSoccerScoreboardUrl('Serie A', '2026-09-07'),
      'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates=20260907'
    );
    assert.equal(getSoccerScoreboardUrl('Soccer', '2026-09-07'), null);
  });

  it('normalizes team names without treating partial names as exact matches', () => {
    assert.equal(normalizeSoccerTeamName('  Cagliári  '), 'cagliari');
    assert.notEqual(normalizeSoccerTeamName('Celta'), normalizeSoccerTeamName('Celta Vigo'));
  });

  it('resolves exact team pair and date with ESPN home/away order', async () => {
    const context = await resolveSoccerEventContext(row(), {
      fetchImpl: async () => scoreboardResponse([event()])
    });
    assert.deepEqual(context, {
      resolved: true,
      source: 'espn',
      competition: 'Serie A',
      eventDate: '2026-09-07',
      start: '2026-09-07T18:45:00Z',
      homeTeam: 'Udinese',
      awayTeam: 'Lazio',
      venue: 'Bluenergy Stadium'
    });
  });

  it('resolves official team aliases and corrects reversed feed ordering', async () => {
    const context = await resolveSoccerEventContext(
      row({
        leagueName: 'Champions League',
        start: '2026-09-08T19:00:00.000Z',
        homeTeam: 'Inter Milan',
        awayTeam: 'Real Madrid'
      }),
      {
        fetchImpl: async () =>
          scoreboardResponse([
            event({
              date: '2026-09-08T19:00:00Z',
              home: 'Real Madrid',
              away: 'Internazionale',
              awayShort: 'Inter Milan'
            })
          ])
      }
    );
    assert.deepEqual(context, {
      resolved: true,
      source: 'espn',
      competition: 'Champions League',
      eventDate: '2026-09-08',
      start: '2026-09-08T19:00:00Z',
      homeTeam: 'Real Madrid',
      awayTeam: 'Internazionale',
      venue: 'Bluenergy Stadium'
    });
  });

  it('normalizes feed club spellings to the ESPN name', () => {
    assert.equal(normalizeSoccerTeamName('Athletic Bilbao'), 'athletic club');
    assert.equal(normalizeSoccerTeamName('Deportivo La Coruña'), 'deportivo');
    assert.equal(normalizeSoccerTeamName('Hapoel Beer Sheva'), 'hapoel beer');
    // A different club that merely shares a leading token must stay distinct.
    assert.notEqual(normalizeSoccerTeamName('Levante Las Planas'), normalizeSoccerTeamName('Levante'));
  });

  it('resolves a truncated ESPN club name on a neutral-venue home side', async () => {
    // ESPN lists Hapoel Be'er Sheva as "Hapoel Be'er" and files the game at a
    // neutral ground (Giulesti Stadium), which is exactly why venue order is
    // corroborated rather than inferred.
    const fetchImpl = async () =>
      scoreboardResponse([
        event({
          date: '2026-09-16T19:00:00Z',
          home: "Hapoel Be'er",
          away: 'Dinamo Zagreb',
          homeShort: "Hapoel Be'er",
          awayShort: 'Dinamo Zagreb'
        })
      ]);
    const context = await resolveSoccerEventContext(
      row({
        leagueName: 'Europa League',
        start: '2026-09-16T19:00:00.000Z',
        homeTeam: 'Hapoel Beer Sheva',
        awayTeam: 'Dinamo Zagreb'
      }),
      { fetchImpl }
    );
    assert.equal(context.resolved, true);
    assert.equal(context.homeTeam, "Hapoel Be'er");
    assert.equal(context.awayTeam, 'Dinamo Zagreb');
  });

  it('resolves a feed/ESPN spelling difference on the real La Liga pair', async () => {
    const fetchImpl = async () =>
      scoreboardResponse([
        event({
          date: '2026-09-16T19:30:00Z',
          home: 'Levante',
          away: 'Athletic Club',
          homeShort: 'Levante',
          awayShort: 'Athletic Club'
        })
      ]);
    const context = await resolveSoccerEventContext(
      row({
        leagueName: 'La Liga',
        start: '2026-09-16T19:30:00.000Z',
        homeTeam: 'Athletic Bilbao',
        awayTeam: 'Levante'
      }),
      { fetchImpl }
    );
    assert.equal(context.resolved, true);
    assert.equal(context.homeTeam, 'Levante');
    assert.equal(context.awayTeam, 'Athletic Club');
  });

  it('does not resolve a spelling difference onto a different club', async () => {
    const fetchImpl = async () =>
      scoreboardResponse([
        event({
          date: '2026-09-16T19:30:00Z',
          home: 'Levante',
          away: 'Sevilla',
          homeShort: 'Levante',
          awayShort: 'Sevilla'
        })
      ]);
    const context = await resolveSoccerEventContext(
      row({
        leagueName: 'La Liga',
        start: '2026-09-16T19:30:00.000Z',
        homeTeam: 'Levante Las Planas',
        awayTeam: 'Sevilla'
      }),
      { fetchImpl }
    );
    assert.equal(context.resolved, false);
    assert.equal(context.reason, 'schedule_match_not_found');
  });

  it('rejects a different event date', async () => {
    const context = await resolveSoccerEventContext(row(), {
      fetchImpl: async () => scoreboardResponse([event({ date: '2026-09-08T18:45:00Z' })])
    });
    assert.equal(context.resolved, false);
    assert.equal(context.reason, 'schedule_match_not_found');
  });

  it('rejects an unsupported or missing competition scope', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return scoreboardResponse([event()]);
    };
    assert.equal((await resolveSoccerEventContext(row({ leagueName: 'MLS' }), { fetchImpl })).resolved, false);
    assert.equal((await resolveSoccerEventContext(row({ leagueName: '' }), { fetchImpl })).resolved, false);
    assert.equal(fetchCalls, 0);
  });

  it('rejects incomplete competitors without explicit homeAway fields', async () => {
    const context = await resolveSoccerEventContext(row(), {
      fetchImpl: async () => scoreboardResponse([event({ homeAway: false })])
    });
    assert.equal(context.resolved, false);
    assert.equal(context.reason, 'schedule_match_not_found');
  });

  it('caches one scoreboard request for repeated rows in one enrichment', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return scoreboardResponse([event()]);
    };
    const enriched = await enrichSoccerEventRows([row(), row({ gameId: 'second-row' })], { fetchImpl });
    assert.equal(fetchCalls, 1);
    assert.equal(enriched.length, 2);
    assert.ok(enriched.every((item) => item.venueOrderVerified === true));
    assert.ok(enriched.every((item) => item.game === 'Lazio @ Udinese'));
  });

  it('aborts a scoreboard request that exceeds the bounded timeout', async () => {
    let aborted = false;
    const fetchImpl = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(options.signal.reason || new Error('aborted'));
          },
          { once: true }
        );
      });

    const result = await fetchSoccerScoreboard({
      leagueName: 'Serie A',
      dateKey: '2026-09-07',
      fetchImpl,
      timeoutMs: 5
    });

    assert.deepEqual(result, []);
    assert.equal(aborted, true);
  });
});
