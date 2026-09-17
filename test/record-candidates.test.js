'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScanCandidates, buildCandidateId, buildScanFingerprint } = require('../lib/record-candidates');

// Focused Task 2 tests: normalize scan output into recordable candidates.
// No recommendation logic, no official-bet creation, deterministic IDs.

describe('normalizeScanCandidates', () => {
  it('flattens all league/market blocks, including tennis fallback rows', () => {
    const blocks = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          { gameId: 'g1', game: 'NYY @ BOS', selection: 'Yankees', odds: -120 },
          { gameId: 'g2', game: 'HOU @ TEX', selection: 'Astros', odds: +150 }
        ]
      },
      {
        league: 'Tennis',
        market: 'All Markets',
        plays: [
          {
            gameId: 'tennis-game-1',
            game: 'Djokovic N vs Alcaraz C',
            market: 'Moneyline',
            selection: 'Djokovic N',
            odds: -120,
            verdict: 'BET',
            source: 'tennis_fallback (Pinnacle)'
          }
        ]
      }
    ];
    const out = normalizeScanCandidates(blocks, { scanId: 'scan-1' });
    assert.equal(out.length, 3);
    // Block-level league/market inherited onto plays that lack them.
    assert.equal(out[0].league, 'MLB');
    assert.equal(out[0].market, 'Moneyline');
    assert.equal(out[1].league, 'MLB');
    // Tennis fallback row keeps its own row-level market, block market otherwise.
    assert.equal(out[2].league, 'Tennis');
    assert.equal(out[2].market, 'Moneyline');
  });

  it('preserves market names exactly, including Set Handicap', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'Set Handicap',
          plays: [{ gameId: 't1', selection: 'Djokovic N -2.5 sets', odds: -110 }]
        },
        {
          league: 'NBA',
          market: 'Point Spread',
          plays: [{ gameId: 'n1', selection: 'Lakers +4.5', odds: -110 }]
        }
      ],
      { scanId: 'scan-set-handicap' }
    );
    assert.equal(out[0].market, 'Set Handicap');
    assert.equal(out[1].market, 'Point Spread');
  });

  it('preserves the full field set and normalizes missing fields to null', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [
            {
              gameId: 'g1',
              game: 'NYY @ BOS',
              selection: 'Yankees',
              odds: -120,
              tier: 'TIER 1',
              verdict: 'BET',
              movement: 'up',
              movementDisposition: 'supportive_clean',
              edge: 2.1,
              clvProxyPct: 1.8,
              books: 12,
              consensusBookCount: 12,
              start: '2026-08-05T18:00:00.000Z',
              startCST: '1:00 PM',
              startDisplay: '1:00 PM CDT',
              startSource: 'pp-mcp (unverified)',
              startConfidence: 0.3
            }
          ]
        }
      ],
      { scanId: 'scan-full' }
    );
    const r = out[0];
    assert.equal(r.gameId, 'g1');
    assert.equal(r.game, 'NYY @ BOS');
    assert.equal(r.league, 'MLB');
    assert.equal(r.market, 'Moneyline');
    assert.equal(r.selection, 'Yankees');
    assert.equal(r.odds, -120);
    assert.equal(r.tier, 'TIER 1');
    assert.equal(r.verdict, 'BET');
    assert.equal(r.movement, 'up');
    assert.equal(r.movementDisposition, 'supportive_clean');
    assert.equal(r.edge, 2.1);
    assert.equal(r.clvProxyPct, 1.8);
    assert.equal(r.books, 12);
    assert.equal(r.consensusBookCount, 12);
    assert.equal(r.start, '2026-08-05T18:00:00.000Z');
    assert.equal(r.startCST, '1:00 PM');
    assert.equal(r.startDisplay, '1:00 PM CDT');
    assert.equal(r.startSource, 'pp-mcp (unverified)');
    assert.equal(r.startConfidence, 0.3);
    assert.equal(r.scanId, 'scan-full');

    // Missing fields are null, never invented.
    const sparse = normalizeScanCandidates([{ league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers' }] }], {
      scanId: 'scan-sparse'
    })[0];
    assert.equal(sparse.gameId, null);
    assert.equal(sparse.game, null);
    assert.equal(sparse.odds, null);
    assert.equal(sparse.tier, null);
    assert.equal(sparse.verdict, null);
    assert.equal(sparse.movement, null);
    assert.equal(sparse.movementDisposition, null);
    assert.equal(sparse.edge, null);
    assert.equal(sparse.clvProxyPct, null);
    assert.equal(sparse.books, null);
    assert.equal(sparse.consensusBookCount, null);
    assert.equal(sparse.start, null);
    assert.equal(sparse.startCST, null);
    assert.equal(sparse.startDisplay, null);
    assert.equal(sparse.startSource, null);
    assert.equal(sparse.startConfidence, null);
  });

  it('keeps BET/CONSIDER verdicts as raw data and never creates an official bet', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'All Markets',
          plays: [
            { gameId: 't1', selection: 'Djokovic N', odds: -120, verdict: 'BET' },
            { gameId: 't2', selection: 'Nakashima', odds: -110, verdict: 'CONSIDER' },
            { gameId: 't3', selection: 'Alcaraz C', odds: +100 }
          ]
        }
      ],
      { scanId: 'scan-verdicts' }
    );
    assert.equal(out[0].verdict, 'BET');
    assert.equal(out[1].verdict, 'CONSIDER');
    assert.equal(out[2].verdict, null);
    // Record shape is exactly the documented field set — no bet flag, no
    // recommendation/decision field derived from the raw verdict.
    assert.deepEqual(Object.keys(out[0]).sort(), [
      'books',
      'candidateId',
      'closeOdds',
      'clvPct',
      'clvProxyPct',
      'consensusBookCount',
      'edge',
      'featureSnapshot',
      'game',
      'gameId',
      'league',
      'market',
      'movement',
      'movementDisposition',
      'odds',
      'openToCurrentPct',
      'scanId',
      'selection',
      'start',
      'startCST',
      'startConfidence',
      'startDisplay',
      'startSource',
      'tier',
      'verdict'
    ]);
  });

  it('accepts a wrapped res shape ({data:{results}} or {results}) in addition to a bare array', () => {
    const block = { league: 'MLB', market: 'Moneyline', plays: [{ gameId: 'g1', selection: 'Yankees', odds: -120 }] };
    const fromData = normalizeScanCandidates({ data: { results: [block] } }, { scanId: 's' });
    const fromRes = normalizeScanCandidates({ results: [block] }, { scanId: 's' });
    const fromArray = normalizeScanCandidates([block], { scanId: 's' });
    assert.equal(fromData.length, 1);
    assert.equal(fromRes.length, 1);
    assert.equal(fromArray.length, 1);
    assert.deepEqual(fromData[0].candidateId, fromArray[0].candidateId);
    assert.deepEqual(fromRes[0].candidateId, fromArray[0].candidateId);
  });

  it('skips blocks with no plays and returns [] for empty input', () => {
    const out = normalizeScanCandidates(
      [
        { league: 'MLB', market: 'Moneyline', plays: [] },
        { league: 'NBA', market: 'Spread', plays: [{ gameId: 'g1', selection: 'Lakers', odds: -110 }] },
        { league: 'Tennis', market: 'All Markets', plays: [] }
      ],
      { scanId: 'scan-empties' }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].league, 'NBA');
    assert.deepEqual(normalizeScanCandidates([], { scanId: 's' }), []);
    assert.deepEqual(normalizeScanCandidates(null, { scanId: 's' }), []);
    assert.deepEqual(normalizeScanCandidates({}, { scanId: 's' }), []);
  });

  it('inherits block-level league/market onto plays that carry their own conflicting values', () => {
    // Row-level values win; block-level values are the fallback, not an override.
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'All Markets',
          plays: [{ gameId: 't1', league: 'Tennis', market: 'Set Handicap', selection: 'Djokovic N -2.5', odds: -110 }]
        }
      ],
      { scanId: 'scan-inherit' }
    );
    assert.equal(out[0].league, 'Tennis');
    assert.equal(out[0].market, 'Set Handicap');
  });
});

