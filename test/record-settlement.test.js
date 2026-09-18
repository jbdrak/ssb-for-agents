'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const settlement = require('../lib/record-settlement');
const ledgerModule = require('../lib/record-ledger');

// Focused Task 5 tests: local-only settlement over SUPPLIED result data.
// No network, no fuzzy guessing; unknown/ambiguous events stay pending.

const MLB_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';

function mlbBet(overrides = {}) {
  return {
    id: 'bet-1',
    gameId: '401234567',
    game: 'NYY @ BOS',
    league: 'MLB',
    market: 'Moneyline',
    selection: 'Yankees',
    odds: -120,
    stake: 50,
    start: '2026-08-05T18:00:00.000Z',
    ...overrides
  };
}

function mlbResult(overrides = {}) {
  return {
    provider: 'espn',
    sourceUrl: MLB_URL,
    events: [
      {
        eventId: '401234567',
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeScore: 5,
        awayScore: 3,
        status: 'final',
        rawStatus: 'Final',
        date: '2026-08-05T23:05:00.000Z',
        ...overrides
      }
    ]
  };
}

// Shared Brewers/Pirates fixtures used by the same-ID identity, date-window,
// and provenance-gate regression suites below (hoisted to module scope).
function brewersPiratesBet(overrides = {}) {
  return {
    id: 'bet-bp-1',
    gameId: 'g-fabricated',
    game: 'Pirates @ Brewers',
    league: 'MLB',
    market: 'Total Runs',
    selection: 'Under 7.5',
    line: 7.5,
    odds: -110,
    stake: 50,
    start: '2026-08-04T23:40:00.000Z',
    ...overrides
  };
}

function brewersPiratesResult(overrides = {}) {
  return {
    provider: 'espn',
    sourceUrl: MLB_URL,
    events: [
      {
        eventId: 'g-fabricated',
        homeTeam: 'Milwaukee Brewers',
        awayTeam: 'Pittsburgh Pirates',
        homeScore: 4,
        awayScore: 2,
        status: 'final',
        date: '2026-08-05T02:00:00.000Z',
        ...overrides
      }
    ]
  };
}

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const operations = [];
  return {
    files,
    operations,
    existsSync(filePath) {
      return files.has(filePath);
    },
    readFileSync(filePath, encoding) {
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const value = files.get(filePath);
      return encoding ? value : Buffer.from(value);
    },
    mkdirSync(directory) {
      operations.push(['mkdir', directory]);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
      operations.push(['write', filePath]);
    },
    openSync(filePath) {
      operations.push(['open', filePath]);
      return filePath;
    },
    fsyncSync(fileHandle) {
      operations.push(['fsync', fileHandle]);
    },
    closeSync(fileHandle) {
      operations.push(['close', fileHandle]);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      operations.push(['rename', from, to]);
    }
  };
}

