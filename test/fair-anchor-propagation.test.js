'use strict';

// Guard for the fair-anchor propagation trap.
//
// WHAT WENT WRONG, AND WHY THIS FILE EXISTS.
//
// `sharpMarketFairProbability` was computed correctly in the candidate mapper and
// still reached the ledger as null on all 120 freshly recorded candidates. The scan
// pipeline whitelists fields across several layers — mapper, formatter keep-set,
// recorder — and a layer that does not know a field silently drops it. The failure is
// invisible: a dropped field and a legitimately-null field look identical in the
// ledger, so the sharp anchor could have read as "no data" forever while looking
// implemented.
//
// The mapper computes the value, so asserting only on the mapper proves nothing. These
// tests assert on the KEEP-SET boundary, which is where it was actually lost.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { STANDARD_KEEP_FIELDS } = require('../lib/ssb-formatter');
const { mapCandidateRow } = require('../lib/ssb-mcp-candidate-mapper');
const { sharpFairProbabilityForRow } = require('../lib/screen-fair-probability');

// Every fair-anchor field that must survive from the mapper to the recorder.
const FAIR_ANCHOR_FIELDS = ['marketFairProbability', 'sharpMarketFairProbability', 'sharpFairBookCount'];

const row = () => ({
  league: 'MLB',
  market: 'Moneyline',
  selection: 'Yankees',
  selection1: 'Yankees',
  selection2: 'Red Sox',
  book: 'FanDuel',
  odds: -120,
  allBookOdds: {
    Pinnacle: { odds1: -120, odds2: 100 },
    Circa: { odds1: -118, odds2: 98 },
    SomeSquareBook: { odds1: -140, odds2: 120 }
  }
});

describe('fair anchor fields survive every whitelist layer', () => {
  it('every fair-anchor field is in the formatter keep-set', () => {
    // Losing one of these is SILENT: the ledger records null, which is
    // indistinguishable from a legitimately absent value.
    for (const field of FAIR_ANCHOR_FIELDS) {
      assert.ok(
        STANDARD_KEEP_FIELDS.has(field),
        `${field} is missing from STANDARD_KEEP_FIELDS — it will be dropped before the recorder sees it`
      );
    }
  });

  it('the mapper emits all three, with a real sharp value', () => {
    const mapped = mapCandidateRow(row());
    for (const field of FAIR_ANCHOR_FIELDS) {
      assert.ok(field in mapped, `mapper does not emit ${field}`);
    }
    assert.ok(Number.isFinite(mapped.sharpMarketFairProbability));
    assert.equal(mapped.sharpFairBookCount, 2, 'only Pinnacle and Circa are sharp here');
  });

  it('the sharp fair is not a copy of the all-books fair', () => {
    // If these ever became equal the sharp anchor would be a silent no-op: it would
    // look implemented while measuring exactly the thing it exists to replace.
    const mapped = mapCandidateRow(row());
    assert.notEqual(mapped.sharpMarketFairProbability, mapped.marketFairProbability);
  });

  it('sharpFairProbabilityForRow agrees with the mapper value', () => {
    const input = row();
    assert.equal(sharpFairProbabilityForRow(input), mapCandidateRow(input).sharpMarketFairProbability);
  });
});
