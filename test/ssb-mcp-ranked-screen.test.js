'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRankedScreenResponse,
  buildDegradedDataWarnings,
  getIncludeAll,
  getLimit,
  getLookbackHours,
  getRecentWindowHours,
  getMaxAgeMs,
  normalizeBookList,
  getDebugFlag,
  getPreHistoryShortlistGameBudget,
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS
} = require('../lib/ssb-mcp-ranked-screen');
const { rankScreenRows } = require('../lib/screen-ranker');

describe('pre-history shortlist budget', () => {
  it('honors explicit aggregate budgets above the legacy 60-game ceiling', () => {
    assert.equal(getPreHistoryShortlistGameBudget({ preHistoryGameBudget: 300 }), 300);
    assert.equal(getPreHistoryShortlistGameBudget({ preHistoryGameBudget: 700 }), 700);
  });
});

describe('normalizeBookList', () => {
  it('deduplicates book names', () => {
    const result = normalizeBookList(['DraftKings', 'FanDuel', 'DraftKings']);
    assert.deepEqual(result, ['DraftKings', 'FanDuel']);
  });

  it('trims whitespace from each entry', () => {
    const result = normalizeBookList(['  DK  ', ' FD ']);
    assert.deepEqual(result, ['DK', 'FD']);
  });

  it('filters out empty strings', () => {
    const result = normalizeBookList(['DK', '', '  ', 'FD']);
    assert.deepEqual(result, ['DK', 'FD']);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(normalizeBookList(null), []);
    assert.deepEqual(normalizeBookList(undefined), []);
    assert.deepEqual(normalizeBookList('DK'), []);
    assert.deepEqual(normalizeBookList(42), []);
  });

  it('coerces non-string entries to strings', () => {
    const result = normalizeBookList([123, true, 'DK']);
    assert.deepEqual(result, ['123', 'true', 'DK']);
  });
});

describe('getLimit', () => {
  it('returns explicit limit when valid', () => {
    assert.equal(getLimit({ limit: 25 }), 25);
    assert.equal(getLimit({ limit: '5' }), 5);
    assert.equal(getLimit({ limit: 1 }), 1);
  });

  it('returns 100 default for invalid or missing limit', () => {
    assert.equal(getLimit({}), 100);
    assert.equal(getLimit({ limit: -1 }), 100);
    assert.equal(getLimit({ limit: 0 }), 100);
    assert.equal(getLimit({ limit: 'abc' }), 100);
    assert.equal(getLimit({ limit: NaN }), 100);
    assert.equal(getLimit({ limit: Infinity }), 100);
  });
});

describe('getIncludeAll', () => {
  it('returns true by default', () => {
    assert.equal(getIncludeAll({}), true);
    assert.equal(getIncludeAll(), true);
  });

  it('respects explicit false', () => {
    assert.equal(getIncludeAll({ includeAll: false }), false);
  });

  it('respects explicit true', () => {
    assert.equal(getIncludeAll({ includeAll: true }), true);
  });

  it('coerces truthy/falsy values', () => {
    assert.equal(getIncludeAll({ includeAll: 0 }), false);
    assert.equal(getIncludeAll({ includeAll: 1 }), true);
  });
});

describe('getMaxAgeMs', () => {
  it('returns value when valid', () => {
    assert.equal(getMaxAgeMs({ maxAgeMs: 60000 }), 60000);
    assert.equal(getMaxAgeMs({ maxAgeMs: 0 }), 0);
    assert.equal(getMaxAgeMs({ maxAgeMs: '30000' }), 30000);
  });

  it('returns undefined for invalid or missing', () => {
    assert.equal(getMaxAgeMs({}), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: -1 }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: 'abc' }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: NaN }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: Infinity }), undefined);
  });
});

describe('getLookbackHours', () => {
  it('returns explicit hours when valid', () => {
    assert.equal(getLookbackHours({ lookbackHours: 12 }), 12);
    assert.equal(getLookbackHours({ lookbackHours: '4' }), 4);
  });

  it('falls back to default when invalid or missing', () => {
    assert.equal(getLookbackHours({}), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: 0 }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: -1 }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: 'abc' }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
  });
});