describe('normalizeResultData', () => {
  it('flattens an ESPN MLB event (nested competitions) into one normalized event', () => {
    const { events } = settlement.normalizeResultData({
      provider: 'espn',
      sourceUrl: MLB_URL,
      events: [
        {
          id: '401234567',
          date: '2026-08-05T23:05:00.000Z',
          status: { type: { state: 'post', description: 'Final' } },
          competitions: [
            {
              id: '401234567',
              date: '2026-08-05T23:05:00.000Z',
              status: { type: { state: 'post', description: 'Final' } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'New York Yankees' }, score: '5' },
                { homeAway: 'away', team: { displayName: 'Boston Red Sox' }, score: '3' }
              ]
            }
          ]
        }
      ]
    });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.eventId, '401234567');
    assert.equal(event.homeTeam, 'New York Yankees');
    assert.equal(event.awayTeam, 'Boston Red Sox');
    assert.equal(event.homeScore, 5);
    assert.equal(event.awayScore, 3);
    assert.equal(event.status, 'final');
    assert.equal(event.retired, false);
    assert.equal(event.sourceUrl, MLB_URL);
  });

  it('flattens ESPN tennis groupings into per-competition events with the winner flag', () => {
    const { events } = settlement.normalizeResultData({
      provider: 'espn',
      sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
      events: [
        {
          id: 'tourney-9',
          groupings: [
            {
              competitions: [
                {
                  id: 'match-1',
                  date: '2026-08-05T14:00:00.000Z',
                  status: { type: { state: 'post', description: 'Final' } },
                  competitors: [
                    { homeAway: 'home', athlete: { displayName: 'Novak Djokovic' }, winner: true },
                    { homeAway: 'away', athlete: { displayName: 'Carlos Alcaraz' }, winner: false }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.eventId, 'match-1');
    assert.equal(event.homeTeam, 'Novak Djokovic');
    assert.equal(event.awayTeam, 'Carlos Alcaraz');
    assert.equal(event.winner, 'Novak Djokovic');
    assert.equal(event.status, 'final');
  });

  it('detects tennis retirements and the retired side', () => {
    const { events } = settlement.normalizeResultData({
      provider: 'espn',
      events: [
        {
          id: 'ret-1',
          date: '2026-08-05T16:00:00.000Z',
          status: { type: { state: 'post', description: 'Retired' } },
          competitions: [
            {
              id: 'ret-1',
              date: '2026-08-05T16:00:00.000Z',
              status: { type: { state: 'post', description: 'Retired' } },
              competitors: [
                { homeAway: 'home', athlete: { displayName: 'Novak Djokovic' } },
                { homeAway: 'away', athlete: { displayName: 'Carlos Alcaraz' }, status: 'retired' }
              ]
            }
          ]
        }
      ]
    });
    const event = events[0];
    assert.equal(event.status, 'retired');
    assert.equal(event.retired, true);
    assert.equal(event.retiredSide, 'Carlos Alcaraz');
    // A retired match must never be treated as a final score event.
    assert.notEqual(event.status, 'final');
  });

  it('accepts flat pre-normalized events and bare arrays', () => {
    const flat = settlement.normalizeResultData([
      {
        eventId: 'e1',
        homeTeam: 'A',
        awayTeam: 'B',
        homeScore: 2,
        awayScore: 1,
        status: 'final',
        date: '2026-08-05T20:00:00.000Z'
      }
    ]);
    assert.equal(flat.provider, null);
    assert.equal(flat.events.length, 1);
    assert.equal(flat.events[0].eventId, 'e1');
    assert.equal(settlement.normalizeResultData({ events: [] }).events.length, 0);
    assert.equal(settlement.normalizeResultData(null).events.length, 0);
  });
});

describe('matchEvent', () => {
  it('matches by stable game/event ID first', () => {
    const { events } = settlement.normalizeResultData(mlbResult());
    const match = settlement.matchEvent(mlbBet(), events);
    assert.equal(match.matched, true);
    assert.equal(match.method, 'gameId');
    assert.equal(match.event.eventId, '401234567');
  });

  it('falls back to an unambiguous name+date match only when the ID cannot match', () => {
    const { events } = settlement.normalizeResultData(mlbResult({ eventId: 'other-id' }));
    const match = settlement.matchEvent(mlbBet(), events);
    assert.equal(match.matched, true);
    assert.equal(match.method, 'name+date');
  });

  it('fallback requires BOTH team sides to match exactly (orientation-free)', () => {
    const { events } = settlement.normalizeResultData(
      mlbResult({
        eventId: 'x1',
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        date: '2026-08-05T23:05:00.000Z'
      })
    );
    // Bet strings list teams in either order — the pair is what matters.
    const match = settlement.matchEvent(mlbBet({ game: 'Red Sox @ NYY' }), events);
    assert.equal(match.matched, true);
    assert.equal(match.method, 'name+date');
    // One side different -> no match.
    const wrong = settlement.matchEvent(mlbBet({ game: 'Yankees @ Blue Jays' }), events);
    assert.equal(wrong.matched, false);
  });

  it('fallback requires a scheduled start and never matches a game that started BEFORE the schedule', () => {
    const { events } = settlement.normalizeResultData(mlbResult({ eventId: 'x1', date: '2026-08-04T23:05:00.000Z' }));
    const before = settlement.matchEvent(mlbBet({ gameId: null }), events);
    assert.equal(before.matched, false);
    const noStart = settlement.matchEvent(mlbBet({ gameId: null, start: null }), events);
    assert.equal(noStart.matched, false);
  });

  it('fallback is ambiguous (pending) when two events share the same team pair and date window', () => {
    const { events } = settlement.normalizeResultData({
      provider: 'espn',
      sourceUrl: MLB_URL,
      events: [
        {
          eventId: 'a1',
          homeTeam: 'New York Yankees',
          awayTeam: 'Boston Red Sox',
          homeScore: 5,
          awayScore: 3,
          status: 'final',
          date: '2026-08-05T23:05:00.000Z'
        },
        {
          eventId: 'a2',
          homeTeam: 'New York Yankees',
          awayTeam: 'Boston Red Sox',
          homeScore: 2,
          awayScore: 9,
          status: 'final',
          date: '2026-08-05T01:00:00.000Z'
        }
      ]
    });
    const match = settlement.matchEvent(mlbBet({ gameId: null }), events);
    assert.equal(match.matched, false);
    assert.match(match.reason, /ambiguous/);
  });

  it('matches delayed games within the date window (next UTC day, maxDelayDays default 1)', () => {
    const { events } = settlement.normalizeResultData(mlbResult({ eventId: 'x1', date: '2026-08-06T02:00:00.000Z' }));
    const match = settlement.matchEvent(mlbBet({ gameId: null }), events);
    assert.equal(match.matched, true);
    assert.equal(match.method, 'name+date');
    // Beyond the window -> no match.
    const tooLate = settlement.normalizeResultData(mlbResult({ eventId: 'x1', date: '2026-08-07T02:00:00.000Z' }));
    assert.equal(settlement.matchEvent(mlbBet({ gameId: null }), tooLate.events).matched, false);
  });
});

describe('settleEvent — MLB final score', () => {
  it('grades moneyline win/loss/push from final scores', () => {
    const { events } = settlement.normalizeResultData(mlbResult());
    const win = settlement.settleEvent(mlbBet(), events[0]);
    assert.deepEqual(win, {
      status: 'win',
      outcome: 'win',
      result: 'win',
      isSettled: true,
      reason: 'final score 5-3'
    });
    const loss = settlement.settleEvent(mlbBet({ selection: 'Red Sox' }), events[0]);
    assert.equal(loss.status, 'loss');
    const tied = settlement.settleEvent(mlbBet(), { ...events[0], homeScore: 3, awayScore: 3 });
    assert.equal(tied.status, 'push');
  });

  it('keeps non-final, scoreless, and ambiguous-selection events pending', () => {
    const { events } = settlement.normalizeResultData(mlbResult());
    const notFinal = settlement.settleEvent(mlbBet(), { ...events[0], status: 'scheduled' });
    assert.equal(notFinal.status, 'pending');
    assert.equal(notFinal.reasonCode, 'unresolved');
    const noScores = settlement.settleEvent(mlbBet(), { ...events[0], homeScore: null });
    assert.equal(noScores.status, 'pending');
    assert.equal(noScores.reasonCode, 'missing_final_score');
    const ambiguous = settlement.settleEvent(mlbBet({ selection: 'Yankees Red Sox' }), events[0]);
    assert.equal(ambiguous.status, 'pending');
    assert.equal(ambiguous.reasonCode, 'ambiguous_selection');
  });

  it('keeps spread markets pending (only moneyline and totals grade locally)', () => {
    const { events } = settlement.normalizeResultData(mlbResult());
    const spread = settlement.settleEvent(mlbBet({ market: 'Run Line', selection: 'Yankees -1.5' }), events[0]);
    assert.equal(spread.status, 'pending');
    assert.match(spread.reason, /moneyline/);
  });
});

describe('settleEvent — game totals (Over/Under)', () => {
  // Aug 4 acceptance case: Brewers 4-2 Pirates, Under 7.5 wins.
  const brewersPirates = {
    eventId: '401234567',
    homeTeam: 'Milwaukee Brewers',
    awayTeam: 'Pittsburgh Pirates',
    homeScore: 4,
    awayScore: 2,
    status: 'final',
    date: '2026-08-05T02:00:00.000Z'
  };

  function totalBet(overrides = {}) {
    return {
      id: 'bet-total-1',
      gameId: '401234567',
      game: 'Pirates @ Brewers',
      league: 'MLB',
      market: 'Total Runs',
      selection: 'Under',
      line: 7.5,
      odds: -110,
      stake: 50,
      start: '2026-08-04T23:40:00.000Z',
      ...overrides
    };
  }

  it('grades Under 7.5 as a win when the final total is below the line (Brewers 4-2 Pirates)', () => {
    const result = settlement.settleEvent(totalBet(), brewersPirates);
    assert.deepEqual(result, {
      status: 'win',
      outcome: 'win',
      result: 'win',
      isSettled: true,
      reason: 'final total 6 under 7.5'
    });
    // Selections that carry the line ('Under 7.5') resolve identically.
    const withLineInSelection = settlement.settleEvent(totalBet({ selection: 'Under 7.5' }), brewersPirates);
    assert.equal(withLineInSelection.status, 'win');
  });

  it('grades Over 7.5 as a loss on the same final (and Over wins when the total clears)', () => {
    const loss = settlement.settleEvent(totalBet({ selection: 'Over' }), brewersPirates);
    assert.equal(loss.status, 'loss');
    assert.equal(loss.reason, 'final total 6 over 7.5');
    const win = settlement.settleEvent(totalBet({ selection: 'Over' }), {
      ...brewersPirates,
      homeScore: 9,
      awayScore: 2
    });
    assert.equal(win.status, 'win');
  });

  it('pushes exactly at the line for both Over and Under', () => {
    const tied = { ...brewersPirates, homeScore: 4, awayScore: 3 };
    const over = settlement.settleEvent(totalBet({ selection: 'Over', line: 7 }), tied);
    assert.equal(over.status, 'push');
    const under = settlement.settleEvent(totalBet({ selection: 'Under', line: 7 }), tied);
    assert.equal(under.status, 'push');
    assert.match(under.reason, /pushed at line 7/);
  });

  it('keeps totals with a missing or invalid line pending (never guesses a line)', () => {
    const noLine = settlement.settleEvent(totalBet({ line: undefined }), brewersPirates);
    assert.equal(noLine.status, 'pending');
    assert.match(noLine.reason, /line/);
    const nullLine = settlement.settleEvent(totalBet({ line: null }), brewersPirates);
    assert.equal(nullLine.status, 'pending');
    const badLine = settlement.settleEvent(totalBet({ line: 'abc' }), brewersPirates);
    assert.equal(badLine.status, 'pending');
    assert.match(badLine.reason, /line/);
  });

  it('keeps totals pending when the selection does not identify Over or Under', () => {
    const teamSelection = settlement.settleEvent(totalBet({ selection: 'Brewers' }), brewersPirates);
    assert.equal(teamSelection.status, 'pending');
    assert.match(teamSelection.reason, /Over or Under/);
  });

  it('keeps totals pending when the event is not final or scores are missing', () => {
    const notFinal = settlement.settleEvent(totalBet(), { ...brewersPirates, status: 'in_progress' });
    assert.equal(notFinal.status, 'pending');
    const noScores = settlement.settleEvent(totalBet(), { ...brewersPirates, homeScore: null });
    assert.equal(noScores.status, 'pending');
  });

  it('accepts Over/Under and Total market names and the points line field', () => {
    const overUnder = settlement.settleEvent(
      totalBet({ market: 'Over/Under', selection: 'Under', points: 7.5 }),
      brewersPirates
    );
    assert.equal(overUnder.status, 'win');
    const total = settlement.settleEvent(totalBet({ market: 'Total', selection: 'Over 7.5' }), brewersPirates);
    assert.equal(total.status, 'loss');
    // A bare U token is an unambiguous Under.
    const bare = settlement.settleEvent(totalBet({ selection: 'U', market: 'Total' }), brewersPirates);
    assert.equal(bare.status, 'win');
  });

  it('never grades prop-style totals like Total Bases as a game total', () => {
    const prop = settlement.settleEvent(totalBet({ market: 'Total Bases' }), brewersPirates);
    assert.equal(prop.status, 'pending');
    assert.match(prop.reason, /not supported/);
  });

  it('does not use the line embedded in a team-style selection', () => {
    // 'Over' must come from the selection, never from a team name containing 'over'.
    const team = settlement.settleEvent(totalBet({ selection: 'Overmiller' }), brewersPirates);
    assert.equal(team.status, 'pending');
  });
});

describe('settleEvent — tennis', () => {
  function tennisEvent(overrides = {}) {
    return {
      eventId: 'match-1',
      homeTeam: 'Novak Djokovic',
      awayTeam: 'Carlos Alcaraz',
      homeScore: null,
      awayScore: null,
      status: 'final',
      winner: 'Novak Djokovic',
      retired: false,
      retiredSide: null,
      date: '2026-08-05T14:00:00.000Z',
      ...overrides
    };
  }
  function tennisBet(overrides = {}) {
    return {
      id: 'bet-t1',
      gameId: 'match-1',
      game: 'Djokovic N vs Alcaraz C',
      league: 'Tennis',
      market: 'Moneyline',
      selection: 'Djokovic N',
      odds: -120,
      start: '2026-08-05T12:00:00.000Z',
      ...overrides
    };
  }

  it('grades completed matches using the explicit winner', () => {
    const win = settlement.settleEvent(tennisBet(), tennisEvent());
    assert.equal(win.status, 'win');
    const loss = settlement.settleEvent(tennisBet({ selection: 'Alcaraz C' }), tennisEvent());
    assert.equal(loss.status, 'loss');
  });

  it('keeps completed-but-winnerless matches pending (never guesses)', () => {
    const noWinner = settlement.settleEvent(tennisBet(), tennisEvent({ winner: null }));
    assert.equal(noWinner.status, 'pending');
    assert.match(noWinner.reason, /winner/i);
  });

  it('keeps retirements as an explicit retirement status without a policy', () => {
    const retired = settlement.settleEvent(
      tennisBet(),
      tennisEvent({ status: 'retired', retired: true, retiredSide: 'Carlos Alcaraz' })
    );
    assert.equal(retired.status, 'retirement');
    assert.equal(retired.isSettled, false);
    assert.equal(retired.outcome, null);
    assert.match(retired.reason, /retirement/);
  });

  it('applies a caller-supplied retirement policy when the retired side is known', () => {
    const retiredEvent = tennisEvent({ status: 'retired', retired: true, retiredSide: 'Carlos Alcaraz' });
    // Bet side (Djokovic) did NOT retire -> opponent retirement -> inverted to win.
    const opponentRetired = settlement.settleEvent(tennisBet(), retiredEvent, { policy: { retirement: 'loss' } });
    assert.equal(opponentRetired.status, 'win');
    // Bet on the player who retired -> policy value applies directly.
    const betRetired = settlement.settleEvent(tennisBet({ selection: 'Alcaraz C' }), retiredEvent, {
      policy: { retirement: 'loss' }
    });
    assert.equal(betRetired.status, 'loss');
  });

  it('never applies a policy when the retired side is unknown', () => {
    const noSide = settlement.settleEvent(
      tennisBet(),
      tennisEvent({ status: 'retired', retired: true, retiredSide: null }),
      { policy: { retirement: 'loss' } }
    );
    assert.equal(noSide.status, 'retirement');
    assert.equal(noSide.isSettled, false);
  });

  it('supports a function policy for full caller control', () => {
    const retiredEvent = tennisEvent({ status: 'retired', retired: true, retiredSide: 'Carlos Alcaraz' });
    const policy = {
      retirement: (bet, event, betSideTeamName) => (betSideTeamName === 'Novak Djokovic' ? 'win' : 'loss')
    };
    const graded = settlement.settleEvent(tennisBet(), retiredEvent, { policy });
    assert.equal(graded.status, 'win');
    assert.equal(graded.isSettled, true);
  });
});

describe('solve — ledger integration', () => {
  const now = () => '2026-08-06T04:00:00.000Z';

  it('settles bets into the ledger with source URL, evidence, and both start dates', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [mlbBet({ odds: undefined, oddsAtDecision: -120 })],
      resultData: mlbResult(),
      now
    });
    assert.equal(result.ok, true);
    assert.equal(result.settled.length, 1);
    assert.equal(result.pending.length, 0);
    const record = result.settled[0];
    assert.equal(record.status, 'win');
    assert.equal(record.betId, 'bet-1');
    assert.equal(record.matchedBy, 'gameId');
    assert.equal(record.sourceUrl, MLB_URL);
    assert.equal(record.provider, 'espn');
    assert.equal(record.odds, -120);
    assert.equal(record.scheduledStart, '2026-08-05T18:00:00.000Z');
    assert.equal(record.actualStart, '2026-08-05T23:05:00.000Z');
    assert.equal(record.evidence.homeScore, 5);
    assert.equal(record.evidence.awayScore, 3);
    assert.equal(record.settledAt, '2026-08-06T04:00:00.000Z');
    assert.ok(record.id);
    assert.ok(record.createdAt);
    assert.equal(ledger.settlements.length, 1);
  });

  it('resolves the scheduled start from the candidate snapshot for card-promoted bets (direct library call)', () => {
    const ledger = ledgerModule.createLedger();
    // Card-promoted bets (lib/record-card) record the schedule ONLY inside
    // candidateSnapshot — there is no top-level start/scheduledStart.
    const cardBet = {
      id: 'bet-card-1',
      candidateId: 'cand-card-1',
      gameId: 'g-fabricated',
      game: 'Pirates @ Brewers',
      league: 'MLB',
      market: 'Total Runs',
      selection: 'Under 7.5',
      line: 7.5,
      candidateSnapshot: {
        candidateId: 'cand-card-1',
        gameId: 'g-fabricated',
        game: 'Pirates @ Brewers',
        league: 'MLB',
        market: 'Total Runs',
        selection: 'Under 7.5',
        start: '2026-08-04T23:40:00.000Z'
      }
    };
    const result = settlement.solve(ledger, { bets: [cardBet], resultData: brewersPiratesResult(), now });
    assert.equal(result.settled.length, 1, 'card-promoted bet must settle by game id using the snapshot start');
    assert.equal(result.settled[0].status, 'win');
    assert.equal(result.settled[0].matchedBy, 'gameId');
    assert.equal(result.settled[0].scheduledStart, '2026-08-04T23:40:00.000Z');
  });

  it('preserves scheduled vs actual start dates for a delayed game', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [mlbBet({ gameId: null })],
      resultData: mlbResult({ eventId: 'x1', date: '2026-08-06T02:10:00.000Z' }),
      now
    });
    const record = result.settled[0];
    assert.equal(record.matchedBy, 'name+date');
    assert.equal(record.scheduledStart, '2026-08-05T18:00:00.000Z');
    assert.equal(record.actualStart, '2026-08-06T02:10:00.000Z');
    assert.notEqual(record.scheduledStart, record.actualStart);
  });

  it('keeps unknown and ambiguous bets pending without a settlement guess', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [
        mlbBet({ id: 'b-unknown', gameId: null, start: null }),
        mlbBet({ id: 'b-ambig', gameId: null }),
        mlbBet({ id: 'b-market', market: 'Total' })
      ],
      resultData: {
        provider: 'espn',
        sourceUrl: MLB_URL,
        events: [
          {
            eventId: 'a1',
            homeTeam: 'New York Yankees',
            awayTeam: 'Boston Red Sox',
            homeScore: 5,
            awayScore: 3,
            status: 'final',
            date: '2026-08-05T23:05:00.000Z'
          },
          {
            eventId: 'a2',
            homeTeam: 'New York Yankees',
            awayTeam: 'Boston Red Sox',
            homeScore: 2,
            awayScore: 9,
            status: 'final',
            date: '2026-08-05T01:00:00.000Z'
          }
        ]
      },
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 3);
    assert.equal(ledger.settlements.length, 3);
    for (const record of result.pending) {
      assert.equal(record.status, 'pending');
      assert.equal(record.isSettled, false);
    }
  });

  it('keeps one settlement per bet: skips settled bets, replaces on force', () => {
    const ledger = ledgerModule.createLedger();
    const first = settlement.solve(ledger, { bets: [mlbBet()], resultData: mlbResult(), now });
    assert.equal(first.settled.length, 1);
    const second = settlement.solve(ledger, { bets: [mlbBet()], resultData: mlbResult(), now });
    assert.equal(second.skipped.length, 1);
    assert.equal(second.settled.length, 0);
    assert.equal(ledger.settlements.length, 1);
    const forced = settlement.solve(ledger, {
      bets: [mlbBet({ selection: 'Red Sox' })],
      resultData: mlbResult(),
      now,
      force: true
    });
    assert.equal(forced.settled.length, 1);
    assert.equal(forced.settled[0].status, 'loss');
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].betId, 'bet-1');
  });

  it('records tennis retirement settlements as explicit retirement status', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [
        {
          id: 't-ret',
          gameId: 'ret-1',
          game: 'Djokovic N vs Alcaraz C',
          league: 'Tennis',
          market: 'Moneyline',
          selection: 'Djokovic N',
          start: '2026-08-05T12:00:00.000Z'
        }
      ],
      resultData: {
        provider: 'espn',
        sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
        events: [
          {
            eventId: 'ret-1',
            homeTeam: 'Novak Djokovic',
            awayTeam: 'Carlos Alcaraz',
            status: 'retired',
            retired: true,
            retiredSide: 'Carlos Alcaraz',
            date: '2026-08-05T14:00:00.000Z'
          }
        ]
      },
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 1);
    const record = result.pending[0];
    assert.equal(record.status, 'retirement');
    assert.equal(record.isSettled, false);
    assert.equal(record.result, null);
    assert.equal(record.evidence.retired, true);
    assert.equal(record.evidence.retiredSide, 'Carlos Alcaraz');
  });

  it('preserves retirement evidence when a later rerun cannot match the event', () => {
    const ledger = ledgerModule.createLedger();
    const bet = {
      id: 't-ret-rerun',
      gameId: 'ret-rerun',
      game: 'Djokovic N vs Alcaraz C',
      league: 'Tennis',
      market: 'Moneyline',
      selection: 'Djokovic N',
      start: '2026-08-05T12:00:00.000Z'
    };
    const retirement = settlement.solve(ledger, {
      bets: [bet],
      resultData: {
        provider: 'espn',
        sourceUrl: 'https://example.test/tennis',
        events: [
          {
            eventId: 'ret-rerun',
            homeTeam: 'Novak Djokovic',
            awayTeam: 'Carlos Alcaraz',
            status: 'retired',
            retired: true,
            retiredSide: 'Carlos Alcaraz',
            date: '2026-08-05T14:00:00.000Z'
          }
        ]
      },
      now
    });
    assert.equal(retirement.pending[0].status, 'retirement');
    const rerun = settlement.solve(ledger, {
      bets: [bet],
      resultData: { provider: 'espn', sourceUrl: 'https://example.test/tennis', events: [] },
      now
    });
    assert.equal(rerun.pending.length, 1);
    assert.equal(rerun.pending[0].status, 'retirement');
    assert.equal(rerun.pending[0].evidence.retiredSide, 'Carlos Alcaraz');
  });
});

