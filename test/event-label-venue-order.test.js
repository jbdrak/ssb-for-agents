'use strict';

/**
 * Regression: venue order is never asserted from an unverified feed field.
 *
 * The MLB/NFL feed returns homeTeam/awayTeam that are null for some games and
 * inverted for others. Verified 2026-09-13: gameId
 * `MLB:GAME:Colorado_Rockies:Detroit_Tigers` rendered as
 * "Detroit Tigers @ Colorado Rockies" for a game played at Comerica Park, and
 * `MLB:GAME:Los_Angeles_Dodgers:Miami_Marlins` was inverted the same way.
 * A wrong `away @ home` label corrupts handicap interpretation even when the
 * selection and price are right, so absence of a verified venue marker must
 * fail closed to a neutral matchup label.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatEventLabel } = require('../lib/soccer-event-identity');

describe('formatEventLabel venue-order rule', () => {
  it('does not claim venue order when the marker is absent', () => {
    const label = formatEventLabel({
      league: 'MLB',
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Colorado Rockies',
      game: 'Colorado Rockies vs Detroit Tigers'
    });
    assert.ok(!label.includes('@'), `expected a neutral label, got: ${label}`);
    assert.ok(label.includes('Colorado Rockies'));
  });

  it('does not claim venue order when the marker is explicitly false', () => {
    const label = formatEventLabel({
      league: 'NFL',
      venueOrderVerified: false,
      homeTeam: 'Indianapolis Colts',
      awayTeam: 'Baltimore Ravens'
    });
    assert.ok(!label.includes('@'), `expected a neutral label, got: ${label}`);
  });

  it('uses away @ home only when the row carries a verified marker', () => {
    const label = formatEventLabel({
      league: 'NFL',
      venueOrderVerified: true,
      homeTeam: 'Minnesota Vikings',
      awayTeam: 'Green Bay Packers'
    });
    assert.equal(label, 'Green Bay Packers @ Minnesota Vikings');
  });

  it('keeps the soccer unverified wording', () => {
    const label = formatEventLabel({ league: 'Soccer', homeTeam: 'Getafe', awayTeam: 'Deportivo' });
    assert.ok(label.includes('unverified'));
    assert.ok(!label.includes('@'));
  });

  it('falls back to a neutral placeholder when nothing is known', () => {
    assert.equal(formatEventLabel({}), '(home/away unverified)');
  });
});
