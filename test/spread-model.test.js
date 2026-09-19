'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  homeLine,
  marginRate,
  modelMargin,
  buildWalkForwardMarginRows,
  settleSpread,
  fitMarginCoefficients,
  marginError,
  simulateSpreadBets,
  assertSpreadConvention
} = require('../lib/spread-model');

describe('homeLine', () => {
  it('converts ESPN home-perspective spread to the number home must win by', () => {
    // ESPN reports `spread: -37` for "AUB -37": home is favoured by 37, so home must win by 37.
    assert.equal(homeLine(-37), 37);
    assert.equal(homeLine(13.5), -13.5);
    assert.equal(homeLine(0), 0);
  });

  it('returns null for unusable input rather than a fabricated line', () => {
    assert.equal(homeLine(null), null);
    assert.equal(homeLine(undefined), null);
    assert.equal(homeLine('abc'), null);
  });
});

describe('marginRate', () => {
  it('returns null below the minimum games', () => {
    assert.equal(marginRate(100, 80, 2, { minGames: 3 }), null);
  });

  it('is points for minus points against, per game', () => {
    assert.equal(marginRate(300, 200, 10), 10);
    assert.equal(marginRate(200, 300, 10), -10);
  });
});

describe('modelMargin', () => {
  it('scales the margin difference by k and adds home field', () => {
    assert.equal(modelMargin({ homeMarginRate: 10, awayMarginRate: 0 }, { k: 0.5, hfa: 3 }), 8);
  });

  it('returns null when either team rate is unknown', () => {
    assert.equal(modelMargin({ homeMarginRate: null, awayMarginRate: 1 }, { k: 1, hfa: 3 }), null);
    assert.equal(modelMargin(null, { k: 1, hfa: 3 }), null);
  });
});

describe('settleSpread', () => {
  const row = (margin, line) => ({ margin, line });

  it('settles home and away sides correctly', () => {
    assert.equal(settleSpread(row(10, 7), 'home'), 'win', 'home wins by 10, laid 7');
    assert.equal(settleSpread(row(10, 7), 'away'), 'loss');
    assert.equal(settleSpread(row(3, 7), 'away'), 'win', 'away loses by 3, getting 7');
    assert.equal(settleSpread(row(3, 7), 'home'), 'loss');
  });

  it('returns push on an exact landing, and null when there is no line', () => {
    assert.equal(settleSpread(row(7, 7), 'home'), 'push');
    assert.equal(settleSpread(row(7, 7), 'away'), 'push');
    assert.equal(settleSpread({ margin: 7, line: null }, 'home'), null);
  });
});

describe('buildWalkForwardMarginRows', () => {
  const games = [
    {
      startDate: '2025-08-30T18:00:00Z',
      home: { id: 'H', name: 'Home', score: 31 },
      away: { id: 'A', name: 'Away', score: 10 },
      odds: { spread: -21, homeSpreadOdds: -110, awaySpreadOdds: -110 }
    },
    {
      startDate: '2025-09-06T18:00:00Z',
      home: { id: 'A', name: 'Away', score: 24 },
      away: { id: 'H', name: 'Home', score: 20 },
      odds: { spread: 3.5, homeSpreadOdds: -108, awaySpreadOdds: -112 }
    }
  ];

  it("does NOT leak a game's own result into its own features", () => {
    const rows = buildWalkForwardMarginRows(games, { minGames: 1 });
    assert.equal(rows[0].homeMarginRate, null, 'first game has no prior information');
    assert.equal(rows[0].awayMarginRate, null);
    // Game 2 must reflect ONLY game 1 (H won by 21, A lost by 21), never its own 24-20.
    assert.equal(rows[1].awayMarginRate, 21, 'H margin rate after game 1');
    assert.equal(rows[1].homeMarginRate, -21, 'A margin rate after game 1');
  });

  it('records the margin and the home line with the right sign', () => {
    const rows = buildWalkForwardMarginRows(games, { minGames: 1 });
    assert.equal(rows[0].margin, 21);
    assert.equal(rows[0].line, 21, 'spread -21 => home must win by 21');
    assert.equal(rows[1].line, -3.5);
  });

  it('sorts chronologically regardless of input order', () => {
    const rows = buildWalkForwardMarginRows([games[1], games[0]], { minGames: 1 });
    assert.equal(rows[0].startDate, games[0].startDate);
  });
});

