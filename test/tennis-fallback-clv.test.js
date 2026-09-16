'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeClvFromHistory,
  deriveMovementFromClv,
  verdictFromDisposition,
  assignTierFromClv,
  isTennisAlternateLine,
  resolveOppositeSideConflicts
} = require('../lib/tennis-fallback');

describe('computeClvFromHistory', () => {
  it('returns null for empty array', () => {
    assert.equal(computeClvFromHistory([]), null);
  });

  it('returns null for single entry', () => {
    assert.equal(computeClvFromHistory([{ odds: 100, start_ts: 1 }]), null);
  });

  it('computes positive CLV when odds move toward selection (favorite gets cheaper)', () => {
    const history = [
      { odds: -120, start_ts: 1 },
      { odds: -110, start_ts: 2 }
    ];
    const result = computeClvFromHistory(history);
    assert.equal(typeof result, 'object', 'returns result object');
    assert.ok(result.clv < 0, `expected negative CLV (adverse), got ${result.clv}`);
    assert.equal(result.openingOdds, -120);
    assert.equal(result.currentOdds, -110);
  });

  it('computes negative CLV when underdog odds shorten', () => {
    const history = [
      { odds: 150, start_ts: 1 },
      { odds: 130, start_ts: 2 }
    ];
    const result = computeClvFromHistory(history);
    assert.ok(result.clv > 0, `expected positive CLV (supportive), got ${result.clv}`);
    assert.equal(result.openingOdds, 150);
    assert.equal(result.currentOdds, 130);
  });

  it('computes CLV correctly: -133 → -129 (favorite weakens = adverse)', () => {
    const history = [
      { odds: -133, start_ts: 1 },
      { odds: -129, start_ts: 2 }
    ];
    const result = computeClvFromHistory(history);
    assert.ok(Math.abs(result.clv - -0.75) < 0.1, `expected ~-0.75, got ${result.clv}`);
  });

  it('sorts by timestamp', () => {
    const history = [
      { odds: -110, start_ts: 2 },
      { odds: -120, start_ts: 1 }
    ];
    const result = computeClvFromHistory(history);
    assert.ok(result.clv < 0, `expected negative CLV, got ${result.clv}`);
  });
});

describe('deriveMovementFromClv', () => {
  it('returns supportive_clean for CLV > 2', () => {
    assert.equal(deriveMovementFromClv(3), 'supportive_clean');
  });

  it('returns supportive_bouncy for CLV 0-2', () => {
    assert.equal(deriveMovementFromClv(1), 'supportive_bouncy');
  });

  it('returns adverse_full for CLV < -2', () => {
    assert.equal(deriveMovementFromClv(-3), 'adverse_full');
  });

  it('returns adverse_recent for CLV -2 to 0', () => {
    assert.equal(deriveMovementFromClv(-1), 'adverse_recent');
  });

  it('returns insufficient for null', () => {
    assert.equal(deriveMovementFromClv(null), 'insufficient');
  });

  it('returns insufficient for exactly 0', () => {
    assert.equal(deriveMovementFromClv(0), 'insufficient');
  });
});

describe('verdictFromDisposition', () => {
  it('returns BET for supportive_clean', () => {
    assert.equal(verdictFromDisposition('supportive_clean'), 'BET');
  });

  it('returns BET for supportive_bouncy', () => {
    assert.equal(verdictFromDisposition('supportive_bouncy'), 'BET');
  });

  it('returns CONSIDER for adverse_full', () => {
    assert.equal(verdictFromDisposition('adverse_full'), 'CONSIDER');
  });

  it('returns CONSIDER for adverse_recent', () => {
    assert.equal(verdictFromDisposition('adverse_recent'), 'CONSIDER');
  });

  it('returns CONSIDER for insufficient', () => {
    assert.equal(verdictFromDisposition('insufficient'), 'CONSIDER');
  });
});