describe('getRecentWindowHours', () => {
  it('returns explicit recentWindowHours when valid', () => {
    assert.equal(getRecentWindowHours({ recentWindowHours: 3, lookbackHours: 6 }), 3);
    assert.equal(getRecentWindowHours({ recentWindowHours: '1', lookbackHours: 6 }), 1);
  });

  it('falls back to lookbackHours when recentWindowHours is missing or invalid', () => {
    assert.equal(getRecentWindowHours({ lookbackHours: 4 }), 4);
    assert.equal(getRecentWindowHours({ recentWindowHours: 0, lookbackHours: 5 }), 5);
    assert.equal(getRecentWindowHours({ recentWindowHours: 'abc', lookbackHours: 2 }), 2);
  });
});

describe('getDebugFlag', () => {
  it('returns defaultValue for undefined/null', () => {
    assert.equal(getDebugFlag(undefined, true), true);
    assert.equal(getDebugFlag(undefined, false), false);
    assert.equal(getDebugFlag(null, true), true);
  });

  it('returns booleans as-is', () => {
    assert.equal(getDebugFlag(true), true);
    assert.equal(getDebugFlag(false), false);
  });

  it('treats non-zero numbers as true, zero as false', () => {
    assert.equal(getDebugFlag(1), true);
    assert.equal(getDebugFlag(42), true);
    assert.equal(getDebugFlag(0), false);
  });

  it('handles string true/false/on/off/yes/no', () => {
    assert.equal(getDebugFlag('true'), true);
    assert.equal(getDebugFlag('false'), false);
    assert.equal(getDebugFlag('on'), true);
    assert.equal(getDebugFlag('off'), false);
    assert.equal(getDebugFlag('yes'), true);
    assert.equal(getDebugFlag('no'), false);
  });

  it('handles case-insensitive and whitespace-padded strings', () => {
    assert.equal(getDebugFlag('  TRUE  '), true);
    assert.equal(getDebugFlag('Off'), false);
    assert.equal(getDebugFlag('  YES '), true);
  });

  it('returns defaultValue for unrecognized strings', () => {
    assert.equal(getDebugFlag('maybe', false), false);
    assert.equal(getDebugFlag('maybe', true), true);
  });

  it('returns defaultValue for empty string', () => {
    assert.equal(getDebugFlag('', true), true);
    assert.equal(getDebugFlag('   ', false), false);
  });

  it('defaults defaultValue to true', () => {
    assert.equal(getDebugFlag(undefined), true);
  });
});

describe('DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS', () => {
  it('is 6', () => {
    assert.equal(DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS, 6);
  });
});

describe('rankScreenRows nested focus-book coverage', () => {
  it('uses nested focus-book odds without reporting a coverage gap', () => {
    const { rankScreenRows } = require('../lib/screen-ranker');
    const rows = rankScreenRows(
      [
        {
          gameId: 'tennis-game',
          league: 'Tennis',
          market: 'Total Games',
          selection: 'Over',
          selectionId: 'Total Games:Over_22.5',
          line: 22.5,
          book: 'Pinnacle',
          selections: {
            total: {
              selection1: 'Over',
              selection2: 'Under',
              selection1Id: 'Total Games:Over_22.5',
              selection2Id: 'Total Games:Under_22.5',
              line1: 22.5,
              line2: 22.5,
              odds: {
                OnyxOdds: { odds1: 120, odds2: -140 },
                Pinnacle: { odds1: 110, odds2: -130 }
              }
            }
          }
        }
      ],
      {
        preferredBooks: ['OnyxOdds', 'Pinnacle'],
        focusBook: 'OnyxOdds',
        requirePreferredBook: true,
        includeAll: true,
        debug: false
      }
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].book, 'OnyxOdds');
    assert.deepEqual(rows.coverageGaps, []);
    assert.equal(rows.focusBookMissingRows, undefined);
  });
});

