'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cmdCard } = require('../bin/pp-cli');

function betRow(overrides = {}) {
  return {
    gameId: 'NCAAF:GAME:A:B:1788649200',
    game: 'A vs B',
    market: 'Point Spread',
    selection: 'A -7.5',
    odds: -110,
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    movementDisposition: 'supportive_clean',
    consensusBookCount: 10,
    start: '2026-09-05T23:00:00.000Z',
    startCT: 'Sat 6:00 PM CT',
    startsIn: 'in 3h',
    // A price that clears the gate's EV floor: 57% fair at -110 is +9.4% EV.
    // Fixtures without this are dropped as `no_price_reference`, which is the
    // gate working, so every card fixture that expects to print carries one.
    marketFairProbability: 0.57,
    ...overrides
  };
}

describe('pp card', () => {
  it('keeps BETs, drops started games, sorts by kickoff', async () => {
    const liveRow = betRow({
      gameId: 'NCAAF:GAME:C:D:1788645600',
      game: 'C vs D',
      selection: 'C ML',
      market: 'Moneyline',
      start: '2026-09-05T22:00:00.000Z',
      startsIn: 'in 2h'
    });
    const startedRow = betRow({ gameId: 'NCAAF:GAME:E:F:1', game: 'E vs F', startsIn: 'started' });
    const passRow = betRow({ gameId: 'NCAAF:GAME:G:H:1', game: 'G vs H', kaiCall: 'PASS' });
    let printed = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg) => {
      printed += String(msg) + '\n';
    };
    console.error = () => {};
    try {
      await cmdCard(
        {
          screen_ranked: async (args) => ({
            market: args.market,
            result: args.market === 'Moneyline' ? [liveRow] : [betRow(), startedRow, passRow]
          })
        },
        ['card', 'NCAAF'],
        { book: 'NoVigApp', json: false, limit: '10' }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    // Soonest kickoff (C vs D, 22:00) prints before the 23:00 game.
    const liveIdx = printed.indexOf('C ML');
    const spreadIdx = printed.indexOf('A -7.5');
    assert.ok(liveIdx !== -1 && spreadIdx !== -1, 'both BETs should print');
    assert.ok(liveIdx < spreadIdx, 'card must be kickoff-sorted');
    assert.ok(!printed.includes('E vs F'), 'started games must be dropped');
    assert.ok(!printed.includes('G vs H'), 'non-BET rows must be excluded');
  });

  it('emits JSON with counts when --json is passed', async () => {
    let json = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg) => {
      json += String(msg);
    };
    console.error = () => {};
    try {
      await cmdCard({ screen_ranked: async () => ({ result: [betRow()] }) }, ['card', 'NCAAF'], {
        book: 'NoVigApp',
        json: true
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed.card));
    assert.ok(parsed.card.length >= 1);
    assert.equal(parsed.book, 'NoVigApp');
  });

  it('drops every BET that offers no price evidence, and says so', async () => {
    let printed = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg) => {
      printed += String(msg) + '\n';
    };
    console.error = () => {};
    try {
      await cmdCard(
        { screen_ranked: async () => ({ result: [betRow({ marketFairProbability: null, consensusEdge: null })] }) },
        ['card', 'NCAAF'],
        { book: 'NoVigApp', json: false }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.ok(/failed the price gate/.test(printed), `expected a gate message, got: ${printed}`);
    assert.ok(!printed.includes('A -7.5'), 'a row with no price reference must not print as a BET');
  });

  it('drops a favourite priced on the wrong side of the market', async () => {
    let printed = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg) => {
      printed += String(msg) + '\n';
    };
    console.error = () => {};
    try {
      // 50% fair at -135: a losing bet, exactly the shape of the 2026-09-17 card.
      await cmdCard(
        { screen_ranked: async () => ({ result: [betRow({ odds: -135, marketFairProbability: 0.5 })] }) },
        ['card', 'NCAAF'],
        { book: 'NoVigApp', json: false }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.ok(!printed.includes('A -7.5'), 'a negative-EV favourite must not print as a BET');
  });

  it('still prints everything with --no-gate', async () => {
    let printed = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg) => {
      printed += String(msg) + '\n';
    };
    console.error = () => {};
    try {
      await cmdCard(
        { screen_ranked: async () => ({ result: [betRow({ marketFairProbability: null })] }) },
        ['card', 'NCAAF'],
        {
          book: 'NoVigApp',
          json: false,
          'no-gate': true
        }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.ok(printed.includes('A -7.5'), 'the gate must be bypassable for inspection');
    assert.ok(/gate disabled/.test(printed));
  });
});
