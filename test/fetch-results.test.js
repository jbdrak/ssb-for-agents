'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fetchResults, espnDate, DEFAULT_LEAGUES } = require('../scripts/fetch-results');
const { validateResultPayload } = require('../lib/record-results');

const FINAL_MLB = {
  homeTeam: 'Pittsburgh Pirates',
  awayTeam: 'Milwaukee Brewers',
  homeScore: '7',
  awayScore: '4',
  status: 'Final',
  isFinal: true,
  winner: 'Pittsburgh Pirates',
  date: '2026-09-17T16:35:00.000Z'
};

const board = (competitions) => async () => competitions;

describe('fetch-results: date handling', () => {
  it('converts an ISO date to ESPN\u2019s compact form', () => {
    assert.equal(espnDate('2026-09-17'), '20260917');
    assert.equal(espnDate('2026-09-17T00:00:00Z'), '20260917');
    assert.equal(espnDate('nope'), undefined);
    assert.equal(espnDate(undefined), undefined);
  });

  it('defaults to the leagues ESPN serves and can settle', () => {
    assert.ok(DEFAULT_LEAGUES.includes('MLB'));
    assert.ok(DEFAULT_LEAGUES.includes('WNBA'));
    assert.equal(DEFAULT_LEAGUES.includes('TENNIS'), false);
  });
});

describe('fetch-results: ESPN path', () => {
  it('produces a document that satisfies the settlement result contract', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      leagues: ['MLB'],
      getBoard: board([FINAL_MLB])
    });
    assert.equal(result.ok, true);
    assert.equal(result.events, 1);
    assert.equal(result.provider, 'espn');
    // The whole point: settle-record will accept this.
    const validation = validateResultPayload(result.document);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.errors, []);
  });

  it('reports an unsupported league and an empty board instead of silently dropping them', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      leagues: ['MLB', 'CURLING'],
      getBoard: async (league) => (league === 'MLB' ? [FINAL_MLB] : [])
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped.leagues, [{ league: 'CURLING', reason: 'unsupported_league' }]);
  });

  it('records a fetch failure as a skip, not a crash', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      leagues: ['MLB'],
      getBoard: async () => {
        throw new Error('403 Access Denied');
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped.leagues[0].reason, 'fetch_failed');
    assert.match(result.skipped.leagues[0].detail, /403/);
  });

  it('can be turned off entirely with espn:false', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      espn: false,
      flashscorePayload: {
        days: [{ offset: 0, result: { matches: [{ stage: 'Finished', home: 'P', away: 'Q', homeWinner: true }] } }]
      }
    });
    assert.equal(result.provider, 'flashscore');
    assert.equal(result.events, 1);
  });
});

describe('fetch-results: combined sources', () => {
  it('merges ESPN and tennis into one document with honest provenance', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      leagues: ['MLB'],
      getBoard: board([FINAL_MLB]),
      flashscorePayload: {
        days: [
          {
            offset: 0,
            result: {
              matches: [
                {
                  stage: 'Finished',
                  home: 'Bucsa C.',
                  away: 'Bejlek S.',
                  homeWinner: true,
                  setsHome: '2',
                  setsAway: '0'
                }
              ]
            }
          }
        ]
      }
    });
    assert.equal(result.provider, 'espn+flashscore');
    assert.equal(result.events, 2);
    assert.deepEqual(result.counts, { final: 2 });
    assert.equal(validateResultPayload(result.document).ok, true);
  });

  it('refuses to write an empty document', async () => {
    const result = await fetchResults({
      date: '2026-09-17',
      leagues: ['MLB'],
      getBoard: async () => []
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no result events/);
  });
});
