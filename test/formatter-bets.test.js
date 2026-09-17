'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatBetCompact,
  formatQuickScreenBets,
  formatQuickScreenMinimal,
  movementGradeEmoji,
  buildQuickScreenSummary,
  formatBetsSummaryLine,
  buildByLeagueStats
} = require('../lib/ssb-formatter');
const { computeClvFromHistory } = require('../lib/tennis-fallback');

// ---------------------------------------------------------------------------
// movementGradeEmoji
// ---------------------------------------------------------------------------

describe('movementGradeEmoji', () => {
  it('maps green to 🟢', () => {
    assert.ok(movementGradeEmoji('green').includes('🟢'));
  });
  it('maps yellow to 🟡', () => {
    assert.ok(movementGradeEmoji('yellow').includes('🟡'));
  });
  it('maps red to 🔴', () => {
    assert.ok(movementGradeEmoji('red').includes('🔴'));
  });
  it('maps unknown to ⚪', () => {
    assert.ok(movementGradeEmoji('unknown').includes('⚪'));
  });
  it('maps null/undefined to ⚪', () => {
    assert.ok(movementGradeEmoji(null).includes('⚪'));
    assert.ok(movementGradeEmoji(undefined).includes('⚪'));
  });
  it('is case-insensitive', () => {
    assert.ok(movementGradeEmoji('GREEN').includes('🟢'));
    assert.ok(movementGradeEmoji('Red').includes('🔴'));
  });
});

describe('computeClvFromHistory', () => {
  it('returns CLV and the opening/current odds for two entries', () => {
    const result = computeClvFromHistory([
      { odds: -110, start_ts: 2 },
      { odds: -125, start_ts: 1 }
    ]);
    assert.deepEqual(result, {
      clv: (100 / 225 - 100 / 210) * 100,
      openingOdds: -125,
      currentOdds: -110
    });
  });

  it('returns null when history has fewer than two entries', () => {
    assert.equal(computeClvFromHistory([{ odds: -110, start_ts: 1 }]), null);
  });
});

// ---------------------------------------------------------------------------
// formatBetCompact — stripped riskScore, added movementGrade
// ---------------------------------------------------------------------------

describe('formatBetCompact', () => {
  it('includes movementGrade', () => {
    const bet = {
      selection: 'Test',
      odds: 100,
      movementGrade: 'green',
      confidenceTier: 'TIER 1'
    };
    const result = formatBetCompact(bet);
    assert.equal(result.movementGrade, 'green');
  });

  it('strips riskScore (risk field)', () => {
    const bet = {
      selection: 'Test',
      odds: 100,
      riskScore: 7,
      confidenceTier: 'TIER 1'
    };
    const result = formatBetCompact(bet);
    assert.equal(result.risk, undefined);
  });

  it('preserves opening and current odds', () => {
    const result = formatBetCompact({
      selection: 'Test',
      openingOdds: -110,
      currentOdds: -125
    });
    assert.equal(result.openingOdds, -110);
    assert.equal(result.currentOdds, -125);
  });

  it('still includes essential fields', () => {
    const bet = {
      selection: 'Test',
      odds: 105,
      edge: 3.2,
      game: 'A vs B',
      league: 'NBA',
      market: 'Moneyline',
      confidenceTier: 'TIER 1',
      consensusBookCount: 5,
      startCST: '7:00 PM',
      movementGrade: 'green'
    };
    const result = formatBetCompact(bet);
    assert.equal(result.selection, 'Test');
    assert.equal(result.odds, 105);
    assert.equal(result.edge, 3.2);
    assert.equal(result.books, 5);
    assert.equal(result.startCST, '7:00 PM');
    assert.equal(result.movementGrade, 'green');
    assert.equal(result.market, 'Moneyline');
    assert.equal(result.risk, undefined);
  });

  it('keeps every price numeric and carries the NoVig probability in oddsDisplay', () => {
    // A structured payload must never put a display string where a consumer
    // reads a price: `--record-scan` writes this field into the ledger, and 64
    // of 90 recorded decision prices were unusable precisely because a
    // probability string sat in it.
    const noVig = formatBetCompact({ selection: 'NoVig Pick', odds: -141, book: 'NoVigApp' });
    assert.equal(noVig.odds, -141);
    assert.equal(noVig.oddsDisplay, '58.5%');

    const other = formatBetCompact({ selection: 'FanDuel Pick', odds: -141, book: 'FanDuel' });
    assert.equal(other.odds, -141);
    assert.equal(other.oddsDisplay, '-141');
  });

  it('carries the machine-readable start alongside the startCST display string', () => {
    // The compact shape must keep the backend's own `start` (epoch seconds for
    // MLB/WNBA/NBA/NFL/NHL, ISO for Soccer/Tennis) because `startCST` is a
    // year-less display string that cannot be converted to an epoch. Dropping
    // it left the external-ratings recency gate with no event time to gate on,
    // so every record was withheld as `event_start_unknown` on a real scan.
    const start = 1789618800;
    const result = formatBetCompact({
      selection: 'Under 9.5',
      odds: -110,
      start,
      startCST: 'Wed, Sep 16, 8:40 PM CT'
    });
    assert.equal(result.start, start);
    assert.equal(result.startCST, 'Wed, Sep 16, 8:40 PM CT');
  });

  it('reports a null start when the row carries none', () => {
    assert.equal(formatBetCompact({ selection: 'Test', odds: 100 }).start, null);
  });
});

