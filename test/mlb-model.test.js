'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  americanToProb,
  probToAmerican,
  devig,
  devigPrices,
  pythagoreanStrength,
  log5,
  modelProbability,
  buildWalkForwardRows,
  fitCoefficients,
  simulateBets,
  payout
} = require('../lib/mlb-model');

describe('odds conversion', () => {
  it('converts American prices to implied probability', () => {
    assert.equal(americanToProb(-150).toFixed(4), '0.6000');
    assert.equal(americanToProb(150).toFixed(4), '0.4000');
    assert.equal(americanToProb(-100).toFixed(4), '0.5000');
    assert.equal(americanToProb(100).toFixed(4), '0.5000');
  });

  it('accepts numeric strings, since ESPN returns them as strings', () => {
    assert.equal(americanToProb('-150'), americanToProb(-150));
    assert.equal(americanToProb('+125'), americanToProb(125));
  });

  it('returns null rather than a fabricated number for unusable input', () => {
    // ESPN serves `moneyLine: 0` for its "Live Odds" placeholder item. Treating that as a
    // real price would silently corrupt every downstream probability.
    assert.equal(americanToProb(0), null);
    assert.equal(americanToProb(null), null);
    assert.equal(americanToProb('abc'), null);
  });

  it('round-trips probability through American odds', () => {
    for (const p of [0.25, 0.4, 0.5, 0.6, 0.75]) {
      assert.ok(Math.abs(americanToProb(probToAmerican(p)) - p) < 0.01, `p=${p}`);
    }
  });

  it('payout returns profit excluding the returned stake', () => {
    assert.equal(payout(-110).toFixed(4), '0.9091');
    assert.equal(payout(150).toFixed(4), '1.5000');
  });
});

describe('de-vigging', () => {
  it('removes the hold and returns fair probabilities that sum to 1', () => {
    const d = devigPrices(-150, 130);
    assert.ok(d.home > 0.5);
    assert.ok(d.away < 0.5);
    assert.equal((d.home + d.away).toFixed(10), '1.0000000000');
    assert.ok(d.hold > 0.03 && d.hold < 0.05);
  });

  it('returns null for unusable input instead of a NaN', () => {
    assert.equal(devig(null, 0.4), null);
    assert.equal(devig(0.5, null), null);
    assert.equal(devigPrices(0, 0), null);
  });
});

describe('pythagoreanStrength', () => {
  it('returns null below the minimum games, so a 1-game sample cannot produce a 0 or 1', () => {
    assert.equal(pythagoreanStrength(5, 4, 1), null);
    assert.equal(pythagoreanStrength(500, 400, 9, { minGames: 10 }), null);
  });

  it('is 0.5 for a team scoring exactly as much as it allows', () => {
    assert.equal(pythagoreanStrength(500, 500, 100).toFixed(6), '0.500000');
  });

  it('rises with run differential', () => {
    const good = pythagoreanStrength(600, 400, 100);
    const bad = pythagoreanStrength(400, 600, 100);
    assert.ok(good > 0.5 && bad < 0.5);
    assert.equal(good.toFixed(10), (1 - bad).toFixed(10), 'symmetric');
  });
});

describe('log5', () => {
  it('returns 0.5 for equal strengths', () => {
    assert.equal(log5(0.5, 0.5), 0.5);
  });

  it('favours the stronger side and is antisymmetric', () => {
    assert.ok(log5(0.6, 0.4) > 0.5);
    assert.equal(log5(0.6, 0.4).toFixed(10), (1 - log5(0.4, 0.6)).toFixed(10));
  });
});

describe('modelProbability', () => {
  const c = { kEra: 0.04, hfa: 0.045 };
  const base = { homeStrength: 0.5, awayStrength: 0.5, homeStarterRa: 4.5, awayStarterRa: 4.5 };

  it('gives the home team its fitted home-field edge at equal strength', () => {
    assert.ok(Math.abs(modelProbability(base, c) - 0.545) < 1e-9);
  });

  it('RAISES the home probability when the home starter allows FEWER runs', () => {
    const better = modelProbability({ ...base, homeStarterRa: 3.0, awayStarterRa: 6.0 }, c);
    const worse = modelProbability({ ...base, homeStarterRa: 6.0, awayStarterRa: 3.0 }, c);
    assert.ok(better > modelProbability(base, c), 'better home starter must help home');
    assert.ok(worse < modelProbability(base, c), 'worse home starter must hurt home');
  });

  it('ignores the starter term when either starter is unknown', () => {
    assert.equal(modelProbability({ ...base, homeStarterRa: null }, c), modelProbability(base, c));
    assert.equal(modelProbability({ ...base, awayStarterRa: null }, c), modelProbability(base, c));
  });

  it('returns null when team strength is missing rather than guessing', () => {
    assert.equal(modelProbability({ ...base, homeStrength: null }, c), null);
    assert.equal(modelProbability(null, c), null);
  });

  it('never returns a certainty', () => {
    const p = modelProbability(
      { ...base, homeStrength: 0.999, awayStrength: 0.001, homeStarterRa: 0.1, awayStarterRa: 99 },
      c
    );
    assert.ok(p < 1 && p > 0);
  });
});

