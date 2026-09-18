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

// Every field that must survive from the mapper to the recorder.
//
// These are the fields where a silent drop is indistinguishable from a legitimately
// absent value, so the ledger would read `null` forever while looking implemented.
const LEDGER_BOUND_FIELDS = [
  'marketFairProbability',
  'sharpMarketFairProbability',
  'sharpFairBookCount',
  'bestAvailableOdds',
  'arbMarginPct',
  'executionQuality'
];

const row = () => ({
  league: 'MLB',
  market: 'Moneyline',
  selection: 'Yankees',
  selection1: 'Yankees',
  selection2: 'Red Sox',
  book: 'FanDuel',
  odds: -120,
  bestAvailableOdds: -105,
  // null is the healthy case: a normal market's implied probabilities sum above 1.
  arbMarginPct: null,
  executionQuality: 'playable',
  allBookOdds: {
    Pinnacle: { odds1: -120, odds2: 100 },
    Circa: { odds1: -118, odds2: 98 },
    // A deliberately soft book, used to prove the all-books fair moves while the
    // sharp-anchored one does not. Priced so this fixture is NOT an arbitrage: the best
    // side-1 (-118) plus the best side-2 (+110) sum ABOVE 1, which is the healthy case.
    SomeSquareBook: { odds1: -145, odds2: 110 }
  }
});

describe('fair anchor fields survive every whitelist layer', () => {
  it('every ledger-bound field is in the formatter keep-set', () => {
    // Losing one of these is SILENT: the ledger records null, which is
    // indistinguishable from a legitimately absent value.
    for (const field of LEDGER_BOUND_FIELDS) {
      assert.ok(
        STANDARD_KEEP_FIELDS.has(field),
        `${field} is missing from STANDARD_KEEP_FIELDS — it will be dropped before the recorder sees it`
      );
    }
  });

  it('the mapper emits all of them', () => {
    const mapped = mapCandidateRow(row());
    for (const field of LEDGER_BOUND_FIELDS) {
      assert.ok(field in mapped, `mapper does not emit ${field}`);
    }
  });

  it('the mapper emits real values for the number-bearing fields', () => {
    const mapped = mapCandidateRow(row());
    assert.ok(Number.isFinite(mapped.sharpMarketFairProbability));
    assert.equal(mapped.sharpFairBookCount, 2, 'only Pinnacle and Circa are sharp here');
    // bestAvailableOdds must be carried as a NUMBER, not stringified and not dropped:
    // it is the only record of what price was available, and therefore the only way
    // to measure the shopping gap at all.
    assert.equal(mapped.bestAvailableOdds, -105);
    assert.equal(mapped.executionQuality, 'playable');
    // A null arb margin must survive as null, NOT be dropped: the keep-set assertion
    // above covers presence, and this covers the value path.
    assert.equal(mapped.arbMarginPct, null);
  });

  it('carries a non-null arb margin when the row is arbitrageable', () => {
    const arbRow = {
      ...row(),
      allBookOdds: { BookA: { odds1: 120, odds2: -140 }, BookB: { odds1: -140, odds2: 120 } }
    };
    const mapped = mapCandidateRow(arbRow);
    assert.ok(mapped.arbMarginPct > 9 && mapped.arbMarginPct < 9.2, `got ${mapped.arbMarginPct}`);
  });

  it('a missing best available price stays null, never defaulted to the taken price', () => {
    // Defaulting it to `odds` would report a zero shopping gap that was never
    // observed — the worst outcome, because it reads as perfect execution.
    const withoutBest = { ...row(), bestAvailableOdds: undefined };
    assert.equal(mapCandidateRow(withoutBest).bestAvailableOdds, null);
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