describe('buildRankedScreenResponse', () => {
  it('builds a ranked response with correct shape', async () => {
    const stubClient = { getOddsHistory: async () => [] };
    const payload = {
      rows: [
        {
          playerId: 'p1',
          playerName: 'Player One',
          statType: 'points',
          line: 20.5,
          overOdds: -110,
          underOdds: -110,
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows) => rows;

    const result = await buildRankedScreenResponse({
      client: stubClient,
      payloads: [payload],
      args: { debug: false, lookbackHours: 2 },
      rankRows
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    assert.ok(result.freshness);
    assert.ok(result.resultMeta);
    assert.equal(result.resultMeta.lookbackHoursUsed, 2);
    assert.equal(result.resultMeta.debugEnabled, false);
  });

  it('keeps execution and SharpOdds comparison books separate', async () => {
    const seen = [];
    const provider = {
      resolve: async (_row, options) => {
        seen.push(options);
        return {
          lineHistoryAvailable: false,
          historyProvider: 'sharpodds',
          historyReason: 'history_unusable',
          historyWarning: 'test fixture'
        };
      }
    };
    const client = { queryOddsHistory: async () => ({}) };
    const result = await buildRankedScreenResponse({
      client,
      payloads: [
        {
          rows: [
            {
              gameId: 'game-1',
              homeTeam: 'Celtics',
              awayTeam: 'Lakers',
              league: 'NBA',
              market: 'Moneyline',
              selection1: 'Celtics',
              selection1Id: 'Moneyline:Celtics',
              selection2: 'Lakers',
              selection2Id: 'Moneyline:Lakers',
              start: '2026-09-01T19:05:00Z',
              odds: {
                Fliff: { odds1: -110, odds2: 100 },
                Pinnacle: { odds1: -112, odds2: 102 }
              }
            }
          ]
        }
      ],
      args: {
        enableSharpOddsHistory: true,
        books: ['Fliff'],
        historySportsbooks: ['Fliff', 'Pinnacle'],
        sharpOddsBooks: ['Pinnacle']
      },
      focusBook: 'Fliff',
      sharpOddsProvider: provider,
      rankRows: (rows) => rows
    });

    assert.equal(result.ok, true);
    assert.ok(seen.length > 0, 'SharpOdds provider should be called');
    assert.deepEqual(seen[0].sharpBooks, ['Pinnacle']);
  });

  it('enriches soccer rows with verified schedule venue order before ranking', async () => {
    let fetchCalls = 0;
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [
        {
          rows: [
            {
              gameId: 'serie-a-lazio-udinese',
              league: 'Soccer',
              leagueName: 'Serie A',
              start: '2026-09-07T18:45:00.000Z',
              homeTeam: 'Lazio',
              awayTeam: 'Udinese',
              selection1: 'Lazio',
              selection2: 'Udinese',
              odds: {
                NoVigApp: { odds1: -110, odds2: 100 }
              }
            }
          ]
        }
      ],
      args: { skipHistory: true, debug: false },
      soccerFetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          async json() {
            return {
              events: [
                {
                  date: '2026-09-07T18:45:00Z',
                  competitions: [
                    {
                      competitors: [
                        { homeAway: 'home', team: { displayName: 'Udinese' } },
                        { homeAway: 'away', team: { displayName: 'Lazio' } }
                      ],
                      venue: { fullName: 'Bluenergy Stadium' }
                    }
                  ]
                }
              ]
            };
          }
        };
      },
      rankRows: (rows) => rows
    });

    assert.equal(fetchCalls, 1);
    assert.equal(result.ok, true);
    assert.ok(result.result.length >= 1);
    assert.ok(result.result.every((row) => row.venueOrderVerified === true));
    assert.ok(result.result.every((row) => row.homeTeam === 'Udinese' && row.awayTeam === 'Lazio'));
    assert.ok(result.result.every((row) => row.game === 'Lazio @ Udinese'));
  });

  it('keeps unresolved soccer rows explicitly unverified when schedule identity is absent', async () => {
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [
        {
          rows: [
            {
              gameId: 'generic-soccer-match',
              league: 'Soccer',
              start: '2026-09-07T18:45:00.000Z',
              homeTeam: 'Lazio',
              awayTeam: 'Udinese',
              selection1: 'Lazio',
              selection2: 'Udinese',
              odds: { NoVigApp: { odds1: -110, odds2: 100 } }
            }
          ]
        }
      ],
      args: { skipHistory: true, debug: false },
      soccerFetchImpl: async () => {
        throw new Error('generic Soccer rows must not call a competition-scoped schedule');
      },
      rankRows: (rows) => rows
    });

    assert.equal(result.ok, true);
    assert.ok(result.result.length >= 1);
    assert.ok(result.result.every((row) => row.venueOrderVerified !== true));
    assert.ok(result.result.every((row) => String(row.game).includes('(home/away unverified)')));
  });

  it('keeps rationale in sync with the recomputed movementDisposition (yellow→green grade upgrade)', async () => {
    // Regression: the ranker builds `rationale` from the rank-time
    // movementDisposition, which is computed from the RAW movementGrade
    // (buildRankedIntermediateRow). buildRankedScreenResponse then
    // recomputes movementDisposition from the expanded row, whose
    // movementGrade was re-derived by gradeMovementQuality — which upgrades
    // yellow→green here (steam-exempt: 4 books + positive CLV + best exec).
    // Without the fix the rationale still said supportive_bouncy while the
    // structured field said supportive_clean — a direct contradiction.
    const nowMs = Date.now();
    const payload = {
      rows: [
        {
          league: 'MLB',
          market: 'Moneyline',
          book: 'NoVigApp',
          participant: 'Cubs',
          selection: 'Cubs',
          movementGrade: 'yellow',
          selections: {
            null: {
              selection1: 'Cubs',
              participant1: 'Cubs',
              selectionType1: 'team',
              selection1Id: 'mlb-cubs',
              selection2: 'Cardinals',
              participant2: 'Cardinals',
              selectionType2: 'team',
              selection2Id: 'mlb-cardinals',
              line1: null,
              line2: null,
              odds: {
                NoVigApp: { odds1: -110, odds2: 100 },
                Pinnacle: { odds1: -115, odds2: 105 },
                Circa: { odds1: -112, odds2: 104 },
                DraftKings: { odds1: -114, odds2: 106 },
                BetMGM: { odds1: -113, odds2: 103 }
              }
            }
          },
          lineHistory: [
            { book: 'NoVigApp', odds: -95, time: nowMs - 4 * 60 * 60 * 1000 },
            { book: 'NoVigApp', odds: -100, time: nowMs - 2 * 60 * 60 * 1000 },
            { book: 'NoVigApp', odds: -105, time: nowMs - 2 * 60 * 1000 },
            { book: 'Pinnacle', odds: -100, time: nowMs - 4 * 60 * 60 * 1000 },
            { book: 'Pinnacle', odds: -110, time: nowMs - 2 * 60 * 60 * 1000 },
            { book: 'Pinnacle', odds: -115, time: nowMs - 2 * 60 * 1000 }
          ]
        }
      ]
    };
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { skipHistory: true, debug: false, limit: 5 },
      rankRows: (hydratedRows, { debug } = {}) => rankScreenRows(hydratedRows, { limit: 5, includeAll: true, debug })
    });

    assert.equal(result.ok, true);
    const cubs = result.result.find((row) => String(row.selection || row.participant || '').includes('Cubs'));
    assert.ok(cubs, 'Cubs row should be present in the ranked result');
    // The scenario: raw yellow grade upgrades to green via gradeMovementQuality.
    assert.equal(cubs.movementGrade, 'green');
    assert.equal(cubs.movementDisposition, 'supportive_clean');
    // The stale-rationale regression: the human-readable text must agree
    // with the structured field.
    assert.ok(
      !String(cubs.rationale).includes('supportive_bouncy'),
      `rationale must not keep the stale rank-time disposition: ${cubs.rationale}`
    );
    assert.ok(
      String(cubs.rationale).includes('supportive_clean'),
      `rationale must reflect the recomputed disposition: ${cubs.rationale}`
    );
    // Invariant across every row in the response: any disposition token in a
    // rationale must match the row's structured movementDisposition.
    for (const row of result.result) {
      const match = /supportive_(clean|bouncy)|adverse_(recent|full)/.exec(String(row.rationale || ''));
      if (match) {
        assert.equal(
          match[0],
          row.movementDisposition,
          `rationale contradicts movementDisposition for ${row.selection || row.participant || row.playId}: ${row.rationale}`
        );
      }
    }
  });

  it('filters wrong-day scheduled rows for today scans before ranking', async () => {
    const payload = {
      rows: [
        {
          gameId: 'yesterday',
          league: 'NBA',
          market: 'Moneyline',
          start: '2026-07-12T23:00:00.000Z',
          book: 'NoVigApp'
        },
        { gameId: 'today', league: 'NBA', market: 'Moneyline', start: '2026-07-13T23:00:00.000Z', book: 'NoVigApp' }
      ]
    };
    const rankRows = (rows) => rows;
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { cardWindow: 'today', nowMs: Date.parse('2026-07-13T15:00:00.000Z') },
      rankRows
    });
    assert.deepEqual(
      result.result.map((row) => row.gameId),
      ['today']
    );
  });

  it('passes recentWindowHours through to rankRows when explicitly requested', async () => {
    const payload = {
      rows: [
        {
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows, options = {}) => [
      { rowCount: rows.length, recentWindowHours: options.recentWindowHours ?? null }
    ];

    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: true, lookbackHours: 6, recentWindowHours: 3 },
      rankRows
    });

    assert.equal(result.result[0].rowCount, 1);
    assert.equal(result.result[0].recentWindowHours, 3);
  });

  it('defaults recentWindowHours to lookbackHours when not explicitly provided', async () => {
    const payload = {
      rows: [
        {
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows, options = {}) => [
      { rowCount: rows.length, recentWindowHours: options.recentWindowHours ?? null }
    ];

    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: false, lookbackHours: 1 },
      rankRows
    });

    assert.equal(result.result[0].rowCount, 1);
    assert.equal(result.result[0].recentWindowHours, 1);
  });

  it('surfaces coverageGaps from the ranker in resultMeta (P0: focus-book coverage gap)', async () => {
    // When the ranker reports that the focus book has no price for a match,
    // buildRankedScreenResponse must propagate that into resultMeta.coverageGaps
    // so callers can see "you asked for NoVigApp but the screen endpoint
    // didn't return it for 3 of 12 matches" without losing the surviving rows.
    const payload = {
      rows: [
        {
          book: 'Pinnacle',
          homeTeam: 'Lakers',
          awayTeam: 'Warriors',
          market: 'Moneyline',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const fakeGap = {
      preferredBook: 'NoVigApp',
      availableBooks: ['Pinnacle', 'FanDuel'],
      matchup: 'Warriors vs Lakers',
      market: 'moneyline',
      reason: 'no_price_fallback',
      focusBookMissingReason: 'no price for NoVigApp'
    };
    const rankRows = (rows) => {
      const result = rows.map((r) => ({ ...r, book: 'Pinnacle', focusBookMissing: true }));
      Object.defineProperty(result, 'coverageGaps', { value: [fakeGap], enumerable: false });
      return result;
    };
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: false, lookbackHours: 6 },
      rankRows,
      focusBook: 'NoVigApp'
    });
    assert.ok(Array.isArray(result.resultMeta.coverageGaps));
    assert.equal(result.resultMeta.coverageGaps.length, 1);
    assert.equal(result.resultMeta.coverageGaps[0].preferredBook, 'NoVigApp');
    assert.equal(result.resultMeta.coverageGaps[0].reason, 'no_price_fallback');
    // Focus-book coverage gap should also show up in degradedDataWarningCount or
    // similar surfaced count — at minimum, the gap info is reachable via resultMeta.
    assert.equal(result.resultMeta.focusBook, 'NoVigApp');
    assert.equal(result.resultMeta.targetBookCoverage.targetBook, 'NoVigApp');
    assert.equal(result.resultMeta.targetBookCoverage.sourceRowCount, 1);
    assert.equal(result.resultMeta.targetBookCoverage.missingQuoteCount, 1);
  });
});

