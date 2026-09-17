'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const close = require('../lib/record-close');

const NOW = Date.parse('2026-09-17T20:00:00.000Z');
const at = (minutes) => new Date(NOW + minutes * 60 * 1000).toISOString();

function candidate(overrides = {}) {
  return {
    candidateId: 'c1',
    gameId: null,
    league: 'NCAAF',
    game: 'Purdue vs UCLA',
    market: 'Total Points',
    selection: 'Under 52.5',
    odds: '49.0%',
    start: at(10),
    featureSnapshot: {},
    ...overrides
  };
}

function ledgerWith(candidates) {
  return { version: 2, scans: [], candidates, bets: [], settlements: [] };
}

describe('record-close: target selection', () => {
  it('requires a clock', () => {
    assert.throws(() => close.selectCloseTargets(ledgerWith([]), {}), TypeError);
  });

  it('selects a candidate inside the window as a pregame close', () => {
    const result = close.selectCloseTargets(ledgerWith([candidate()]), { nowMs: NOW });
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].closeKind, 'pregame');
    assert.equal(result.totals.due, 1);
  });

  it('labels a capture taken after the start as post_start, not a close', () => {
    const result = close.selectCloseTargets(ledgerWith([candidate({ start: at(-2) })]), { nowMs: NOW });
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].closeKind, 'post_start');
  });

  it('excludes candidates that are not due, too late, undated, or unidentifiable', () => {
    const rows = [
      candidate({ candidateId: 'far', start: at(120) }),
      candidate({ candidateId: 'gone', start: at(-60) }),
      candidate({ candidateId: 'undated', start: null, startCST: 'Sat, Sep 12, 6:15 PM CT' }),
      candidate({ candidateId: 'anon', gameId: null, league: null, game: null })
    ];
    const result = close.selectCloseTargets(ledgerWith(rows), { nowMs: NOW });
    assert.equal(result.targets.length, 0);
    assert.deepEqual(result.excluded, {
      already_captured: 0,
      undated: 1,
      missing_identity: 1,
      not_due: 1,
      too_late: 1
    });
  });

  it('accepts a gameId as identity when the game string is absent', () => {
    const result = close.selectCloseTargets(
      ledgerWith([candidate({ gameId: 'NCAAF:PREMATCH:Purdue:UCLA:1', game: null, league: null })]),
      { nowMs: NOW }
    );
    assert.equal(result.targets.length, 1);
  });

  it('skips already-captured rows unless forced', () => {
    const captured = candidate({ closeOdds: -110, closeIsPrice: true });
    assert.equal(close.selectCloseTargets(ledgerWith([captured]), { nowMs: NOW }).targets.length, 0);
    assert.equal(close.selectCloseTargets(ledgerWith([captured]), { nowMs: NOW }).excluded.already_captured, 1);
    // A probability-only close still counts as captured.
    const implied = candidate({ closeImpliedProbability: 0.49 });
    assert.equal(close.selectCloseTargets(ledgerWith([implied]), { nowMs: NOW }).excluded.already_captured, 1);
    assert.equal(close.selectCloseTargets(ledgerWith([captured]), { nowMs: NOW, force: true }).targets.length, 1);
  });

  it('honours a custom window', () => {
    const rows = [candidate({ start: at(45) })];
    assert.equal(close.selectCloseTargets(ledgerWith(rows), { nowMs: NOW, windowMinutes: 30 }).targets.length, 0);
    assert.equal(close.selectCloseTargets(ledgerWith(rows), { nowMs: NOW, windowMinutes: 60 }).targets.length, 1);
  });
});

describe('record-close: applying a close', () => {
  it('stamps a numeric American close and keeps the decision identity intact', () => {
    const row = candidate();
    const before = row.candidateId;
    const target = { candidate: row, closeKind: 'pregame' };
    const result = close.applyClose(
      target,
      { odds: -110, fairProbability: 0.524, book: 'NoVigApp' },
      {
        capturedAt: '2026-09-17T20:00:00.000Z'
      }
    );
    assert.equal(result.ok, true);
    assert.equal(row.closeOdds, -110);
    assert.equal(row.closeIsPrice, true);
    assert.equal(row.closeImpliedProbability, null);
    assert.equal(row.closeFairProbability, 0.524);
    assert.equal(row.closeKind, 'pregame');
    assert.equal(row.closeBook, 'NoVigApp');
    // The decision-time id is the join key for record-card and must never move.
    assert.equal(row.candidateId, before);
  });

  it('stores a NoVig display percent as an implied probability, never as a price', () => {
    const row = candidate();
    const result = close.applyClose({ candidate: row, closeKind: 'pregame' }, { odds: '49.0%' });
    assert.equal(result.ok, true);
    assert.equal(row.closeOdds, null);
    assert.equal(row.closeImpliedProbability, 0.49);
    assert.equal(row.closeIsPrice, false);
    assert.equal(row.closeOddsFormat, 'implied_pct');
  });

  it('refuses an unparseable close instead of inventing one', () => {
    const row = candidate();
    const result = close.applyClose({ candidate: row, closeKind: 'pregame' }, { odds: 'pending' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'close_not_a_price');
    assert.equal(row.closeOdds, undefined);
  });

  it('clears a stale fair probability when the new quote carries none', () => {
    const row = candidate({ closeFairProbability: 0.6 });
    close.applyClose({ candidate: row, closeKind: 'pregame' }, { odds: -110 });
    assert.equal(row.closeFairProbability, null);
  });

  it('rejects a missing candidate or close', () => {
    assert.equal(close.applyClose({}, { odds: -110 }).reason, 'no_candidate');
    assert.equal(close.applyClose({ candidate: candidate() }, null).reason, 'no_close');
  });

  it('stamps real close-relative CLV, and never a proxy', () => {
    const priced = candidate({ odds: -127 });
    close.applyClose({ candidate: priced, closeKind: 'pregame' }, { odds: -118 });
    assert.ok(typeof priced.clvPct === 'number' && priced.clvPct > 1.8, `got ${priced.clvPct}`);
    assert.equal(priced.clvReason, null);

    // A legacy decision price carrying only an implied probability still yields
    // CLV (the same quantity on both sides), but an unusable one does not.
    const legacy = candidate({ odds: '49.0%' });
    close.applyClose({ candidate: legacy, closeKind: 'pregame' }, { odds: -118 });
    assert.ok(typeof legacy.clvPct === 'number' && legacy.clvPct < 0, `got ${legacy.clvPct}`);

    const unusable = candidate({ odds: null });
    close.applyClose({ candidate: unusable, closeKind: 'pregame' }, { odds: -118 });
    assert.equal(unusable.clvPct, null);
    assert.equal(unusable.clvReason, 'decision_price_not_a_price');
  });
});

describe('record-close: summary', () => {
  it('counts captured closes by kind and by what they actually are', () => {
    const rows = [
      candidate({ closeOdds: -110, closeIsPrice: true, closeKind: 'pregame' }),
      candidate({ closeImpliedProbability: 0.49, closeIsPrice: false, closeKind: 'post_start' }),
      candidate({ start: null, startCST: 'Sat, Sep 12, 6:15 PM CT' }),
      candidate()
    ];
    const summary = close.summarizeCloses(ledgerWith(rows));
    assert.equal(summary.candidates, 4);
    assert.equal(summary.captured, 2);
    assert.equal(summary.asPrice, 1);
    assert.equal(summary.asImpliedProbability, 1);
    assert.equal(summary.pregame, 1);
    assert.equal(summary.post_start, 1);
    assert.equal(summary.withoutStart, 1);
  });
});
