'use strict';

// Coverage for the weekly evidence loop's selection rule. The rest of the script
// is I/O (refresh, ESPN fetch, the gate call) and is proven by driving the real
// entrypoint; what can silently mislead is WHICH weeks it decides are scoreable,
// so that is what is pinned here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { eligibleWeeks, stampOf } = require('../scripts/ratings-weekly-evidence');
const { addDays } = require('../scripts/resolve-ratings-outcomes');

const today = () => new Date().toISOString().slice(0, 10);

function week(overrides = {}) {
  return {
    valid: true,
    source: 'sagarin',
    league: 'NCAAF',
    season: 2026,
    asOf: `${addDays(today(), -7)}T00:00:00.000Z`,
    stamp: addDays(today(), -7),
    ...overrides
  };
}

describe('ratings-weekly-evidence: which weeks are scoreable', () => {
  it('takes a week that is old enough to have been played', () => {
    const selected = eligibleWeeks([week()]);
    assert.equal(selected.length, 1);
  });

  it('refuses a week whose games may not have finished', () => {
    // Yesterday's slate can still be in progress, so its result is not evidence.
    assert.deepEqual(eligibleWeeks([week({ asOf: `${addDays(today(), -1)}T00:00:00.000Z` })]), []);
    assert.deepEqual(eligibleWeeks([week({ asOf: `${today()}T00:00:00.000Z` })]), []);
  });

  it('drops a week too old to settle anything new', () => {
    assert.deepEqual(eligibleWeeks([week({ asOf: `${addDays(today(), -60)}T00:00:00.000Z` })]), []);
  });

  it('ignores another league, a source it does not run, and an invalid entry', () => {
    assert.deepEqual(eligibleWeeks([week({ league: 'NFL' })]), []);
    assert.deepEqual(eligibleWeeks([week({ source: 'tennis_elo' })]), []);
    assert.deepEqual(eligibleWeeks([week({ valid: false })]), []);
  });

  it('returns the newest week first, and reads a plain-date asOf as well as a timestamp', () => {
    const older = week({ asOf: `${addDays(today(), -20)}T00:00:00.000Z`, source: 'massey' });
    const newer = week({ asOf: addDays(today(), -5), source: 'sagarin' });
    const selected = eligibleWeeks([older, newer]);
    assert.deepEqual(
      selected.map((entry) => entry.source),
      ['sagarin', 'massey']
    );
    assert.equal(stampOf(newer), addDays(today(), -5));
    assert.equal(stampOf(older), addDays(today(), -20));
  });
});
