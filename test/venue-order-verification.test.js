'use strict';

/**
 * Venue-order verification.
 *
 * The PP feed's homeTeam/awayTeam are null for some games and inverted for
 * others (2026-09-13: Colorado_Rockies:Detroit_Tigers rendered as
 * "Detroit Tigers @ Colorado Rockies" for a game at Comerica Park). A wrong
 * `away @ home` label corrupts handicap interpretation, so we only assert one
 * when an independent source corroborates the matchup — and otherwise fail
 * closed. `fetchScoreboard` is injected here so these tests never hit the network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { verifyVenueOrder, matchCompetition, rowTeams, espnDate, previousDay } = require('../lib/ssb-venue-order');

describe('venue-order verification', () => {
  it('confirms a corroborated feed row and marks it verified', async () => {
    const row = {
      league: 'MLB',
      start: '2026-09-13T16:10:00.000Z',
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Colorado Rockies'
    };
    const fetchScoreboard = async (league, opts) => {
      assert.equal(league, 'MLB');
      assert.equal(opts.dates, '20260913');
      return [{ homeTeam: 'Detroit Tigers', awayTeam: 'Colorado Rockies', date: '2026-09-13T16:10Z' }];
    };

    const result = await verifyVenueOrder(row, { fetchScoreboard });
    assert.equal(result.venueOrderVerified, true);
    assert.equal(result.homeTeam, 'Detroit Tigers');
    assert.equal(result.awayTeam, 'Colorado Rockies');
    assert.equal(result.source, 'espn');
  });

  it('corrects a feed row that had home and away the wrong way round', async () => {
    const row = {
      league: 'MLB',
      start: '2026-09-13T17:40:00.000Z',
      homeTeam: 'Los Angeles Dodgers',
      awayTeam: 'Miami Marlins'
    };
    // ESPN truth: Dodgers away, Marlins home.
    const fetchScoreboard = async () => [
      { homeTeam: 'Miami Marlins', awayTeam: 'Los Angeles Dodgers', date: '2026-09-13T17:40Z' }
    ];

    const result = await verifyVenueOrder(row, { fetchScoreboard });
    assert.equal(result.venueOrderVerified, true);
    assert.equal(result.homeTeam, 'Miami Marlins');
    assert.equal(result.awayTeam, 'Los Angeles Dodgers');
  });

  it('fails closed when ESPN has no matching competition', async () => {
    const row = {
      league: 'MLB',
      start: '2026-09-13T16:10:00.000Z',
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Colorado Rockies'
    };
    const fetchScoreboard = async () => [
      { homeTeam: 'Boston Red Sox', awayTeam: 'Kansas City Royals', date: '2026-09-13T19:05Z' }
    ];

    const result = await verifyVenueOrder(row, { fetchScoreboard });
    assert.equal(result.venueOrderVerified, false);
    assert.equal(result.homeTeam, null);
    assert.equal(result.awayTeam, null);
  });

  it('fails closed on an empty board', async () => {
    const row = {
      league: 'MLB',
      start: '2026-09-13T16:10:00.000Z',
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Colorado Rockies'
    };
    const result = await verifyVenueOrder(row, { fetchScoreboard: async () => [] });
    assert.equal(result.venueOrderVerified, false);
  });

  it('fails closed when the board fetch throws', async () => {
    const row = {
      league: 'MLB',
      start: '2026-09-13T16:10:00.000Z',
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Colorado Rockies'
    };
    const result = await verifyVenueOrder(row, {
      fetchScoreboard: async () => {
        throw new Error('network down');
      }
    });
    assert.equal(result.venueOrderVerified, false);
  });

  it('leaves a soccer row unverified when the league has no ESPN board', async () => {
    const row = { league: 'Soccer', start: '2026-09-13T16:30:00.000Z', homeTeam: 'Getafe', awayTeam: 'Deportivo' };
    const result = await verifyVenueOrder(row, { fetchScoreboard: async () => [] });
    assert.equal(result.venueOrderVerified, false);
  });

  it('passes through a row that is already verified', async () => {
    const row = { league: 'MLB', venueOrderVerified: true, homeTeam: 'Athletics', awayTeam: 'Seattle Mariners' };
    const result = await verifyVenueOrder(row, {
      fetchScoreboard: async () => {
        throw new Error('should not be called');
      }
    });
    assert.equal(result.venueOrderVerified, true);
    assert.equal(result.source, 'row');
  });
});

describe('venue-order helpers', () => {
  it('prefers explicit team fields over the game string', () => {
    assert.deepEqual(rowTeams({ homeTeam: 'A', awayTeam: 'B', game: 'C vs D' }), { home: 'A', away: 'B' });
  });

  it('falls back to parsing the game string', () => {
    assert.deepEqual(rowTeams({ game: 'Colorado Rockies vs Detroit Tigers' }), {
      home: 'Colorado Rockies',
      away: 'Detroit Tigers'
    });
  });

  it('derives a YYYYMMDD board date from start', () => {
    assert.equal(espnDate({ start: '2026-09-13T16:10:00.000Z' }), '20260913');
    assert.equal(espnDate({}), undefined);
  });

  it('matches a competition in either orientation', () => {
    const comps = [{ homeTeam: 'Miami Marlins', awayTeam: 'Los Angeles Dodgers' }];
    assert.ok(matchCompetition(comps, 'Los Angeles Dodgers', 'Miami Marlins'));
    assert.ok(matchCompetition(comps, 'Miami Marlins', 'Los Angeles Dodgers'));
  });

  it('returns null when nothing clears the similarity threshold', () => {
    const comps = [{ homeTeam: 'Boston Red Sox', awayTeam: 'Kansas City Royals' }];
    assert.equal(matchCompetition(comps, 'Detroit Tigers', 'Colorado Rockies'), null);
  });
});

describe('venue-order board-date fallback', () => {
  it('walks back a day when ESPN files the game under the earlier US-local date', async () => {
    const row = {
      league: 'NFL',
      // 00:20Z on the 14th is 8:20pm ET on the 13th — ESPN files it under the 13th.
      start: '2026-09-14T00:20:00.000Z',
      homeTeam: 'Dallas Cowboys',
      awayTeam: 'New York Giants'
    };
    const asked = [];
    const fetchScoreboard = async (league, opts) => {
      asked.push(opts.dates);
      if (opts.dates === '20260914') return [{ homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos' }];
      if (opts.dates === '20260913') {
        return [{ homeTeam: 'New York Giants', awayTeam: 'Dallas Cowboys', date: '2026-09-14T00:20Z' }];
      }
      return [];
    };

    const result = await verifyVenueOrder(row, { fetchScoreboard });
    assert.deepEqual(asked, ['20260914', '20260913']);
    assert.equal(result.venueOrderVerified, true);
    assert.equal(result.homeTeam, 'New York Giants');
    assert.equal(result.awayTeam, 'Dallas Cowboys');
  });

  it('computes the previous calendar day across a month boundary', () => {
    assert.equal(previousDay('20260901'), '20260831');
    assert.equal(previousDay('20260914'), '20260913');
    assert.equal(previousDay('nonsense'), undefined);
  });
});
