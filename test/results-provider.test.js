'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../lib/results-provider');

describe('results-provider: status mapping', () => {
  it('maps ESPN and Flashscore status text onto settlement statuses', () => {
    assert.equal(provider.settlementStatus('Final'), 'final');
    assert.equal(provider.settlementStatus('STATUS_FINAL'), 'unknown');
    assert.equal(provider.settlementStatus('In Progress'), 'in_progress');
    assert.equal(provider.settlementStatus('Scheduled'), 'scheduled');
    assert.equal(provider.settlementStatus('Postponed'), 'postponed');
    assert.equal(provider.settlementStatus('Canceled'), 'postponed');
    assert.equal(provider.settlementStatus('Retired'), 'retired');
    assert.equal(provider.settlementStatus('Walkover'), 'retired');
    assert.equal(provider.settlementStatus(''), 'unknown');
  });

  it('reads a retirement as a retirement even when the event is also over', () => {
    assert.equal(provider.settlementStatus('Finished - Retired'), 'retired');
  });
});

describe('results-provider: date shifting', () => {
  it('shifts a calendar date by whole days', () => {
    assert.equal(provider.shiftIsoDate('2026-09-17', 0), '2026-09-17');
    assert.equal(provider.shiftIsoDate('2026-09-17', -1), '2026-09-16');
    assert.equal(provider.shiftIsoDate('2026-09-17', 1), '2026-09-18');
  });

  it('returns null for an unusable date', () => {
    assert.equal(provider.shiftIsoDate('nonsense', 0), null);
    assert.equal(provider.shiftIsoDate(null, 0), null);
  });
});

describe('results-provider: ESPN boards', () => {
  it('maps a final competition to a gradable event', () => {
    const events = provider.eventsFromEspnBoards(
      {
        MLB: [
          {
            homeTeam: 'Pittsburgh Pirates',
            awayTeam: 'Milwaukee Brewers',
            homeScore: '7',
            awayScore: '4',
            status: 'Final',
            isFinal: true,
            winner: 'Pittsburgh Pirates',
            date: '2026-09-17T16:35:00.000Z'
          }
        ]
      },
      { date: '2026-09-17' }
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'final');
    assert.equal(events[0].homeScore, 7);
    assert.equal(events[0].winner, 'Pittsburgh Pirates');
    assert.equal(events[0].provider, 'espn');
    // No synthetic event id: the name+date match is the fail-safe path.
    assert.equal(events[0].eventId, null);
  });

  it('keeps a non-final game without a winner, so it cannot be graded', () => {
    const events = provider.eventsFromEspnBoards(
      {
        MLB: [
          {
            homeTeam: 'A',
            awayTeam: 'B',
            homeScore: '0',
            awayScore: '0',
            status: 'Scheduled',
            isFinal: false,
            winner: null,
            date: '2026-09-18T00:00:00Z'
          }
        ]
      },
      { date: '2026-09-17' }
    );
    assert.equal(events[0].status, 'scheduled');
    assert.equal(events[0].winner, null);
  });

  it('drops an entry missing either side, and empty score strings become null', () => {
    const events = provider.eventsFromEspnBoards(
      {
        MLB: [
          { homeTeam: 'A', awayTeam: '', status: 'Final', isFinal: true, homeScore: '', awayScore: '', date: 'x' },
          {
            homeTeam: 'C',
            awayTeam: 'D',
            status: 'Final',
            isFinal: true,
            homeScore: '',
            awayScore: '',
            winner: 'C',
            date: 'y'
          }
        ]
      },
      { date: '2026-09-17' }
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].homeScore, null);
  });
});

describe('results-provider: Flashscore payload', () => {
  const payload = {
    scrapedAt: '2026-09-17T21:26:00.000Z',
    days: [
      {
        strip: '17/09 Th',
        offset: 0,
        result: {
          matches: [
            {
              stage: 'Finished',
              tournament: 'Guadalajara (Mexico)',
              category: 'WTA - SINGLES',
              home: 'Bucsa C.',
              away: 'Bejlek S.',
              homeWinner: true,
              awayWinner: false,
              setsHome: '2',
              setsAway: '0'
            },
            {
              stage: 'Retired',
              home: 'Ret.',
              away: 'Other',
              homeWinner: false,
              awayWinner: false,
              setsHome: '1',
              setsAway: '0'
            },
            { stage: 'Cancelled', home: 'X', away: 'Y', homeWinner: false, awayWinner: false }
          ]
        }
      }
    ]
  };

  it('maps a finished match with the winner and NEVER the sets as a score', () => {
    const events = provider.eventsFromFlashscorePayload(payload, { date: '2026-09-17' });
    const final = events.find((e) => e.homeTeam === 'Bucsa C.');
    assert.equal(final.status, 'final');
    assert.equal(final.winner, 'Bucsa C.');
    // The load-bearing rule: sets published as scores would settle a games
    // total off 2 + 0 = 2 and grade 'Under 21.5 games' as a win.
    assert.equal(final.homeScore, null);
    assert.equal(final.awayScore, null);
    assert.equal(final.setsHome, '2');
    assert.equal(final.setsAway, '0');
    assert.equal(final.date, '2026-09-17');
  });

  it('maps retired and cancelled stages without inventing a winner', () => {
    const events = provider.eventsFromFlashscorePayload(payload, { date: '2026-09-17' });
    const retired = events.find((e) => e.awayTeam === 'Other');
    assert.equal(retired.status, 'retired');
    const cancelled = events.find((e) => e.homeTeam === 'X');
    assert.equal(cancelled.status, 'postponed');
    assert.equal(cancelled.winner, null);
  });

  it('derives the date from the day offset, and leaves it null without a base date', () => {
    const older = {
      days: [{ offset: 2, result: { matches: [{ stage: 'Finished', home: 'P', away: 'Q', homeWinner: true }] } }]
    };
    assert.equal(provider.eventsFromFlashscorePayload(older, { date: '2026-09-17' })[0].date, '2026-09-15');
    assert.equal(provider.eventsFromFlashscorePayload(older, {})[0].date, null);
  });
});

describe('results-provider: document assembly', () => {
  it('derives provenance from the events that are actually present', () => {
    const document = provider.buildResultsDocument([
      {
        homeTeam: 'A',
        awayTeam: 'B',
        date: '2026-09-17',
        status: 'final',
        provider: 'espn',
        sourceUrl: 'https://espn.test/mlb'
      },
      {
        homeTeam: 'C',
        awayTeam: 'D',
        date: '2026-09-17',
        status: 'final',
        provider: 'flashscore',
        sourceUrl: 'https://fs.test/'
      }
    ]);
    assert.equal(document.provider, 'espn+flashscore');
    assert.equal(document.sourceUrl, 'https://espn.test/mlb https://fs.test/');
    assert.equal(document.events.length, 2);
    assert.deepEqual(document.counts, { final: 2 });
  });

  it('dedupes the same matchup on the same day', () => {
    const events = [
      { homeTeam: 'A', awayTeam: 'B', date: '2026-09-17T01:00:00Z', status: 'final', provider: 'espn', sourceUrl: 'u' },
      { homeTeam: 'a', awayTeam: 'b', date: '2026-09-17T02:00:00Z', status: 'final', provider: 'espn', sourceUrl: 'u' }
    ];
    const document = provider.buildResultsDocument(events);
    assert.equal(document.events.length, 1);
  });

  it('refuses to build an empty document rather than let a quiet slate read as a source', () => {
    assert.equal(provider.buildResultsDocument([]).ok, false);
    assert.equal(provider.buildResultsDocument([{ homeTeam: '', awayTeam: '' }]).ok, false);
  });
});
