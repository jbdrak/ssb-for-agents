'use strict';

/**
 * Regression: tennis-fallback play rows must populate the documented `movement`
 * field.
 *
 * Normal ranked rows ship both `movement` and `movementDisposition`. The
 * fallback path (lib/tennis-fallback.js createFallbackPlay) only emitted
 * movementDisposition, so fallback rows shipped `movement: null` while carrying
 * a real disposition. Any consumer filtering on `movement` — the field the CLI
 * documents — saw null and mis-classified every fallback row. The CLI's `-M`
 * filter read movementDisposition and worked, which is why the inconsistency
 * only showed up in the emitted JSON.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFallbackPlay } = require('../lib/tennis-fallback');

const BASE = {
  game: {
    gameId: 'Tennis:GAME:Zverev:Shelton:1789300800',
    awayTeam: 'Zverev',
    homeTeam: 'Shelton',
    start: '2026-09-13T18:00:00Z'
  },
  market: 'Moneyline',
  selection: { selection1: 'Zverev', selection2: 'Shelton' },
  side: 1,
  selectionId: 'Moneyline:Zverev',
  odds: 120,
  book: 'Fliff',
  clv: 1.2,
  bookCount: 4,
  clvSource: 'Pinnacle',
  movementDisposition: 'supportive_clean',
  movementLabel: 'supportive'
};

describe('createFallbackPlay movement field', () => {
  it('mirrors a supportive disposition onto `movement`', () => {
    const play = createFallbackPlay(BASE);
    assert.equal(play.movementDisposition, 'supportive_clean');
    assert.equal(play.movement, 'supportive_clean');
  });

  it('mirrors an adverse disposition onto `movement`', () => {
    const play = createFallbackPlay({ ...BASE, movementDisposition: 'adverse_full' });
    assert.equal(play.movement, 'adverse_full');
  });

  it('mirrors insufficient when history was unavailable', () => {
    const play = createFallbackPlay({ ...BASE, clv: null, movementDisposition: 'insufficient' });
    assert.equal(play.movement, 'insufficient');
  });

  it('never emits movement: null', () => {
    for (const disposition of ['supportive_clean', 'supportive_bouncy', 'adverse_recent', 'insufficient']) {
      const play = createFallbackPlay({ ...BASE, movementDisposition: disposition });
      assert.equal(play.movement, disposition);
      assert.notEqual(play.movement, null);
    }
  });
});
