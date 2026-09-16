'use strict';

/**
 * `pp today` runs the widest aggregate fan-out in the CLI (~35 league×market
 * pairs). At the full aggregate odds-history allocation the serial gate
 * congests, pairs abort, and the composite both loses rows and takes ~5x
 * longer, so the composite passes a smaller allocation. Pin both the override
 * and the unchanged default.
 */

const test = require('node:test');
const assert = require('node:assert');

const { getAggregateGameBudget } = require('../lib/ssb-sharp-plays-service');

test('aggregate game budget honours an explicit allocation override', () => {
  assert.equal(getAggregateGameBudget(15, 300), 20);
});

test('aggregate game budget keeps the full share when no override is given', () => {
  assert.equal(getAggregateGameBudget(15), 80);
});

test('aggregate game budget never drops below one game per pair', () => {
  assert.equal(getAggregateGameBudget(200, 90), 1);
});