describe('featureSnapshot', () => {
  it('is present on every normalized candidate with schemaVersion 1 and capturedAt only when supplied', () => {
    const out = normalizeScanCandidates(
      [{ league: 'NBA', market: 'Spread', plays: [{ gameId: 'g1', selection: 'Lakers', odds: -110 }] }],
      { scanId: 'scan-snap', capturedAt: '2026-08-14T12:00:00.000Z' }
    );
    const snap = out[0].featureSnapshot;
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.capturedAt, '2026-08-14T12:00:00.000Z');

    const noCapture = normalizeScanCandidates(
      [{ league: 'NBA', market: 'Spread', plays: [{ gameId: 'g2', selection: 'Celtics', odds: -110 }] }],
      { scanId: 'scan-nocap' }
    )[0].featureSnapshot;
    assert.equal(noCapture.capturedAt, null);
  });

  it('resolves signalTier via row.signalTier ?? row.confidenceTier ?? row.tier and aliases confidenceTier', () => {
    const fromSignal = normalizeScanCandidates(
      [
        {
          league: 'NBA',
          market: 'Spread',
          plays: [{ selection: 'A', signalTier: 'TIER 1', confidenceTier: 'TIER 2', tier: 'TIER 3' }]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(fromSignal.signalTier, 'TIER 1');
    assert.equal(fromSignal.confidenceTier, 'TIER 1');

    const fromConfidence = normalizeScanCandidates(
      [{ league: 'NBA', market: 'Spread', plays: [{ selection: 'B', confidenceTier: 'TIER 2', tier: 'TIER 3' }] }],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(fromConfidence.signalTier, 'TIER 2');
    assert.equal(fromConfidence.confidenceTier, 'TIER 2');

    const fromTier = normalizeScanCandidates(
      [{ league: 'NBA', market: 'Spread', plays: [{ selection: 'C', tier: 'TIER 3' }] }],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(fromTier.signalTier, 'TIER 3');
    assert.equal(fromTier.confidenceTier, 'TIER 3');

    const none = normalizeScanCandidates([{ league: 'NBA', market: 'Spread', plays: [{ selection: 'D' }] }], {
      scanId: 's'
    })[0].featureSnapshot;
    assert.equal(none.signalTier, null);
    assert.equal(none.confidenceTier, null);
  });

  it('maps signal quality, verdict, movement, edge, books, odds and execution fields per spec', () => {
    const row = {
      selection: 'Lakers',
      odds: -115,
      signalQualityScore: 8.5,
      screenScore: 7.0,
      finalVerdict: 'BET',
      verdict: 'CONSIDER',
      kaiCall: 'LEAN',
      movementDisposition: 'supportive_clean',
      movementGrade: 'A',
      consensusEdge: 4.2,
      edge: 1.1,
      clvProxyPct: 2.5,
      sharpBookCount: 6,
      supportBookCount: 3,
      consensusBookCount: 9,
      marketBookCount: 14,
      executionQuality: 'best',
      targetBookOdds: -118,
      bestAvailableOdds: -120
    };
    const snap = normalizeScanCandidates([{ league: 'NBA', market: 'Spread', plays: [row] }], { scanId: 's' })[0]
      .featureSnapshot;
    assert.equal(snap.signalQualityScore, 8.5);
    assert.equal(snap.verdict, 'BET');
    assert.equal(snap.movementDisposition, 'supportive_clean');
    assert.equal(snap.movementGrade, 'A');
    assert.equal(snap.consensusEdgePct, 4.2);
    assert.equal(snap.clvProxyPct, 2.5);
    assert.equal(snap.sharpBookCount, 6);
    assert.equal(snap.consensusBookCount, 9);
    assert.equal(snap.marketBookCount, 14);
    assert.equal(snap.executionQuality, 'best');
    assert.equal(snap.targetBookOdds, -118);
    assert.equal(snap.bestAvailableOdds, -120);
  });

  it('falls back through alias fields when primary fields are missing', () => {
    const row = {
      selection: 'Astros',
      odds: -105,
      screenScore: 7.0,
      verdict: 'CONSIDER',
      edge: 2.2,
      supportBookCount: 4,
      books: 5
    };
    const snap = normalizeScanCandidates([{ league: 'MLB', market: 'Moneyline', plays: [row] }], { scanId: 's' })[0]
      .featureSnapshot;
    assert.equal(snap.signalQualityScore, 7.0);
    assert.equal(snap.verdict, 'CONSIDER');
    assert.equal(snap.consensusEdgePct, 2.2);
    assert.equal(snap.sharpBookCount, 4);
    assert.equal(snap.consensusBookCount, 5);
    assert.equal(snap.targetBookOdds, -105);
  });

  it('preserves explicitly present probabilities and never derives missing ones', () => {
    const withProbs = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [{ selection: 'A', marketFairProbability: 0.52, modelWinProbability: 0.55, modelMarketEdgePct: 3.1 }]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(withProbs.marketFairProbability, 0.52);
    assert.equal(withProbs.modelWinProbability, 0.55);
    assert.equal(withProbs.modelMarketEdgePct, 3.1);

    const without = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [{ selection: 'B', edge: 2.0, noVigProbability: 0.6, odds: -110 }]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    // No-vig / edge-derived values must not leak into the explicit-only fields.
    assert.equal(without.marketFairProbability, null);
    assert.equal(without.modelWinProbability, null);
    assert.equal(without.modelMarketEdgePct, null);
  });

  it('normalizes explicitly undefined probabilities to null while retaining the keys', () => {
    // Wave B1 regression: own properties set to `undefined` must survive the
    // JSON-safe clone as explicit keys with null values, not be dropped.
    const withUndefined = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [
            {
              selection: 'C',
              marketFairProbability: undefined,
              modelWinProbability: undefined,
              modelMarketEdgePct: undefined
            }
          ]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    // Keys are retained (not dropped by JSON.stringify) and normalized to null.
    assert.equal(Object.prototype.hasOwnProperty.call(withUndefined, 'marketFairProbability'), true);
    assert.equal(withUndefined.marketFairProbability, null);
    assert.equal(Object.prototype.hasOwnProperty.call(withUndefined, 'modelWinProbability'), true);
    assert.equal(withUndefined.modelWinProbability, null);
    assert.equal(Object.prototype.hasOwnProperty.call(withUndefined, 'modelMarketEdgePct'), true);
    assert.equal(withUndefined.modelMarketEdgePct, null);

    // Numeric 0 is a real probability and must survive the normalization.
    const withZero = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [{ selection: 'D', marketFairProbability: 0, modelWinProbability: 0, modelMarketEdgePct: 0 }]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(withZero.marketFairProbability, 0);
    assert.equal(withZero.modelWinProbability, 0);
    assert.equal(withZero.modelMarketEdgePct, 0);
  });

  it('deep-clones the snapshot: mutating the source row after normalize must not alter it', () => {
    const source = {
      gameId: 'g1',
      selection: 'Yankees',
      odds: -120,
      signalTier: 'TIER 1',
      consensusEdge: 3.4,
      movementDisposition: 'supportive_clean',
      books: ['Pinnacle', 'DraftKings']
    };
    const candidate = normalizeScanCandidates([{ league: 'Tennis', market: 'Moneyline', plays: [source] }], {
      scanId: 'scan-features',
      capturedAt: '2026-08-14T12:00:00.000Z'
    })[0];
    const snapshot = candidate.featureSnapshot;
    assert.equal(snapshot.signalTier, 'TIER 1');
    assert.equal(snapshot.consensusEdgePct, 3.4);
    // Mutate the source row after normalization.
    source.books.push('MutatedBook');
    source.signalTier = 'MUTATED';
    assert.equal(snapshot.signalTier, 'TIER 1');

    // Mutating the snapshot must not leak back into the source row.
    snapshot.consensusEdgePct = 99;
  });

  it('keeps sparse inputs fully null rather than fabricated', () => {
    const snap = normalizeScanCandidates([{ league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers' }] }], {
      scanId: 'scan-sparse'
    })[0].featureSnapshot;
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.signalTier, null);
    assert.equal(snap.signalQualityScore, null);
    assert.equal(snap.verdict, null);
    assert.equal(snap.movementDisposition, null);
    assert.equal(snap.movementGrade, null);
    assert.equal(snap.consensusEdgePct, null);
    assert.equal(snap.clvProxyPct, null);
    assert.equal(snap.sharpBookCount, null);
    assert.equal(snap.consensusBookCount, null);
    assert.equal(snap.marketBookCount, null);
    assert.equal(snap.executionQuality, null);
    assert.equal(snap.targetBookOdds, null);
    assert.equal(snap.bestAvailableOdds, null);
  });

  it('preserves explicit decision-time provenance/context fields when present', () => {
    const row = {
      league: 'MLB',
      market: 'Moneyline',
      book: 'Pinnacle',
      line: -1.5,
      selection: 'Yankees',
      gameId: 'g-prov-1',
      decisionTimestamp: '2026-08-14T12:05:00.000Z',
      capturedAt: '2026-08-14T12:00:00.000Z',
      openingOdds: -105,
      decisionOdds: -120,
      movementSourceBook: 'Pinnacle',
      movementMode: 'same_book',
      correlationGroupId: 'game-1',
      sportContext: { format: 'best_of_5', surface: 'hard', round: 'R4' }
    };
    const snap = normalizeScanCandidates([{ league: 'MLB', market: 'Moneyline', plays: [row] }], {
      scanId: 's'
    })[0].featureSnapshot;
    assert.equal(snap.league, 'MLB');
    assert.equal(snap.market, 'Moneyline');
    assert.equal(snap.book, 'Pinnacle');
    assert.equal(snap.line, -1.5);
    assert.equal(snap.selection, 'Yankees');
    assert.equal(snap.gameId, 'g-prov-1');
    assert.equal(snap.decisionTimestamp, '2026-08-14T12:05:00.000Z');
    assert.equal(snap.capturedAt, '2026-08-14T12:00:00.000Z');
    assert.equal(snap.openingOdds, -105);
    assert.equal(snap.decisionOdds, -120);
    assert.equal(snap.movementSourceBook, 'Pinnacle');
    assert.equal(snap.movementMode, 'same_book');
    assert.equal(snap.correlationGroupId, 'game-1');
    assert.deepEqual(snap.sportContext, { format: 'best_of_5', surface: 'hard', round: 'R4' });
  });

  it('isolates nested sportContext from later row and snapshot mutation', () => {
    const source = {
      selection: 'Alcaraz C',
      sportContext: { format: 'best_of_5', flags: { roof: 'closed' } }
    };
    const snap = normalizeScanCandidates([{ league: 'Tennis', market: 'Moneyline', plays: [source] }], {
      scanId: 's'
    })[0].featureSnapshot;
    assert.deepEqual(snap.sportContext, { format: 'best_of_5', flags: { roof: 'closed' } });
    source.sportContext.format = 'MUTATED';
    source.sportContext.flags.roof = 'MUTATED';
    assert.deepEqual(snap.sportContext, { format: 'best_of_5', flags: { roof: 'closed' } });
    snap.sportContext.format = 'SNAP-MUTATED';
    assert.equal(source.sportContext.format, 'MUTATED');
  });

  it('leaves provenance fields null when absent instead of inventing values', () => {
    const snap = normalizeScanCandidates(
      [
        {
          league: 'NBA',
          market: 'Spread',
          plays: [{ selection: 'Lakers', odds: -110, edge: 2.0, noVigProbability: 0.6 }]
        }
      ],
      { scanId: 's' }
    )[0].featureSnapshot;
    assert.equal(snap.league, null);
    assert.equal(snap.market, null);
    assert.equal(snap.book, null);
    assert.equal(snap.line, null);
    assert.equal(snap.gameId, null);
    assert.equal(snap.decisionTimestamp, null);
    assert.equal(snap.openingOdds, null);
    assert.equal(snap.decisionOdds, null);
    assert.equal(snap.movementSourceBook, null);
    assert.equal(snap.movementMode, null);
    assert.equal(snap.correlationGroupId, null);
    assert.equal(snap.sportContext, null);
    // Block-level context is not backfilled into the explicit-only snapshot.
    assert.equal(snap.selection, 'Lakers');
  });

  it('never copies settlement/postgame fields into the snapshot', () => {
    const row = {
      selection: 'Yankees',
      outcome: 'win',
      result: 'win',
      winner: 'Yankees',
      finalScore: '5-3',
      settlement: { status: 'win' },
      settledAt: '2026-08-15T12:00:00.000Z',
      payout: 100
    };
    const snap = normalizeScanCandidates([{ league: 'MLB', market: 'Moneyline', plays: [row] }], {
      scanId: 's'
    })[0].featureSnapshot;
    for (const field of ['outcome', 'result', 'winner', 'finalScore', 'settlement', 'settledAt', 'payout']) {
      assert.equal(Object.prototype.hasOwnProperty.call(snap, field), false);
    }
  });
});

describe('buildCandidateId', () => {
  const base = { scanId: 'scan-1', gameId: 'g1', market: 'Moneyline', selection: 'Yankees', odds: -120 };

  it('is deterministic for identical inputs', () => {
    assert.equal(buildCandidateId(base), buildCandidateId(base));
  });

  it('varies with scan ID', () => {
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, scanId: 'scan-2' }));
  });

  it('varies with game ID, market, selection, and captured price context', () => {
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, gameId: 'g2' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, market: 'Spread' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, selection: 'Red Sox' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, odds: -110 }));
  });

  it('produces a 16-char hex id following the repo sha256 convention', () => {
    const id = buildCandidateId(base);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it('is stable for missing optional fields (null/undefined normalize the same)', () => {
    assert.equal(
      buildCandidateId({ scanId: 's', gameId: 'g', market: null, selection: 'X', odds: undefined }),
      buildCandidateId({ scanId: 's', gameId: 'g', market: undefined, selection: 'X', odds: null })
    );
  });
});