describe('betStart — card-shaped start resolution', () => {
  it('resolves bet.start first, then scheduledStart, then candidate snapshot start/startTimestamp', () => {
    assert.equal(
      settlement.betStart({ start: '2026-08-01T00:00:00.000Z', scheduledStart: '2026-08-02T00:00:00.000Z' }),
      '2026-08-01T00:00:00.000Z'
    );
    assert.equal(settlement.betStart({ scheduledStart: '2026-08-02T00:00:00.000Z' }), '2026-08-02T00:00:00.000Z');
    assert.equal(
      settlement.betStart({ candidateSnapshot: { start: '2026-08-03T00:00:00.000Z' } }),
      '2026-08-03T00:00:00.000Z'
    );
    assert.equal(
      settlement.betStart({ candidateSnapshot: { startTimestamp: '2026-08-04T00:00:00.000Z' } }),
      '2026-08-04T00:00:00.000Z'
    );
    assert.equal(
      settlement.betStart({
        candidateSnapshot: { start: '2026-08-03T00:00:00.000Z', startTimestamp: '2026-08-04T00:00:00.000Z' }
      }),
      '2026-08-03T00:00:00.000Z',
      'snapshot.start wins over snapshot.startTimestamp'
    );
    assert.equal(settlement.betStart({}), null);
    assert.equal(settlement.betStart(null), null);
  });
});

