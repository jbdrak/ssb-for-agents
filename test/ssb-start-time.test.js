'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseGameStartMs } = require('../lib/ssb-shared-utils');

describe('parseGameStartMs', () => {
  it('handles epoch seconds (MLB/WNBA format)', () => {
    assert.equal(parseGameStartMs(1783464000), 1783464000000);
  });

  it('handles epoch milliseconds', () => {
    assert.equal(parseGameStartMs(1783464000000), 1783464000000);
  });

  it('handles ISO string', () => {
    const expected = new Date('2026-07-08T02:00:00.000Z').getTime();
    assert.equal(parseGameStartMs('2026-07-08T02:00:00.000Z'), expected);
  });

  it('handles numeric string (epoch seconds)', () => {
    assert.equal(parseGameStartMs('1783464000'), 1783464000000);
  });

  it('handles numeric string (epoch milliseconds)', () => {
    assert.equal(parseGameStartMs('1783464000000'), 1783464000000);
  });

  it('returns null for null', () => {
    assert.equal(parseGameStartMs(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(parseGameStartMs(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseGameStartMs(''), null);
  });

  it('returns null for NaN', () => {
    assert.equal(parseGameStartMs(NaN), null);
  });

  it('returns null for whitespace string', () => {
    assert.equal(parseGameStartMs('   '), null);
  });

  it('handles Date objects', () => {
    const d = new Date('2026-07-08T02:00:00.000Z');
    assert.equal(parseGameStartMs(d), d.getTime());
  });

  it('handles Infinity by returning null', () => {
    assert.equal(parseGameStartMs(Infinity), null);
  });

  it('returns null for unparseable string', () => {
    assert.equal(parseGameStartMs('not-a-date'), null);
  });

  it('refuses a year-less display string instead of inventing year 2001', () => {
    // The CLI's own `startCST` display field is exactly this shape. V8 parses
    // `Wed, Sep 16, 1:30 PM CDT` to 1000665000000 (2001-09-16): a FINITE but
    // wrong instant, which silently PASSES a recency comparison instead of
    // refusing. Without an explicit year there is no correct answer, so the
    // only safe result is null.
    assert.equal(parseGameStartMs('Wed, Sep 16, 1:30 PM CT'), null);
    assert.equal(parseGameStartMs('Wed, Sep 16, 1:30 PM CDT'), null);
    assert.equal(parseGameStartMs('Wed, Sep 16, 1:30 PM CST'), null);
    assert.equal(parseGameStartMs('Wed, Sep 16, 8:40 PM CT'), null);
    assert.equal(parseGameStartMs('Thu, Jul 9, 7:00 AM'), null);
    // Guard against the specific wrong-but-finite value, so a regression that
    // re-enables the implied-year parse cannot slip through as "still a number".
    assert.notEqual(parseGameStartMs('Wed, Sep 16, 1:30 PM CDT'), 1000665000000);
  });

  it('still parses a date string that carries an explicit year', () => {
    assert.equal(parseGameStartMs('2026-09-16T13:30:00-05:00'), Date.parse('2026-09-16T13:30:00-05:00'));
    assert.equal(parseGameStartMs('Sep 16, 2026 1:30 PM'), Date.parse('Sep 16, 2026 1:30 PM'));
  });

  it('passes through small numbers unchanged (not timestamps)', () => {
    assert.equal(parseGameStartMs(42), 42);
    assert.equal(parseGameStartMs(0), 0);
    assert.equal(parseGameStartMs(100), 100);
    assert.equal(parseGameStartMs(1.5), 1.5);
  });

  it('passes through small numeric strings unchanged', () => {
    assert.equal(parseGameStartMs('42'), 42);
    assert.equal(parseGameStartMs('100'), 100);
  });
});