describe('buildRankedScreenResponse — bounded pre-history shortlist', () => {
  function makeScreenRow(gameId, edge = 0.5, market = 'Moneyline', league = 'NBA') {
    return {
      gameId,
      league,
      market,
      selection1: `Home ${gameId}`,
      participant1: `Home ${gameId}`,
      selection1Id: `${market}:Home_${gameId}`,
      selection2: `Away ${gameId}`,
      participant2: `Away ${gameId}`,
      selection2Id: `${market}:Away_${gameId}`,
      odds: {
        NoVigApp: { odds1: edge > 1 ? 105 : -100, odds2: 100 },
        Pinnacle: { odds1: -120, odds2: -120 }
      },
      timestamp: Date.now()
    };
  }

  it('hydrates only a bounded current-market shortlist and keeps a late strong candidate', async () => {
    const historyCalls = [];
    const strongGame = 'game-late-strong';
    const payload = {
      rows: [
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`game-weak-${index}`)),
        makeScreenRow(strongGame, 2.5)
      ]
    };
    const client = {
      queryOddsHistory: async (params) => {
        historyCalls.push(params);
        if (params.gameId !== strongGame) return [];
        return [
          { odds: -110, line: null, start_ts: 1 },
          { odds: -130, line: null, start_ts: 2 }
        ];
      }
    };
    const rankRows = (rows) =>
      rows.map((row) => ({
        ...row,
        ...(row.gameId === strongGame
          ? {
              movementGrade: 'green',
              movementLabel: 'supportive',
              recentSharpMoveDirection: 'supportive',
              fullWindowSharpMoveDirection: 'supportive',
              clvProxyPct: 1
            }
          : {})
      }));

    const result = await buildRankedScreenResponse({
      client,
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: true, historySportsbooks: ['Pinnacle'] },
      focusBook: 'NoVigApp',
      rankRows
    });

    assert.ok(historyCalls.length > 0);
    assert.ok(historyCalls.length <= 4, `expected bounded history calls, got ${historyCalls.length}`);
    assert.ok(historyCalls.some((call) => call.gameId === strongGame));
    const strongRows = result.result.filter((row) => row.gameId === strongGame);
    assert.ok(strongRows.length > 0, 'late strong candidate should reach ranking');
    assert.equal(strongRows[0].movementDisposition, 'supportive_clean');
    assert.ok(result.resultMeta.preHistoryShortlist, 'shortlist metadata should be surfaced');
    assert.equal(result.resultMeta.preHistoryShortlist.enabled, true);
  });

  it('recovers a skipped standard-market candidate within a bounded recovery budget', async () => {
    const historyCalls = [];
    const makeRow = (gameId, edge) => ({
      ...makeScreenRow(gameId, edge, 'Run Line', 'MLB'),
      market: 'Run Line',
      league: 'MLB'
    });
    const payload = {
      rows: [makeRow('game-weak', 0.5), makeRow('game-viable-skipped', 0.1)]
    };
    const client = {
      queryOddsHistory: async (params) => {
        historyCalls.push(params);
        return [
          { odds: -110, line: -1.5, start_ts: 1 },
          { odds: -130, line: -1.5, start_ts: 2 }
        ];
      }
    };
    const rankRows = (rows) =>
      rows.map((row) => ({
        ...row,
        ...(row.gameId === 'game-viable-skipped'
          ? {
              movementGrade: 'green',
              movementLabel: 'supportive',
              recentSharpMoveDirection: 'supportive',
              fullWindowSharpMoveDirection: 'supportive',
              clvProxyPct: 1
            }
          : {})
      }));

    const result = await buildRankedScreenResponse({
      client,
      payloads: [payload],
      args: {
        limit: 1,
        preHistoryShortlist: true,
        preHistoryGameBudget: 1,
        preHistoryRecoveryGameBudget: 1,
        historySportsbooks: ['Pinnacle']
      },
      focusBook: 'NoVigApp',
      rankRows
    });

    assert.ok(
      historyCalls.length <= 4,
      `expected bounded initial + recovery history calls, got ${historyCalls.length}`
    );
    assert.ok(
      result.result.some((row) => row.gameId === 'game-viable-skipped'),
      'skipped standard-market candidate should be recovered'
    );
    assert.equal(result.resultMeta.preHistoryShortlist.truncated, true);
    assert.equal(result.resultMeta.preHistoryShortlist.totalRows, 4);
    assert.ok(result.resultMeta.preHistoryRecovery, 'recovery metadata should be surfaced');
    assert.equal(result.resultMeta.preHistoryRecovery.recoveredGameCount, 1);
  });

  it('does not treat absent history as supportive and preserves adverse movement as pass data', async () => {
    const payload = { rows: [makeScreenRow('game-no-history'), makeScreenRow('game-adverse')] };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) =>
          params.gameId === 'game-adverse'
            ? [
                { odds: -110, start_ts: 1 },
                { odds: 100, start_ts: 2 }
              ]
            : []
      },
      payloads: [payload],
      args: { limit: 4, preHistoryShortlist: true },
      focusBook: 'NoVigApp',
      rankRows: (rows) =>
        rows.map((row) => ({
          ...row,
          ...(row.gameId === 'game-adverse' ? { movementGrade: 'red', movementLabel: 'adverse' } : {})
        }))
    });

    const noHistory = result.result.find((row) => row.gameId === 'game-no-history');
    const adverse = result.result.find((row) => row.gameId === 'game-adverse');
    assert.equal(noHistory.movementDisposition, 'insufficient');
    assert.equal(adverse.movementDisposition, 'adverse_full');
  });

  it('keeps full exact-selection hydration when the shortlist is not requested (targeted path)', async () => {
    const historyCalls = [];
    const payload = {
      rows: [
        ...Array.from({ length: 10 }, (_, index) => makeScreenRow(`game-tgt-${index}`)),
        makeScreenRow('game-tgt-exact', 2.5)
      ]
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1 },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    // Default (targeted/game lookup) path must hydrate the ENTIRE raw
    // universe — one history call per extracted side row.
    assert.equal(historyCalls.length, payload.rows.length * 2);
    assert.equal(result.result.length, payload.rows.length * 2);
    assert.equal(result.resultMeta.preHistoryShortlist, undefined);
  });

  it('honors an explicit preHistoryShortlist:false opt-out (full hydration)', async () => {
    const historyCalls = [];
    const payload = {
      rows: Array.from({ length: 8 }, (_, index) => makeScreenRow(`game-opt-${index}`))
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: false },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    assert.equal(historyCalls.length, payload.rows.length * 2);
    assert.equal(result.result.length, payload.rows.length * 2);
  });

  it('does not starve a whole league/market when the shortlist is small', async () => {
    const historyCalls = [];
    const payload = {
      rows: [
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`ml-${index}`, 0.5, 'Moneyline', 'NBA')),
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`tot-${index}`, 0.5, 'Total', 'NBA'))
      ]
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: true },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    const moneylineGames = new Set(
      historyCalls.filter((call) => String(call.gameId).startsWith('ml-')).map((call) => call.gameId)
    );
    const totalGames = new Set(
      historyCalls.filter((call) => String(call.gameId).startsWith('tot-')).map((call) => call.gameId)
    );
    assert.ok(moneylineGames.size > 0, 'Moneyline market should be represented in the shortlist');
    assert.ok(totalGames.size > 0, 'Total market should be represented in the shortlist');
    assert.ok(result.resultMeta.preHistoryShortlist, 'shortlist metadata should be surfaced');
  });
});