describe('buildWalkForwardRows -- the invariants that keep this honest', () => {
  // Two games: game 1 is the season opener, game 2 is a week later.
  // Scores are non-zero on both sides: pythagoreanStrength deliberately returns null for a
  // 0, since a team that has scored or allowed nothing would produce a degenerate 0 or 1.
  const games = [
    {
      startDate: '2025-04-01T18:00:00Z',
      home: { id: 'H', name: 'Home', score: 10, starterId: 'P1' },
      away: { id: 'A', name: 'Away', score: 1, starterId: 'P2' },
      odds: { homeClose: -150, awayClose: 130, homeOpen: -140, awayOpen: 120 }
    },
    {
      startDate: '2025-04-08T18:00:00Z',
      home: { id: 'A', name: 'Away', score: 2, starterId: 'P2' },
      away: { id: 'H', name: 'Home', score: 3, starterId: 'P1' },
      odds: { homeClose: 110, awayClose: -130, homeOpen: 105, awayOpen: -125 }
    }
  ];

  it("does NOT leak a game's own result into its own features", () => {
    const rows = buildWalkForwardRows(games, { minGames: 1, minStarts: 1 });
    // Game 1 is the first ever game: nothing is known yet, so strength MUST be null.
    assert.equal(rows[0].homeStrength, null, 'first game must have no prior information');
    assert.equal(rows[0].awayStrength, null);
    // Game 2 must reflect ONLY game 1 (10-1 to H), never its own 3-2 result.
    assert.ok(rows[1].homeStrength != null, 'second game has one prior game for A');
    const hAfterGame1 = pythagoreanStrength(10, 1, 1, { minGames: 1 });
    const aAfterGame1 = pythagoreanStrength(1, 10, 1, { minGames: 1 });
    assert.equal(rows[1].awayStrength.toFixed(10), hAfterGame1.toFixed(10), 'H strength = game 1 only');
    assert.equal(rows[1].homeStrength.toFixed(10), aAfterGame1.toFixed(10), 'A strength = game 1 only');
  });

  it("does NOT carry ESPN's season-final ERA, which is served retroactively", () => {
    // A source object that still carries the leaking field.
    const withEra = games.map((g) => ({
      ...g,
      home: { ...g.home, starterEra: 2.71 },
      away: { ...g.away, starterEra: 3.68 }
    }));
    const rows = buildWalkForwardRows(withEra, { minGames: 1, minStarts: 1 });
    for (const r of rows) {
      assert.equal(r.homeStarterEra, undefined, 'the leaking ERA field must never reach a row');
      assert.equal(r.awayStarterEra, undefined);
    }
  });

  it('builds the starter signal from prior starts only', () => {
    const rows = buildWalkForwardRows(games, { minGames: 1, minStarts: 1 });
    assert.equal(rows[0].homeStarterRa, null, 'no prior starts before game 1');
    // Game 1: P1 (home) allowed 1; P2 (away) allowed 10. Game 2: H is away (starter P1),
    // A is home (starter P2). So P1's prior RA = 1, P2's prior RA = 10.
    assert.equal(rows[1].awayStarterRa, 1, 'P1 allowed 1 in game 1');
    assert.equal(rows[1].homeStarterRa, 10, 'P2 allowed 10 in game 1');
  });

  it('attaches the de-vigged market probability and the closing price to each row', () => {
    const rows = buildWalkForwardRows(games, { minGames: 1, minStarts: 1 });
    assert.ok(rows[0].marketHome > 0.5, 'the -150 home side is the favourite');
    assert.equal(rows[0].homeCloseMl, -150);
    assert.ok(rows[0].openHome != null, 'opening line kept for CLV');
  });

  it('sorts games chronologically regardless of input order', () => {
    const rows = buildWalkForwardRows([games[1], games[0]], { minGames: 1, minStarts: 1 });
    assert.equal(rows[0].startDate, games[0].startDate);
  });
});

describe('fitCoefficients', () => {
  it('fits on the rows it is given and reports a finite Brier score', () => {
    const games = [];
    for (let i = 0; i < 400; i++) {
      const strongHome = i % 2 === 0;
      games.push({
        startDate: new Date(Date.UTC(2025, 3, 1 + i)).toISOString(),
        home: { id: 'H', name: 'Home', score: strongHome ? 6 : 2, starterId: 'P1' },
        away: { id: 'A', name: 'Away', score: strongHome ? 2 : 6, starterId: 'P2' },
        odds: { homeClose: -140, awayClose: 120, homeOpen: -135, awayOpen: 115 }
      });
    }
    const rows = buildWalkForwardRows(games, { minGames: 2, minStarts: 1 }).filter(
      (r) => r.marketHome != null && r.homeStrength != null && r.awayStrength != null
    );
    assert.ok(rows.length > 100, 'need usable rows');
    const fit = fitCoefficients(rows);
    assert.ok(Number.isFinite(fit.brier));
    assert.ok(fit.kEra >= 0 && fit.kEra <= 0.05);
    assert.ok(fit.hfa >= -0.02 && fit.hfa <= 0.08);
  });
});

describe('simulateBets', () => {
  it('reports no edge for a model that agrees with the market', () => {
    // A "model" that just echoes the de-vigged market has no information. Betting its
    // disagreements (which are zero) must produce nothing, not a profit.
    const rows = [];
    for (let i = 0; i < 500; i++) {
      const won = i % 2 === 0;
      rows.push({
        marketHome: 0.55,
        homeCloseMl: -120,
        awayCloseMl: 110,
        homeWon: won,
        openHome: 0.54
      });
    }
    const s = simulateBets(rows, (r) => r.marketHome, { threshold: 0.03 });
    assert.equal(s.n, 0, 'a model with zero disagreement must place no bets');
  });

  it('computes the edge against the price actually taken', () => {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      rows.push({
        marketHome: 0.45,
        homeCloseMl: 100, // +100 => implied 0.5
        awayCloseMl: -120,
        homeWon: true, // always wins
        openHome: 0.45
      });
    }
    const s = simulateBets(rows, () => 0.6, { threshold: 0.03 });
    assert.ok(s.n > 0);
    assert.equal(s.hitRate, 1, 'always wins');
    assert.ok(s.edgePoints > 0);
    assert.ok(s.roi > 0);
  });
});