describe('dateInWindow — UTC-day-granular behavior', () => {
  it('accepts an actual start on the same UTC day even when its clock time is earlier than scheduled', () => {
    // Scheduled late-night UTC; actual start ~24h earlier but still Aug 5 UTC.
    const bet = mlbBet({ start: '2026-08-05T23:59:00.000Z' });
    const { events } = settlement.normalizeResultData(mlbResult({ date: '2026-08-05T00:01:00.000Z' }));
    const match = settlement.matchEvent(bet, events);
    assert.equal(match.matched, true, 'same UTC calendar day is in window regardless of clock time');
    assert.equal(match.method, 'gameId');
  });

  it('rejects an actual start on a later UTC day beyond the max-delay window', () => {
    const bet = mlbBet({ start: '2026-08-05T12:00:00.000Z' });
    const { events } = settlement.normalizeResultData(mlbResult({ date: '2026-08-07T11:00:00.000Z' }));
    assert.equal(settlement.matchEvent(bet, events).matched, false);
  });
});

describe('solveLedger — atomic persistence via record-ledger', () => {
  const now = () => '2026-08-06T04:00:00.000Z';

  it('round-trips through load/save with the injected filesystem and an atomic rename', () => {
    const fs = createFakeFs();
    const filePath = '/virtual/tracker/ledger.json';
    const result = settlement.solveLedger({
      fs,
      path: filePath,
      bets: [mlbBet()],
      resultData: mlbResult(),
      now
    });
    assert.equal(result.ok, true);
    assert.equal(result.path, filePath);
    assert.equal(result.settled.length, 1);
    assert.equal(
      fs.operations.some(([operation]) => operation === 'rename'),
      true
    );
    assert.equal(
      fs.operations.some(([operation]) => operation === 'fsync'),
      true
    );

    const loaded = ledgerModule.loadLedger({ fs, path: filePath });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ledger.settlements.length, 1);
    assert.equal(loaded.ledger.settlements[0].status, 'win');
    assert.equal(loaded.ledger.settlements[0].sourceUrl, MLB_URL);
  });

  it('returns the ledger error when the file cannot be read', () => {
    const fs = createFakeFs();
    fs.readFileSync = () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    const bad = settlement.solveLedger({ fs, path: '/virtual/bad.json', resultData: mlbResult() });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Unable to read ledger/);
  });
});