describe('assignTierFromClv', () => {
  it('returns TIER 1 for high CLV', () => {
    assert.equal(assignTierFromClv(3, 1), 'TIER 1');
  });

  it('returns TIER 1 for medium CLV', () => {
    assert.equal(assignTierFromClv(2, 1), 'TIER 1');
  });

  it('returns TIER 2 for low CLV', () => {
    assert.equal(assignTierFromClv(0.5, 1), 'TIER 2');
  });

  it('returns TIER 2 for null CLV', () => {
    assert.equal(assignTierFromClv(null, 1), 'TIER 2');
  });

  it('never awards TIER 1 for adverse CLV', () => {
    // Regression: grading on |CLV| let a line that moved AGAINST the play
    // (-4) ship as TIER 1 while its verdict was CONSIDER.
    assert.equal(assignTierFromClv(-4, 3), 'TIER 3');
    assert.equal(assignTierFromClv(-2.5, 3), 'TIER 3');
    assert.equal(assignTierFromClv(-1.8, 2), 'TIER 3');
  });
});

describe('isTennisAlternateLine', () => {
  // Moneyline is always standard
  it('returns false for Moneyline regardless of selection text', () => {
    assert.equal(isTennisAlternateLine('Moneyline', 'Djokovic'), false);
  });

  it('returns false for Moneyline with empty selection', () => {
    assert.equal(isTennisAlternateLine('Moneyline', ''), false);
  });

  // Total Games is always standard
  it('returns false for Total Games regardless of line number', () => {
    assert.equal(isTennisAlternateLine('Total Games', 'Over 22.5'), false);
  });

  // Game Handicap
  it('returns false for standard Game Handicap ±1.5', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic -1.5'), false);
  });

  it('returns false for standard Game Handicap +1.5', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz +1.5'), false);
  });

  it('returns false for Game Handicap ±2.5 (also standard)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic -2.5'), false);
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz +2.5'), false);
  });

  it('returns true for expanded Game Handicap +3.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic +3.5'), true);
  });

  it('returns true for expanded Game Handicap -4.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz -4.5'), true);
  });

  it('returns true for expanded Game Handicap +6.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic +6.5'), true);
  });

  it('returns false for Game Handicap with no numeric line (keep by default)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic'), false);
  });

  // Unknown market type
  it('returns false for unknown market type', () => {
    assert.equal(isTennisAlternateLine('Player Props', 'Djokovic Ace Count'), false);
  });
});

describe('resolveOppositeSideConflicts', () => {
  it('passes through non-array input', () => {
    assert.deepEqual(resolveOppositeSideConflicts(null), null);
    assert.deepEqual(resolveOppositeSideConflicts(undefined), undefined);
  });

  it('leaves single BET unchanged', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].verdict, 'BET');
  });

  it('downgrades second BET when opposite sides conflict', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_bouncy',
        clvProxyPct: -3,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    const bet = plays.filter((p) => p.verdict === 'BET');
    assert.equal(bet.length, 1, 'only one BET should remain');
    assert.equal(bet[0].selection, 'Djokovic', 'clean movement should win');
    const consider = plays.find((p) => p.verdict === 'CONSIDER');
    assert.ok(consider.conflictResolved, 'loser should be flagged');
    assert.ok(consider.conflictNote, 'loser should have a conflict note');
  });

  it('does not interfere with different gameIds', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g2',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 2.5,
        selection: 'Swiatek'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 2);
  });

  it('does not interfere with different markets', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Game Handicap',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 2.5,
        selection: 'Djokovic -1.5'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 2);
  });

  it('ignores CONSIDER plays when counting conflicts', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'CONSIDER',
        movementDisposition: 'adverse_recent',
        clvProxyPct: -1,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 1);
    assert.equal(plays[0].verdict, 'BET');
  });

  it('prefers supportive_clean over supportive_bouncy', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_bouncy',
        clvProxyPct: 5,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    const bet = plays.find((p) => p.verdict === 'BET');
    assert.equal(bet.selection, 'Alcaraz', 'clean should win over bouncy even with lower CLV');
  });
});