// ---------------------------------------------------------------------------
// buildByLeagueStats
// ---------------------------------------------------------------------------

describe('buildByLeagueStats', () => {
  it('counts TIER 1 and TIER 2 per league', () => {
    const results = [
      {
        league: 'NBA',
        market: 'Moneyline',
        candidates: [
          { confidenceTier: 'TIER 1', edge: 5.0 },
          { confidenceTier: 'TIER 1', edge: 3.0 },
          { confidenceTier: 'TIER 2', edge: 2.0 },
          { confidenceTier: 'TIER 4', edge: 1.0 }
        ]
      },
      {
        league: 'MLB',
        market: 'Spread',
        candidates: [
          { confidenceTier: 'TIER 1', edge: 4.0 },
          { confidenceTier: 'TIER 2', edge: 1.5 }
        ]
      }
    ];
    const stats = buildByLeagueStats(results);
    assert.deepEqual(stats.NBA, { tier1: 2, tier2: 1, total: 4 });
    assert.deepEqual(stats.MLB, { tier1: 1, tier2: 1, total: 2 });
  });

  it('handles empty results', () => {
    const stats = buildByLeagueStats([]);
    assert.deepEqual(stats, {});
  });

  it('uses finalConfidenceTier over confidenceTier', () => {
    const results = [
      {
        league: 'NBA',
        market: 'Moneyline',
        candidates: [{ confidenceTier: 'TIER 1', finalConfidenceTier: 'TIER 2', edge: 3.0 }]
      }
    ];
    const stats = buildByLeagueStats(results);
    assert.deepEqual(stats.NBA, { tier1: 0, tier2: 1, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// buildQuickScreenSummary
// ---------------------------------------------------------------------------

describe('buildQuickScreenSummary', () => {
  const sampleResults = [
    {
      league: 'NBA',
      market: 'Moneyline',
      candidates: [
        {
          selection: 'Lakers ML',
          game: 'Lakers vs Celtics',
          odds: -110,
          edge: 3.5,
          confidenceTier: 'TIER 1',
          movementGrade: 'green',
          consensusBookCount: 5,
          startCST: '7:00 PM'
        },
        {
          selection: 'Suns +4',
          game: 'Suns vs Warriors',
          odds: -105,
          edge: 2.1,
          confidenceTier: 'TIER 2',
          movementGrade: 'yellow',
          consensusBookCount: 3,
          startCST: '9:00 PM'
        },
        {
          selection: 'Knicks O220.5',
          game: 'Knicks vs Heat',
          odds: -110,
          edge: 1.8,
          confidenceTier: 'TIER 2',
          movementGrade: 'red',
          consensusBookCount: 4,
          startCST: '7:30 PM'
        }
      ]
    },
    {
      league: 'MLB',
      market: 'Moneyline',
      candidates: [
        {
          selection: 'Yankees ML',
          game: 'Yankees vs Red Sox',
          odds: -120,
          edge: 4.0,
          confidenceTier: 'TIER 1',
          movementGrade: 'green',
          consensusBookCount: 6,
          startCST: '6:30 PM'
        }
      ]
    }
  ];

  it('returns "No strong plays right now." for empty', () => {
    assert.equal(buildQuickScreenSummary([]), 'No strong plays right now.');
    assert.equal(buildQuickScreenSummary(null), 'No strong plays right now.');
  });

  it('includes league section headers', () => {
    const summary = buildQuickScreenSummary(sampleResults);
    assert.ok(summary.includes('── MLB ──'));
    assert.ok(summary.includes('── NBA ──'));
  });

  it('includes per-league summary footer', () => {
    const summary = buildQuickScreenSummary(sampleResults);
    assert.ok(summary.includes('── Summary ──'));
    assert.ok(summary.includes('NBA: TIER 1: 1, TIER 2: 2'));
    assert.ok(summary.includes('MLB: TIER 1: 1'));
  });

  it('includes selection, odds, edge, movement emoji, book count, and time in each line', () => {
    const summary = buildQuickScreenSummary(sampleResults);
    assert.ok(summary.includes('Lakers ML at -110'));
    assert.ok(summary.includes('3.5% edge'));
    assert.ok(summary.includes('5 books'));
    assert.ok(summary.includes('7:00 PM'));
    assert.ok(summary.includes('TIER 1'));
  });

  it('uses response-level NoVig context for displayed prices', () => {
    const summary = buildQuickScreenSummary(
      [{ league: 'Tennis', candidates: [{ selection: 'NoVig Pick', odds: -141, confidenceTier: 'TIER 1' }] }],
      { targetBook: 'NoVigApp' }
    );
    assert.ok(summary.includes('NoVig Pick at 58.5%'));
    assert.ok(!summary.includes('NoVig Pick at -141'));
  });

  it('caps at 5 plays per league with +N more note', () => {
    const candidates = [];
    for (let i = 0; i < 8; i++) {
      candidates.push({
        selection: `Team ${i}`,
        game: `Game ${i}`,
        odds: -110,
        edge: (8 - i) * 0.5,
        confidenceTier: i < 2 ? 'TIER 1' : 'TIER 2',
        movementGrade: 'green',
        consensusBookCount: 3,
        startCST: `${i}:00 PM`
      });
    }
    const results = [{ league: 'NBA', market: 'Moneyline', candidates }];
    const summary = buildQuickScreenSummary(results);
    assert.ok(summary.includes('+3 more plays'));
  });

  it('sorts TIER 1 before TIER 2, and TIER 2 by descending edge', () => {
    const candidates = [
      {
        selection: 'LowEdgeT2',
        game: 'G1',
        odds: -110,
        edge: 0.5,
        confidenceTier: 'TIER 2',
        movementGrade: 'green',
        consensusBookCount: 2,
        startCST: '1:00 PM'
      },
      {
        selection: 'HighEdgeT2',
        game: 'G2',
        odds: -110,
        edge: 5.0,
        confidenceTier: 'TIER 2',
        movementGrade: 'green',
        consensusBookCount: 2,
        startCST: '2:00 PM'
      },
      {
        selection: 'T1Play',
        game: 'G3',
        odds: -110,
        edge: 2.0,
        confidenceTier: 'TIER 1',
        movementGrade: 'green',
        consensusBookCount: 2,
        startCST: '3:00 PM'
      },
      {
        selection: 'MidEdgeT2',
        game: 'G4',
        odds: -110,
        edge: 3.0,
        confidenceTier: 'TIER 2',
        movementGrade: 'green',
        consensusBookCount: 2,
        startCST: '4:00 PM'
      }
    ];
    const results = [{ league: 'NBA', market: 'Moneyline', candidates }];
    const summary = buildQuickScreenSummary(results);
    const t1Idx = summary.indexOf('T1Play');
    const highIdx = summary.indexOf('HighEdgeT2');
    const midIdx = summary.indexOf('MidEdgeT2');
    const lowIdx = summary.indexOf('LowEdgeT2');
    assert.ok(t1Idx < highIdx, 'TIER 1 should come before TIER 2');
    assert.ok(highIdx < midIdx, 'TIER 2 should be sorted by edge descending');
    assert.ok(midIdx < lowIdx, 'TIER 2 should be sorted by edge descending');
  });
});

// ---------------------------------------------------------------------------
// formatBetsSummaryLine
// ---------------------------------------------------------------------------

describe('formatBetsSummaryLine', () => {
  it('outputs selection, odds, edge, movement emoji, books, time, tier', () => {
    const c = {
      selection: 'Lakers ML',
      odds: -110,
      edge: 3.5,
      movementGrade: 'green',
      consensusBookCount: 5,
      startCST: '7:00 PM',
      confidenceTier: 'TIER 1'
    };
    const line = formatBetsSummaryLine(c);
    assert.ok(line.includes('Lakers ML at -110'));
    assert.ok(line.includes('3.5% edge'));
    assert.ok(line.includes('5 books'));
    assert.ok(line.includes('7:00 PM'));
    assert.ok(line.includes('TIER 1'));
    assert.ok(line.includes('🟢'));
  });

  it('uses "1 book" for singular', () => {
    const c = {
      selection: 'Test',
      odds: 100,
      edge: 1.0,
      movementGrade: 'yellow',
      consensusBookCount: 1,
      confidenceTier: 'TIER 2'
    };
    const line = formatBetsSummaryLine(c);
    assert.ok(line.includes('1 book'));
    assert.ok(!line.includes('1 books'));
  });

  it('handles missing fields gracefully', () => {
    const c = { selection: 'Test', odds: 100 };
    const line = formatBetsSummaryLine(c);
    assert.ok(line.includes('Test at +100'));
  });

  it('uses startNote when present', () => {
    const c = {
      selection: 'Test',
      odds: 100,
      startCST: '7:00 PM',
      startNote: 'PPD'
    };
    const line = formatBetsSummaryLine(c);
    assert.ok(line.includes('7:00 PM (PPD)'));
  });

  it('uses validatedConsensusBookCount when consensusBookCount is missing', () => {
    const c = {
      selection: 'Test',
      odds: 100,
      validatedConsensusBookCount: 7
    };
    const line = formatBetsSummaryLine(c);
    assert.ok(line.includes('7 books'));
  });
});

// ---------------------------------------------------------------------------
// formatQuickScreenBets — response-level
// ---------------------------------------------------------------------------

describe('formatQuickScreenBets', () => {
  const sampleResponse = {
    ok: true,
    totalCandidates: 4,
    tierStats: { test: true },
    results: [
      {
        league: 'NBA',
        market: 'Moneyline',
        candidates: [
          {
            selection: 'Lakers ML',
            game: 'Lakers vs Celtics',
            odds: -110,
            edge: 3.5,
            confidenceTier: 'TIER 1',
            movementGrade: 'green',
            consensusBookCount: 5,
            startCST: '7:00 PM'
          }
        ]
      },
      {
        league: 'MLB',
        market: 'Moneyline',
        candidates: [
          {
            selection: 'Yankees ML',
            game: 'Yankees vs Red Sox',
            odds: -120,
            edge: 4.0,
            confidenceTier: 'TIER 1',
            movementGrade: 'green',
            consensusBookCount: 6,
            startCST: '6:30 PM'
          }
        ]
      }
    ],
    activeSlate: [
      { league: 'NBA', market: 'Moneyline', count: 1, error: null },
      { league: 'MLB', market: 'Moneyline', count: 1, error: null }
    ],
    emptySlate: [
      { league: 'WNBA', market: 'Spread', reason: 'no candidates returned' },
      { league: 'MLB', market: 'Totals', reason: 'all candidates filtered out (card window / tier / kaiCall)' }
    ],
    warnings: ['Some games have already started. Live odds may be stale.']
  };

  it('returns ok, totalCandidates, tierStats', () => {
    const out = formatQuickScreenBets(sampleResponse);
    assert.equal(out.ok, true);
    assert.equal(out.totalCandidates, 4);
    assert.ok(out.tierStats);
  });

  it('includes summary with league headers', () => {
    const out = formatQuickScreenBets(sampleResponse);
    assert.ok(typeof out.summary === 'string');
    assert.ok(out.summary.includes('── NBA ──'));
    assert.ok(out.summary.includes('── MLB ──'));
    assert.ok(out.summary.includes('── Summary ──'));
  });

  it('includes byLeague stats', () => {
    const out = formatQuickScreenBets(sampleResponse);
    assert.deepEqual(out.byLeague.NBA, { tier1: 1, tier2: 0, total: 1 });
    assert.deepEqual(out.byLeague.MLB, { tier1: 1, tier2: 0, total: 1 });
  });

  it('includes structured results with compact plays', () => {
    const out = formatQuickScreenBets(sampleResponse);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].league, 'NBA');
    assert.equal(out.results[0].plays[0].selection, 'Lakers ML');
    assert.equal(out.results[0].plays[0].movementGrade, 'green');
    assert.equal(out.results[0].plays[0].risk, undefined);
  });

  it('keeps the structured price numeric and the NoVig percentage in oddsDisplay', () => {
    const out = formatQuickScreenBets({
      ...sampleResponse,
      targetBook: 'NoVigApp',
      targetBooks: ['NoVigApp']
    });
    assert.equal(out.results[0].plays[0].odds, -110);
    assert.equal(out.results[0].plays[0].oddsDisplay, '52.4%');
    assert.ok(out.summary.includes('Lakers ML at 52.4%'));
  });

  it('preserves activeSlate, emptySlate, and warnings diagnostics', () => {
    const out = formatQuickScreenBets(sampleResponse);
    assert.deepEqual(out.activeSlate, sampleResponse.activeSlate);
    assert.deepEqual(out.emptySlate, sampleResponse.emptySlate);
    assert.deepEqual(out.warnings, sampleResponse.warnings);
  });

  it('preserves unresolved candidates separately from official plays', () => {
    const out = formatQuickScreenBets({
      ...sampleResponse,
      unresolvedCandidates: [
        {
          league: 'Tennis',
          market: 'Moneyline',
          selection: 'Unhydrated Player',
          gameId: 'unresolved-1',
          status: 'unresolved',
          incomplete: true,
          lineHistoryAvailable: false,
          movementDisposition: 'unavailable',
          official: false,
          validationFailureReason: 'history not hydrated within bounded scan budget'
        }
      ]
    });
    assert.equal(out.totalCandidates, 4);
    assert.equal(out.results.flatMap((entry) => entry.plays).length, 2);
    assert.equal(out.unresolvedCandidates.length, 1);
    assert.equal(out.unresolvedCandidates[0].status, 'unresolved');
    assert.equal(out.unresolvedCandidates[0].incomplete, true);
    assert.equal(out.unresolvedCandidates[0].lineHistoryAvailable, false);
    assert.equal(out.unresolvedCandidates[0].movementDisposition, 'unavailable');
    assert.equal(out.unresolvedCandidates[0].official, false);
    assert.equal(out.unresolvedCandidates[0].selection, 'Unhydrated Player');
  });

  it('preserves compact scan health and diagnostic watch candidates', () => {
    const response = {
      ...sampleResponse,
      scanHealth: {
        incomplete: true,
        validationBudgetExhausted: true,
        validation: { requested: 10, selected: 0, completedCount: 0 },
        truncated: true
      },
      watchCandidates: [
        {
          league: 'NBA',
          market: 'Moneyline',
          selection: 'Celtics ML',
          odds: -105,
          edge: 2.1,
          kaiCall: 'BET',
          finalVerdict: 'BET',
          validationBudgetExhausted: true,
          validationFailureReason: 'shared odds-history budget exhausted before validation',
          official: false,
          lineHistory: { verbose: true }
        }
      ]
    };

    const out = formatQuickScreenBets(response);
    assert.deepEqual(out.scanHealth, response.scanHealth);
    assert.equal(out.watchCandidates.length, 1);
    assert.equal(out.watchCandidates[0].selection, 'Celtics ML');
    assert.equal(out.watchCandidates[0].official, false);
    assert.equal(out.watchCandidates[0].validationBudgetExhausted, true);
    assert.equal(out.watchCandidates[0].validationFailureReason, response.watchCandidates[0].validationFailureReason);
    assert.equal(out.watchCandidates[0].lineHistory, undefined);
    assert.equal(out.results[0].plays[0].official, undefined);
  });

  it('carries empty-slate content through verbatim (league, market, reason)', () => {
    const response = {
      ok: true,
      results: [],
      activeSlate: [],
      emptySlate: [
        { league: 'MLS', market: 'NoVigApp', reason: 'no candidates returned' },
        { league: 'MLS', market: 'Spread', reason: 'all candidates filtered out (card window / tier / kaiCall)' }
      ],
      warnings: []
    };
    const out = formatQuickScreenBets(response);
    assert.deepEqual(out.emptySlate, [
      { league: 'MLS', market: 'NoVigApp', reason: 'no candidates returned' },
      { league: 'MLS', market: 'Spread', reason: 'all candidates filtered out (card window / tier / kaiCall)' }
    ]);
    assert.equal(out.emptySlate[0].league, 'MLS');
    assert.equal(out.emptySlate[0].market, 'NoVigApp');
    assert.equal(out.emptySlate[0].reason, 'no candidates returned');
    assert.equal(out.emptySlate[1].reason, 'all candidates filtered out (card window / tier / kaiCall)');
  });

  it('defaults activeSlate/emptySlate/warnings to [] when absent', () => {
    const out = formatQuickScreenBets({ ok: true, results: [] });
    assert.deepEqual(out.activeSlate, []);
    assert.deepEqual(out.emptySlate, []);
    assert.deepEqual(out.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// formatQuickScreenMinimal — response-level
// ---------------------------------------------------------------------------

describe('formatQuickScreenMinimal', () => {
  const sampleResponse = {
    ok: true,
    results: [
      {
        league: 'NBA',
        market: 'Moneyline',
        candidates: [
          {
            selection: 'Lakers ML',
            game: 'Lakers vs Celtics',
            odds: -110,
            edge: 3.5,
            confidenceTier: 'TIER 1',
            movementGrade: 'green',
            consensusBookCount: 5,
            startCST: '7:00 PM'
          },
          {
            selection: 'Celtics +3',
            game: 'Lakers vs Celtics',
            odds: -105,
            edge: 1.5,
            confidenceTier: 'TIER 2',
            movementGrade: 'yellow',
            consensusBookCount: 3,
            startCST: '7:00 PM'
          }
        ]
      }
    ]
  };

  it('returns summary, count, type, and byLeague', () => {
    const out = formatQuickScreenMinimal(sampleResponse);
    assert.equal(typeof out.summary, 'string');
    assert.equal(out.count, 2);
    assert.equal(out.type, 'plays');
    assert.ok(out.byLeague);
    assert.equal(out.byLeague.NBA.tier1, 1);
    assert.equal(out.byLeague.NBA.tier2, 1);
  });

  it('returns no_plays for empty results', () => {
    const out = formatQuickScreenMinimal({ results: [] });
    assert.equal(out.summary, 'No strong plays right now.');
    assert.equal(out.count, 0);
    assert.equal(out.type, 'no_plays');
  });

  it('preserves incomplete scan health and watch candidates in zero-result minimal output', () => {
    const out = formatQuickScreenMinimal({
      results: [],
      scanHealth: {
        incomplete: true,
        truncated: true,
        preHistoryShortlist: [
          { league: 'MLB', market: 'Run Line', totalRows: 144, shortlistedRows: 16, skippedRowCount: 128 }
        ]
      },
      watchCandidates: [{ gameId: 'watch-1', official: false }]
    });

    assert.equal(out.scanHealth.incomplete, true);
    assert.equal(out.scanHealth.truncated, true);
    assert.equal(out.scanHealth.preHistoryShortlist[0].skippedRowCount, 128);
    assert.deepEqual(out.watchCandidates, [{ gameId: 'watch-1', official: false }]);
  });

  it('includes structured plays with movementGrade and no riskScore', () => {
    const out = formatQuickScreenMinimal(sampleResponse);
    assert.equal(out.plays.length, 2);
    assert.equal(out.plays[0].selection, 'Lakers ML');
    assert.equal(out.plays[0].movementGrade, 'green');
    assert.equal(out.plays[0].riskScore, undefined);
  });

  it('carries cardWindowFallthrough / nextDayMerged flags', () => {
    const response = {
      results: [
        {
          league: 'NBA',
          market: 'Moneyline',
          candidates: [{ selection: 'Test', odds: -110, edge: 1, confidenceTier: 'TIER 1' }]
        }
      ],
      cardWindowFallthrough: true,
      nextDayMerged: true,
      nextDayDate: '2026-07-28',
      cardWindow: 'tomorrow'
    };
    const out = formatQuickScreenMinimal(response);
    assert.equal(out.cardWindowFallthrough, true);
    assert.equal(out.nextDayMerged, true);
    assert.equal(out.nextDayDate, '2026-07-28');
    assert.equal(out.cardWindow, 'tomorrow');
  });
});