// Audit remediation (2026-08-05): a unique game/event ID is necessary but
// never sufficient by itself — same-ID events must also match the bet's
// participant pair and fall inside the scheduled date window. Settlements
// additionally require non-empty top-level provider/sourceUrl provenance.

describe('matchEvent — identity checks on same-ID matches', () => {
  it('keeps a same-ID event with the wrong participants pending', () => {
    const { events } = settlement.normalizeResultData(
      brewersPiratesResult({
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeScore: 5,
        awayScore: 3
      })
    );
    const match = settlement.matchEvent(brewersPiratesBet(), events);
    assert.equal(match.matched, false);
    assert.match(match.reason, /participants/);
  });

  it('keeps a same-ID same-matchup event outside the date window pending', () => {
    const { events } = settlement.normalizeResultData(brewersPiratesResult({ date: '2026-08-09T02:00:00.000Z' }));
    const match = settlement.matchEvent(brewersPiratesBet(), events);
    assert.equal(match.matched, false);
    assert.match(match.reason, /date window/);
  });

  it('still settles a same-ID event with matching participants and date by ID', () => {
    const { events } = settlement.normalizeResultData(brewersPiratesResult());
    const match = settlement.matchEvent(brewersPiratesBet(), events);
    assert.equal(match.matched, true);
    assert.equal(match.method, 'gameId');
  });
});