describe('fitMarginCoefficients', () => {
  it('fits on the rows given and reports a finite MSE', () => {
    const games = [];
    for (let i = 0; i < 200; i++) {
      const strongHome = i % 2 === 0;
      games.push({
        startDate: new Date(Date.UTC(2025, 7, 1 + i)).toISOString(),
        home: { id: 'H', name: 'Home', score: strongHome ? 34 : 17 },
        away: { id: 'A', name: 'Away', score: strongHome ? 17 : 34 },
        odds: { spread: strongHome ? -10 : 10, homeSpreadOdds: -110, awaySpreadOdds: -110 }
      });
    }
    const rows = buildWalkForwardMarginRows(games, { minGames: 2 });
    const fit = fitMarginCoefficients(rows);
    assert.ok(fit, 'should fit');
    assert.ok(Number.isFinite(fit.mse));
    assert.ok(fit.k >= 0.2 && fit.k <= 1.4);
  });

  it('returns null when there is nothing to fit', () => {
    assert.equal(fitMarginCoefficients([]), null);
  });
});

describe('marginError', () => {
  it('reports MAE and bias against the actual margin', () => {
    const rows = [
      { line: 7, margin: 10 },
      { line: 3, margin: 0 }
    ];
    const e = marginError(rows, () => 7);
    assert.equal(e.n, 2);
    assert.equal(e.mae, 5); // (|7-10| + |7-0|) / 2 = (3 + 7) / 2
    assert.equal(e.bias, 2); // ((7-10) + (7-0)) / 2
  });
});

describe('simulateSpreadBets', () => {
  it('places no bets when the model agrees with the line', () => {
    const rows = [{ line: 7, margin: 10, homeSpreadOdds: -110, awaySpreadOdds: -110 }];
    const s = simulateSpreadBets(rows, () => 7, { threshold: 3 });
    assert.equal(s.n, 0);
  });

  it('settles winners, losers and pushes at the quoted price', () => {
    const rows = [
      { line: 7, margin: 14, homeSpreadOdds: -110, awaySpreadOdds: -110 },
      { line: 7, margin: 0, homeSpreadOdds: -110, awaySpreadOdds: -110 },
      { line: 7, margin: 7, homeSpreadOdds: -110, awaySpreadOdds: -110 }
    ];
    const s = simulateSpreadBets(rows, () => 12, { threshold: 3 });
    assert.equal(s.n, 3);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assert.equal(s.pushes, 1);
    // push contributes 0, so P&L is 0.909 - 1 = -0.0909
    assert.ok(Math.abs(s.pnl + 0.0909) < 0.001, `pnl was ${s.pnl}`);
  });

  it('skips games with no line and, when required, no price', () => {
    const rows = [{ line: null, margin: 5, homeSpreadOdds: -110 }];
    assert.equal(simulateSpreadBets(rows, () => 20, { threshold: 3 }).n, 0);
    const noPrice = [{ line: 7, margin: 14, homeSpreadOdds: null, awaySpreadOdds: null }];
    assert.equal(simulateSpreadBets(noPrice, () => 12, { threshold: 3 }).n, 0);
  });
});

describe('assertSpreadConvention', () => {
  it('flags a home-perspective line as correct', () => {
    const rows = [];
    // Construct a market where the line tracks the margin and home covers ~half the time.
    for (let i = 0; i < 200; i++) {
      const margin = (i % 20) - 10; // -10..9, symmetric
      rows.push({ line: margin + (i % 2 === 0 ? 1 : -1), margin });
    }
    const r = assertSpreadConvention(rows);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.homeCovers - 0.5) < 0.1);
    assert.ok(r.corr > 0.2);
  });

  it('refuses to judge too few rows', () => {
    assert.equal(assertSpreadConvention([{ line: 1, margin: 2 }]).ok, null);
  });
});
