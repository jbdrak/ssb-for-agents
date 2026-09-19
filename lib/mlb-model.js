'use strict';
/**
 * A real, honest MLB win-probability model.
 *
 * The point of this module is not to be clever. It is to be a model whose inputs are
 * INDEPENDENT of the price it is compared against: team run differential (Pythagorean
 * expectation) and the starting pitcher's season ERA. Everything the scan ever did was a
 * de-vig of public prices compared to public prices, which cannot produce an edge by
 * construction. This is the honest attempt at the one path that could.
 *
 * Correctness rules that matter more than the model:
 *   1. WALK-FORWARD ONLY. Every input for a game must be knowable before that game.
 *      `strengthFor` takes a snapshot of team state; callers must snapshot BEFORE
 *      recording the game's own result.
 *   2. COEFFICIENTS ARE FIT ON TRAIN AND EVALUATED ON HELD-OUT DATA. Never fit and
 *      report on the same games.
 *   3. Report UNCERTAINTY. A 3-point edge on 500 bets is noise; say so.
 */

const PYTHAGOREAN_EXPONENT = 1.83;

/** American moneyline -> implied probability (with vig). */
function americanToProb(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

/** Probability -> American moneyline. */
function probToAmerican(p) {
  if (!(p > 0) || p >= 1) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

/** Remove the vig from a two-way market. Returns null if either side is unusable. */
function devig(homeProb, awayProb) {
  if (homeProb == null || awayProb == null) return null;
  const total = homeProb + awayProb;
  if (!(total > 0)) return null;
  return { home: homeProb / total, away: awayProb / total, hold: total - 1 };
}

/** De-vig two American prices directly. */
function devigPrices(homeMl, awayMl) {
  return devig(americanToProb(homeMl), americanToProb(awayMl));
}

/**
 * Pythagorean win expectation from runs scored/allowed.
 * `games` guards against a 1-game sample producing a degenerate 0 or 1.
 */
function pythagoreanStrength(runsScored, runsAllowed, games, { minGames = 10, exponent = PYTHAGOREAN_EXPONENT } = {}) {
  if (!Number.isFinite(games) || games < minGames) return null;
  const rs = runsScored / games;
  const ra = runsAllowed / games;
  if (!(rs > 0) || !(ra > 0)) return null;
  const a = Math.pow(rs, exponent);
  const b = Math.pow(ra, exponent);
  return a / (a + b);
}

/**
 * Bill James log5: P(A beats B) given each side's strength.
 * Note this is NOT P(home wins) -- it is side-vs-side, with no venue effect.
 */
function log5(strengthA, strengthB) {
  const d = strengthA + strengthB - 2 * strengthA * strengthB;
  if (d === 0) return 0.5;
  return (strengthA - strengthA * strengthB) / d;
}

/** Clamp a probability away from the 0/1 absorbing states. */
function clampProb(p, lo = 0.05, hi = 0.95) {
  if (!Number.isFinite(p)) return null;
  return Math.min(hi, Math.max(lo, p));
}

/**
 * P(home wins). Strengths are passed in already snapshotted -- this function must never
 * reach for live team state, because by evaluation time that state includes the result of
 * the very game being predicted. That leak is not subtle: it turned a coin flip into a
 * 61% win rate and +11% ROI in the first run of this backtest.
 *
 * @param {Object} f - { homeStrength, awayStrength, homeStarterRa, awayStarterRa }
 * @param {Object} c - { kEra, hfa } fitted coefficients
 */
function modelProbability(f, c) {
  if (!f || f.homeStrength == null || f.awayStrength == null) return null;
  let p = log5(f.homeStrength, f.awayStrength);
  // `*Ra` is runs allowed per start, so LOWER is better. A better home starter (lower RA)
  // must raise the home win probability, hence (away - home).
  if (f.homeStarterRa != null && f.awayStarterRa != null) {
    p += c.kEra * (f.awayStarterRa - f.homeStarterRa);
  }
  p += c.hfa;
  return clampProb(p);
}

/** Brier score over rows. `probFn(row)` -> P(home wins). */
function brierScore(rows, probFn) {
  if (!rows.length) return null;
  let s = 0;
  for (const r of rows) {
    const p = probFn(r);
    if (p == null) continue;
    s += Math.pow(p - (r.homeWon ? 1 : 0), 2);
  }
  return s / rows.length;
}

/** Log loss over rows. Lower is better. */
function logLoss(rows, probFn) {
  if (!rows.length) return null;
  let s = 0;
  for (const r of rows) {
    const p = probFn(r);
    if (p == null) continue;
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
    s -= r.homeWon ? Math.log(q) : Math.log(1 - q);
  }
  return s / rows.length;
}

/** Grid-search kEra/hfa to minimise Brier on the given (train) rows. */
function fitCoefficients(rows, { kEraRange = [0, 0.05, 0.0025], hfaRange = [-0.02, 0.08, 0.005] } = {}) {
  let best = null;
  for (let kEra = kEraRange[0]; kEra <= kEraRange[1] + 1e-9; kEra += kEraRange[2]) {
    for (let hfa = hfaRange[0]; hfa <= hfaRange[1] + 1e-9; hfa += hfaRange[2]) {
      const b = brierScore(rows, (r) => modelProbability(r, { kEra, hfa }));
      if (!best || b < best.brier) best = { kEra, hfa, brier: b };
    }
  }
  return best;
}

/** Payout on a 1-unit win at this American price (excludes the returned stake). */
function payout(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? n / 100 : 100 / -n;
}

/**
 * Simulate betting every game where the model disagrees with the de-vigged market by more
 * than `threshold`, settling at the CLOSING price.
 *
 * The reported `edgePoints` is the honest headline: actual win rate minus the win rate the
 * price implied. `z` is that difference over its standard error, so a small sample cannot
 * be mistaken for an edge. `roiStderr` is the same guard for the money.
 */
function simulateBets(rows, probFn, { threshold = 0.03 } = {}) {
  let n = 0;
  let wins = 0;
  let pnl = 0;
  let impliedSum = 0;
  let devigSum = 0;
  const returns = [];
  let clvN = 0;
  let clvSum = 0;

  for (const r of rows) {
    const p = probFn(r);
    if (p == null || r.marketHome == null) continue;
    const edgeHome = p - r.marketHome;
    let side = null;
    if (edgeHome > threshold) side = 'home';
    else if (-edgeHome > threshold) side = 'away';
    if (!side) continue;

    const ml = side === 'home' ? r.homeCloseMl : r.awayCloseMl;
    const implied = americanToProb(ml);
    if (implied == null) continue;
    const won = side === 'home' ? r.homeWon : !r.homeWon;

    // The market's OWN view of this side's true probability. Beating the raw price is not
    // an edge -- the raw price contains the hold, so a model with zero information still
    // "beats" it by roughly half the hold. The de-vigged number is the honest benchmark.
    const fair = devigPrices(r.homeCloseMl, r.awayCloseMl);
    const devigged = fair ? (side === 'home' ? fair.home : fair.away) : implied;

    n += 1;
    impliedSum += implied;
    devigSum += devigged;
    if (won) wins += 1;
    const ret = won ? payout(ml) : -1;
    pnl += ret;
    returns.push(ret);

    if (r.openHome != null) {
      const openSide = side === 'home' ? r.openHome : 1 - r.openHome;
      const closeSide = side === 'home' ? r.marketHome : 1 - r.marketHome;
      if (openSide > 0) {
        clvSum += (closeSide - openSide) / openSide;
        clvN += 1;
      }
    }
  }

  if (!n) return { n: 0, wins: 0, hitRate: null, roi: null, edgePoints: null, z: null, clv: null };
  const hitRate = wins / n;
  const impliedRate = impliedSum / n;
  const devigRate = devigSum / n;
  // Standard error of a win-rate difference; bets are treated as independent.
  const se = Math.sqrt((impliedRate * (1 - impliedRate)) / n);
  const seDevig = Math.sqrt((devigRate * (1 - devigRate)) / n);
  const meanRet = pnl / n;
  const variance = returns.reduce((s, x) => s + Math.pow(x - meanRet, 2), 0) / Math.max(1, n - 1);
  const roiStderr = Math.sqrt(variance / n);

  return {
    n,
    wins,
    hitRate,
    impliedRate,
    devigRate,
    edgePoints: (hitRate - impliedRate) * 100,
    edgePointsDevig: (hitRate - devigRate) * 100,
    z: se > 0 ? (hitRate - impliedRate) / se : null,
    zDevig: seDevig > 0 ? (hitRate - devigRate) / seDevig : null,
    roi: meanRet,
    roiStderr,
    pnl,
    clv: clvN ? clvSum / clvN : null
  };
}

/**
 * Build walk-forward feature rows from raw games.
 *
 * THE CRITICAL INVARIANT: each row's features are snapshotted from state as it stood BEFORE
 * that game's own result was recorded. Computing them lazily at evaluation time instead
 * would score every game against end-of-season state -- the maps are complete by then --
 * which is a catastrophic lookahead that manufactures fake alpha.
 *
 * A SECOND, SUBTLER LEAK this function deliberately refuses to use: ESPN's scoreboard
 * attaches the starting pitcher's SEASON-FINAL ERA to every game he started, all season
 * long. Verified across 705 pitcher-seasons: 705 showed an identical ERA on every start,
 * 0 varied (Miles Mikolas: 36 starts, all 4.78). Using it hands the model the rest of the
 * season -- it produced a fake +6.6pt edge and +10.5% ROI from the ERA term alone. So the
 * starter signal here is built from THIS dataset instead: runs allowed by his team in his
 * prior starts, which is knowable at first pitch.
 *
 * @param {Array} games - [{ startDate, home:{id,score,starterId}, away:{...}, odds:{...} }]
 */
function buildWalkForwardRows(games, { minGames = 10, minStarts = 3 } = {}) {
  const sorted = [...games].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  const state = new Map();
  const pitchers = new Map();
  const rows = [];

  const snapshot = (id) => {
    const t = state.get(id);
    if (!t) return null;
    return pythagoreanStrength(t.rs, t.ra, t.games, { minGames });
  };
  // Walk-forward starter quality: mean runs his team allowed in his prior starts.
  const starterSnapshot = (id) => {
    if (!id) return null;
    const p = pitchers.get(id);
    if (!p || p.starts < minStarts) return null;
    return p.ra / p.starts;
  };
  const record = (id, scored, allowed) => {
    let t = state.get(id);
    if (!t) {
      t = { rs: 0, ra: 0, games: 0 };
      state.set(id, t);
    }
    t.rs += Number(scored) || 0;
    t.ra += Number(allowed) || 0;
    t.games += 1;
  };
  const recordStart = (pitcherId, runsAllowed) => {
    if (!pitcherId) return;
    let p = pitchers.get(pitcherId);
    if (!p) {
      p = { ra: 0, starts: 0 };
      pitchers.set(pitcherId, p);
    }
    p.ra += Number(runsAllowed) || 0;
    p.starts += 1;
  };

  for (const g of sorted) {
    const fair = devigPrices(g.odds && g.odds.homeClose, g.odds && g.odds.awayClose);
    const fairOpen = devigPrices(g.odds && g.odds.homeOpen, g.odds && g.odds.awayOpen);
    const homeWon = g.home.score > g.away.score;

    rows.push({
      startDate: g.startDate,
      home: g.home,
      away: g.away,
      // Snapshot BEFORE recording this game's result.
      homeStrength: snapshot(g.home.id),
      awayStrength: snapshot(g.away.id),
      homeStarterRa: starterSnapshot(g.home.starterId),
      awayStarterRa: starterSnapshot(g.away.starterId),
      homeWon,
      homeScore: g.home.score,
      awayScore: g.away.score,
      marketHome: fair ? fair.home : null,
      marketHold: fair ? fair.hold : null,
      openHome: fairOpen ? fairOpen.home : null,
      homeCloseMl: g.odds ? g.odds.homeClose : null,
      awayCloseMl: g.odds ? g.odds.awayClose : null
    });

    record(g.home.id, g.home.score, g.away.score);
    record(g.away.id, g.away.score, g.home.score);
    recordStart(g.home.starterId, g.away.score);
    recordStart(g.away.starterId, g.home.score);
  }

  return rows;
}

/** Calibration table: predicted vs actual, bucketed. */
function calibration(rows, probFn, { bucket = 0.1 } = {}) {
  const out = [];
  for (let lo = 0.2; lo < 0.8 - 1e-9; lo += bucket) {
    const b = rows.filter((r) => {
      const p = probFn(r);
      return p != null && p >= lo && p < lo + bucket;
    });
    if (b.length < 10) continue;
    const meanP = b.reduce((s, r) => s + probFn(r), 0) / b.length;
    const actual = b.filter((r) => r.homeWon).length / b.length;
    const marketP = b.reduce((s, r) => s + (r.marketHome ?? 0), 0) / b.length;
    out.push({ lo, hi: lo + bucket, n: b.length, meanP, actual, marketP });
  }
  return out;
}

module.exports = {
  PYTHAGOREAN_EXPONENT,
  americanToProb,
  probToAmerican,
  devig,
  devigPrices,
  pythagoreanStrength,
  log5,
  clampProb,
  modelProbability,
  brierScore,
  logLoss,
  fitCoefficients,
  payout,
  simulateBets,
  buildWalkForwardRows,
  calibration
};