describe('solve — same-ID regressions and provenance gate', () => {
  const now = () => '2026-08-06T04:00:00.000Z';

  it('keeps a Brewers/Pirates Under 7.5 bet pending when a same-ID Yankees/Red Sox result is supplied', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult({
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeScore: 5,
        awayScore: 3
      }),
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].status, 'pending');
    assert.notEqual(result.pending[0].status, 'win');
    assert.notEqual(result.pending[0].status, 'loss');
    assert.match(result.pending[0].reason, /participants/);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].status, 'pending');
  });

  it('keeps a same-ID same-matchup bet pending when the event is outside the date window', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult({ date: '2026-08-09T02:00:00.000Z' }),
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 1);
    assert.match(result.pending[0].reason, /date window/);
  });

  it('settles the same-ID in-window matching Brewers/Pirates total by game id (control)', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult(),
      now
    });
    assert.equal(result.settled.length, 1);
    assert.equal(result.settled[0].status, 'win');
    assert.equal(result.settled[0].matchedBy, 'gameId');
  });

  it('skips a bet with no id and never accumulates settlement rows', () => {
    const ledger = ledgerModule.createLedger();
    ledger.bets = [brewersPiratesBet({ id: null, status: 'pending' })];
    const result = settlement.solve(ledger, { resultData: brewersPiratesResult(), now });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].betId, null);
    assert.match(result.skipped[0].reason, /no id/);
    assert.equal(ledger.settlements.length, 0, 'no settlement row is created for an id-less bet');
    assert.equal(ledger.bets[0].status, 'pending', 'the bet row itself is left untouched/pending');

    const repeated = settlement.solve(ledger, { resultData: brewersPiratesResult(), now });
    assert.equal(repeated.skipped.length, 1);
    assert.equal(ledger.settlements.length, 0, 'repeated runs never accumulate rows');
  });

  it('never settles from a bare result array (no provenance)', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult().events,
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 1);
    assert.match(result.pending[0].reason, /provenance/);
    assert.equal(ledger.settlements[0].status, 'pending');
  });

  it('never settles from { events: [...] } without top-level provider/sourceUrl', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: { events: brewersPiratesResult().events },
      now
    });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 1);
    assert.match(result.pending[0].reason, /provenance/);
    // The precise reason names both missing fields.
    assert.match(result.pending[0].reason, /provider/);
    assert.match(result.pending[0].reason, /sourceUrl/);
  });

  it('settles with non-empty top-level provider and sourceUrl provenance (control)', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult(),
      now
    });
    assert.equal(result.settled[0].status, 'win');
    assert.equal(result.settled[0].provider, 'espn');
    assert.equal(result.settled[0].sourceUrl, MLB_URL);
  });

  it('keeps an already-settled bet untouched when provenance is missing on a later run', () => {
    const ledger = ledgerModule.createLedger();
    const first = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: brewersPiratesResult(),
      now
    });
    assert.equal(first.settled.length, 1);
    const second = settlement.solve(ledger, {
      bets: [brewersPiratesBet()],
      resultData: { events: brewersPiratesResult().events },
      now
    });
    assert.equal(second.skipped.length, 1, 'already settled is skipped, not clobbered');
    assert.equal(second.settled.length, 0);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].status, 'win');
  });

  it('keeps duplicate same-ID events pending instead of choosing one', () => {
    const bet = brewersPiratesBet();
    const result = settlement.matchEvent(bet, [
      ...brewersPiratesResult().events,
      {
        eventId: 'g-fabricated',
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeScore: 5,
        awayScore: 3,
        status: 'final',
        date: '2026-08-05T02:00:00.000Z'
      }
    ]);
    assert.equal(result.matched, false);
    assert.match(result.reason, /multiple events share the same game id/);
  });

  it('does not resolve a selection that matches both event sides', () => {
    const bet = mlbBet({ selection: 'New York' });
    const event = {
      eventId: 'g-ambiguous',
      homeTeam: 'New York Yankees',
      awayTeam: 'New York Mets',
      homeScore: 3,
      awayScore: 2,
      status: 'final',
      date: '2026-08-05T23:05:00.000Z'
    };
    const result = settlement.settleEvent(bet, event);
    assert.equal(result.status, 'pending');
    assert.match(result.reason, /unambiguously identify/);
  });
});