describe('buildDegradedDataWarnings — line field backfill (v2.1.3)', () => {
  it('emits a warning when non-moneyline rows had line values backfilled from upstream', () => {
    // Real shape after the ranker: rows do NOT have `line1` or `line` set
    // directly. The ranker spreads `...item.row` but `normalizeRow` only
    // lifts `selections.null` — for Puck Line rows (defaultKey "-1" or
    // "-3.5" etc.) the line value lives at `selections[defaultKey].line1`
    // and never gets lifted. The ranker sets `line` from extractScreenRows
    // (which does `row.line1 ?? null`) but in practice for the live NHL
    // Puck Line data the line is on `r.line` (set to the per-row current
    // line), not `r.line1`. The warning check must therefore rely on
    // `lineFieldMissingCount > 0` as the primary signal, with the market
    // name as defense-in-depth.
    const ranked = [
      {
        market: 'Puck Line',
        // No line1 / line2 / selection1 / selection2 — these don't survive
        // the ranker for Puck Line rows in the live data shape.
        lineHistory: [
          { line: -1, odds: 155, time: 1 },
          { line: -1, odds: 150, time: 2 },
          { line: -1, odds: 158, time: 3 }
        ],
        lineFieldMissingCount: 3,
        consensusBookCount: 0
      },
      {
        market: 'Puck Line',
        lineHistory: [
          { line: 1.5, odds: -180, time: 1 },
          { line: 1.5, odds: -185, time: 2 }
        ],
        lineFieldMissingCount: 2,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.ok(lineWarning, 'expected a line-field backfill warning to be present');
    assert.match(lineWarning, /2\/2 non-moneyline rows/);
    assert.match(lineWarning, /5 entries backfilled/);
    assert.match(lineWarning, /Line-movement detection is degraded/);
  });

  it('does not warn for moneyline rows (count is naturally 0 since backfill guards on fallbackLine)', () => {
    const ranked = [
      {
        market: 'Moneyline',
        lineHistory: [
          { line: null, odds: -113, time: 1 },
          { line: null, odds: -114, time: 2 }
        ],
        lineFieldMissingCount: 0,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.equal(lineWarning, undefined, 'should not warn for moneyline rows');
  });

  it('does not warn when lineFieldMissingCount is 0 (upstream provided line values)', () => {
    const ranked = [
      {
        market: 'Puck Line',
        lineHistory: [
          { line: -1, odds: 155, time: 1 },
          { line: -1.5, odds: 165, time: 2 }
        ],
        lineFieldMissingCount: 0,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.equal(lineWarning, undefined, 'should not warn when no fields were backfilled');
  });

  it('does not warn even when line1 is undefined but the row is Puck Line with backfill count > 0', () => {
    // Regression: 2026-06-14 live test caught that the v2.1.3 warning check
    // was filtering out Puck Line rows because `r.line1 == null` evaluated
    // true (line1 is never set for non-"null" default keys). The fix
    // removes the line1/line checks and relies on lineFieldMissingCount +
    // market name. This test confirms the warning fires for the real
    // ranked-row shape (no line1, no line).
    const ranked = [
      {
        market: 'Puck Line',
        // line1 deliberately not set — this is the actual shape from the ranker
        lineHistory: [
          { line: -3.5, odds: 800, time: 1 },
          { line: -3.5, odds: -809, time: 2 }
        ],
        lineFieldMissingCount: 906,
        consensusBookCount: 6
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.ok(
      lineWarning,
      'Puck Line rows with backfill count > 0 should trigger the warning even when line1 is missing from the row'
    );
  });
});

describe('buildRankedScreenResponse — card window diagnostics', () => {
  // Fixed clock: `today` is resolved in the LOCAL timezone, so a test that uses
  // the real Date.now() flips to "outside the window" whenever it runs near
  // local midnight. Pin nowMs mid-day and derive every row start from it.
  const NOW_MS = Date.parse('2026-09-16T20:00:00Z');
  const IN_WINDOW = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
  const OUT_OF_WINDOW = '2030-01-01T19:05:00Z';

  const windowRow = (start) => ({
    gameId: 'game-window-1',
    homeTeam: 'Celtics',
    awayTeam: 'Lakers',
    league: 'NBA',
    market: 'Moneyline',
    selection1: 'Celtics',
    selection1Id: 'Moneyline:Celtics',
    selection2: 'Lakers',
    selection2Id: 'Moneyline:Lakers',
    start,
    odds: {
      NoVigApp: { odds1: -110, odds2: 100 },
      Pinnacle: { odds1: -112, odds2: 102 }
    }
  });

  const buildWindowed = (rows, options = {}) =>
    buildRankedScreenResponse({
      client: { getOddsHistory: async () => [], queryOddsHistory: async () => ({}) },
      payloads: [{ rows }],
      args: { cardWindow: 'today', nowMs: NOW_MS, ...(options.args || {}) },
      rankRows: (ranked) => ranked,
      ...(options.startTimeNormalizer ? { startTimeNormalizer: options.startTimeNormalizer } : {})
    });

  it('reports rows that exist outside the card window instead of an empty slate', async () => {
    // Regression: a `today` window used to report `no_ranked_rows_scanned` with
    // scannedRowCount 0 while the whole next slate sat outside the window, which
    // reads as "the feed has nothing" and hides every league.
    const result = await buildWindowed([windowRow(OUT_OF_WINDOW)]);
    assert.equal(result.result.length, 0);
    assert.equal(result.resultMeta.emptyState.reason, 'outside_card_window');
    assert.equal(result.resultMeta.emptyState.cardWindow, 'today');
    assert.ok(result.resultMeta.cardWindowFilteredRowCount > 0);
    assert.equal(result.resultMeta.emptyState.filteredRowCount, result.resultMeta.cardWindowFilteredRowCount);
  });

  it('leaves no window diagnostic when rows fall inside the window', async () => {
    const result = await buildWindowed([windowRow(IN_WINDOW)]);
    assert.ok(result.result.length > 0);
    assert.equal(result.resultMeta.emptyState, undefined);
    assert.equal(result.resultMeta.cardWindowFilteredRowCount, undefined);
  });

  it('runs startTimeNormalizer before the window filter', async () => {
    // Tennis: the raw gameId timestamp is stale, so the window must judge the
    // corrected start or it filters the wrong day.
    let calls = 0;
    const result = await buildWindowed([windowRow(OUT_OF_WINDOW)], {
      startTimeNormalizer: async (rows) => {
        calls += 1;
        for (const row of rows) {
          row.start = IN_WINDOW;
        }
        return rows;
      }
    });
    assert.equal(calls, 1);
    assert.ok(result.result.length > 0, 'row normalized into the window should survive the filter');
    assert.equal(result.resultMeta.emptyState, undefined);
  });
});