describe('buildScanFingerprint', () => {
  it('changes when actual play identity changes even if scan filters do not', () => {
    const first = [{ league: 'MLB', market: 'Moneyline', plays: [{ gameId: 'g1', selection: 'Yankees', odds: -120 }] }];
    const second = [
      { league: 'MLB', market: 'Moneyline', plays: [{ gameId: 'g2', selection: 'Red Sox', odds: -120 }] }
    ];
    assert.notEqual(buildScanFingerprint(first), buildScanFingerprint(second));
  });

  it('is independent of input play order', () => {
    const first = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          { gameId: 'g1', selection: 'Yankees', odds: -120 },
          { gameId: 'g2', selection: 'Astros', odds: +150 }
        ]
      }
    ];
    const second = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          { gameId: 'g2', selection: 'Astros', odds: +150 },
          { gameId: 'g1', selection: 'Yankees', odds: -120 }
        ]
      }
    ];
    assert.equal(buildScanFingerprint(first), buildScanFingerprint(second));
  });

  it('canonicalizes numeric and string odds consistently', () => {
    const numeric = [{ market: 'Moneyline', plays: [{ gameId: 'g1', selection: 'Yankees', odds: -120 }] }];
    const string = [{ market: 'Moneyline', plays: [{ gameId: 'g1', selection: 'Yankees', odds: '-120' }] }];
    assert.equal(buildScanFingerprint(numeric), buildScanFingerprint(string));
  });
});