describe('solve — never downgrades a decided bet to pending', () => {
  const now = () => '2026-08-06T04:00:00.000Z';
  // The migrated shape: the outcome lives on the bet, and the start is
  // unresolvable so no name+date match can ever succeed.
  const decidedLegacyBet = () =>
    mlbBet({
      id: 'bet-legacy',
      status: 'win',
      plUnits: 0.77,
      gameId: undefined,
      start: undefined,
      game: 'Nobody vs Unknown'
    });

  it('skips rather than writing a pending settlement over a decided bet', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, { bets: [decidedLegacyBet()], resultData: mlbResult(), now });
    assert.equal(result.settled.length, 0);
    assert.equal(result.pending.length, 0, 'no pending row may be written over a decided bet');
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /already records a decided outcome/);
    assert.equal((ledger.settlements || []).length, 0, 'the ledger must be left untouched');
  });

  it('still writes a pending row when the bet has no decided outcome', () => {
    const ledger = ledgerModule.createLedger();
    const bet = mlbBet({
      id: 'bet-open',
      status: 'pending',
      gameId: undefined,
      start: undefined,
      game: 'Nobody vs Unknown'
    });
    const result = settlement.solve(ledger, { bets: [bet], resultData: mlbResult(), now });
    assert.equal(result.pending.length, 1);
  });

  it('--force still overrides the guard', () => {
    const ledger = ledgerModule.createLedger();
    const result = settlement.solve(ledger, { bets: [decidedLegacyBet()], resultData: mlbResult(), now, force: true });
    assert.equal(result.skipped.length, 0);
    assert.equal(result.pending.length, 1);
  });
});
