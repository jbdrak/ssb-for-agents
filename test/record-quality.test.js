'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../lib/record-quality');

describe('record-quality: price classification', () => {
  it('classifies an American price number', () => {
    const c = quality.classifyPrice(-135);
    assert.equal(c.ok, true);
    assert.equal(c.format, 'american');
    assert.equal(c.american, -135);
    assert.equal(c.impliedProbability, null);
  });

  it('classifies a positive American price number', () => {
    assert.equal(quality.classifyPrice(150).american, 150);
  });

  it('classifies an American odds string', () => {
    assert.equal(quality.classifyPrice('+150').american, 150);
    assert.equal(quality.classifyPrice('-110').american, -110);
  });

  it('classifies a NoVig display percent as an implied probability, never a price', () => {
    const c = quality.classifyPrice('49.0%');
    assert.equal(c.ok, true);
    assert.equal(c.format, 'implied_pct');
    assert.equal(c.impliedProbability, 0.49);
    assert.equal(c.american, null);
    assert.equal(c.decimal, null);
  });

  it('classifies a decimal price', () => {
    assert.equal(quality.classifyPrice('1.91').decimal, 1.91);
    assert.equal(quality.classifyPrice(1.91).decimal, 1.91);
  });

  it('refuses values that are not a price', () => {
    for (const value of [null, undefined, '', '   ', 'pending', {}, [], 0, NaN, '0%']) {
      const c = quality.classifyPrice(value);
      assert.equal(c.ok, false, `expected ${JSON.stringify(value)} to be unparseable`);
      assert.equal(c.format, 'unparseable');
    }
  });

  it('separates priced odds from probability-only odds', () => {
    assert.equal(quality.isPricedOdds(-110), true);
    assert.equal(quality.isPricedOdds('49.0%'), false);
    assert.equal(quality.isPricedOdds(null), false);
  });
});

describe('record-quality: implied fraction and beat-the-close', () => {
  it('converts a price to its vigged implied probability', () => {
    assert.equal(quality.impliedFraction(-100), 0.5);
    assert.equal(quality.impliedFraction(100), 0.5);
    assert.equal(quality.impliedFraction(-200), 2 / 3);
    assert.equal(quality.impliedFraction('1.91'), 1 / 1.91);
    assert.equal(quality.impliedFraction('49.0%'), 0.49);
    assert.equal(quality.impliedFraction(null), null);
    assert.equal(quality.impliedFraction('pending'), null);
  });

  it('computes positive CLV when the price taken beat the close', () => {
    // -127 taken, market closed -118: we hold the better number.
    const result = quality.beatTheClose(-127, -118);
    assert.equal(result.ok, true);
    assert.ok(result.clvPct > 1.8 && result.clvPct < 1.83, `unexpected clvPct ${result.clvPct}`);
  });

  it('computes negative CLV when the market moved away from the price taken', () => {
    const result = quality.beatTheClose(-110, -125);
    assert.equal(result.ok, true);
    assert.ok(result.clvPct < 0, `expected a negative clvPct, got ${result.clvPct}`);
  });

  it('accepts a close supplied as an implied probability', () => {
    const result = quality.beatTheClose(-127, 0.5413);
    assert.equal(result.ok, true);
    assert.ok(result.clvPct > 1.7);
  });

  it('fails closed rather than falling back to a proxy', () => {
    // A decision price known only as an implied probability is still a usable
    // basis for CLV: it is the same quantity on both sides of the comparison.
    const fromProbability = quality.beatTheClose('49.0%', -118);
    assert.equal(fromProbability.ok, true);
    assert.ok(fromProbability.clvPct < 0);
    assert.equal(quality.beatTheClose(-127, null).reason, 'close_not_a_price');
    assert.equal(quality.beatTheClose(-127, 'pending').reason, 'close_not_a_price');
    assert.equal(quality.beatTheClose(-127, null).clvPct, null);
    assert.equal(quality.beatTheClose(null, -118).reason, 'decision_price_not_a_price');
  });
});

describe('record-quality: start resolution', () => {
  it('reads an ISO start', () => {
    const ms = quality.candidateStartMs({ start: '2026-09-19T23:30:00.000Z' });
    assert.equal(ms, Date.parse('2026-09-19T23:30:00.000Z'));
  });

  it('falls back to scheduledStart', () => {
    const ms = quality.candidateStartMs({ start: null, scheduledStart: '2026-09-19T23:30:00.000Z' });
    assert.equal(ms, Date.parse('2026-09-19T23:30:00.000Z'));
  });

  it('never parses the yearless display string', () => {
    assert.equal(quality.candidateStartMs({ start: null, startCST: 'Sat, Sep 12, 6:15 PM CT' }), null);
  });

  it('returns null for unusable starts', () => {
    assert.equal(quality.candidateStartMs({ start: 'not-a-date' }), null);
    assert.equal(quality.candidateStartMs({}), null);
    assert.equal(quality.candidateStartMs(null), null);
  });
});

describe('record-quality: ledger audit', () => {
  const ledger = {
    version: 2,
    scans: [{ id: 's1' }],
    candidates: [
      {
        candidateId: 'c1',
        gameId: null,
        league: 'NCAAF',
        game: 'Purdue vs UCLA',
        odds: '49.0%',
        start: '2026-09-19T23:30:00.000Z',
        featureSnapshot: { capturedAt: null, marketFairProbability: 0.51 }
      },
      {
        candidateId: 'c2',
        gameId: null,
        league: 'MLB',
        game: 'Brewers @ Pirates',
        odds: -127,
        start: null,
        startCST: 'Thu, Sep 17, 11:35 AM CT',
        featureSnapshot: { capturedAt: null }
      }
    ],
    bets: [
      { id: 'b1', status: 'win' },
      { id: 'b2', status: 'pending' }
    ],
    settlements: []
  };

  it('counts price formats and record gaps without repairing them', () => {
    const a = quality.auditLedger(ledger);
    assert.equal(a.candidates, 2);
    assert.equal(a.pricedCandidates, 1);
    assert.equal(a.priceFormats.implied_pct, 1);
    assert.equal(a.priceFormats.american, 1);
    assert.equal(a.issues.probability_not_price, 1);
    assert.equal(a.issues.missing_game_id, 2);
    assert.equal(a.issues.missing_start, 1);
    assert.equal(a.issues.missing_fair_probability, 1);
    assert.equal(a.issues.missing_capture_time, 2);
    assert.equal(a.candidatesWithStart, 1);
  });

  it('is not evaluable without a settlement, whatever else is present', () => {
    const a = quality.auditLedger(ledger);
    assert.equal(a.settledBets, 1);
    assert.equal(a.evaluable, true);
    assert.equal(quality.auditLedger({ ...ledger, bets: [] }).evaluable, false);
  });

  it('tolerates an empty or malformed ledger', () => {
    const a = quality.auditLedger({});
    assert.equal(a.candidates, 0);
    assert.equal(a.evaluable, false);
    assert.equal(a.closeCapturePossible, false);
  });
});
