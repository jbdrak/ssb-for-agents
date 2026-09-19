'use strict';
/**
 * Spread (point-spread) model, for markets where no moneyline exists.
 *
 * Why this exists: ESPN's archive carries NO moneyline for older college football seasons,
 * only a spread and a total. A spread model therefore reaches roughly 1.6x the games the
 * moneyline model can use, and spreads are priced as their own market.
 *
 * The same honesty rules apply as in `team-model.js`:
 *   - WALK-FORWARD ONLY. Team margin state is snapshotted BEFORE the game's own result is
 *     recorded, so a game can never see its own score.
 *   - Coefficients are fit on TRAIN seasons and evaluated on held-out ones.
 *   - A model with no information returns roughly minus the hold.
 *
 * SIGN CONVENTION (verified against the data, not assumed): ESPN's `spread` is from the
 * HOME team's perspective, so `-37` means the home team is favoured by 37. The number the
 * home team must win by is therefore `-spread`. `assertSpreadConvention` checks this.
 */

/** The number the HOME team must win by, from ESPN's home-perspective `spread`. */
function homeLine(spread) {
  if (spread == null) return null;
  const n = Number(spread);
  if (!Number.isFinite(n)) return null;
  // Negating zero yields -0, which is `=== 0` but not `Object.is`-equal to it and prints as
  // "-0". Normalise so a pick'em line reads as 0.
  return n === 0 ? 0 : -n;
}

/** Mean scoring margin per game (points for minus points against). */
function marginRate(pointsFor, pointsAgainst, games, { minGames = 3 } = {}) {
  if (!Number.isFinite(games) || games < minGames) return null;
  const pf = pointsFor / games;
  const pa = pointsAgainst / games;
  if (!Number.isFinite(pf) || !Number.isFinite(pa)) return null;
  return pf - pa;
}

/**
 * Predicted home margin.
 *
 * `k` scales the difference in average margins. It is fitted rather than assumed 1.0,
 * because the raw difference of season-average margins overstates the true gap (schedule
 * strength and regression to the mean both pull it toward zero).
 */
function modelMargin(f, c) {
  if (!f || f.homeMarginRate == null || f.awayMarginRate == null) return null;
  return c.k * (f.homeMarginRate - f.awayMarginRate) + c.hfa;
}

/** Build walk-forward margin rows. Snapshots state BEFORE recording the game's own result. */
function buildWalkForwardMarginRows(games, { minGames = 3 } = {}) {
  const sorted = [...games].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  const state = new Map();
  const rows = [];

  const snapshot = (id) => {
    const t = state.get(id);
    if (!t) return null;
    return marginRate(t.pf, t.pa, t.games, { minGames });
  };
  const record = (id, pf, pa) => {
    let t = state.get(id);
    if (!t) {
      t = { pf: 0, pa: 0, games: 0 };
      state.set(id, t);
    }
    t.pf += Number(pf) || 0;
    t.pa += Number(pa) || 0;
    t.games += 1;
  };

  for (const g of sorted) {
    const o = g.odds || {};
    const line = homeLine(o.spread);
    const homeScore = Number(g.home.score);
    const awayScore = Number(g.away.score);
    rows.push({
      startDate: g.startDate,
      home: g.home,
      away: g.away,
      neutralSite: g.neutralSite === true,
      homeMarginRate: snapshot(g.home.id),
      awayMarginRate: snapshot(g.away.id),
      homeScore,
      awayScore,
      margin: homeScore - awayScore,
      line,
      homeSpreadOdds: o.homeSpreadOdds ?? null,
      awaySpreadOdds: o.awaySpreadOdds ?? null,
      spreadOpen: o.spreadOpen ?? null,
      spreadClose: o.spreadClose ?? null,
      overUnder: o.overUnder ?? null,
      homeCloseMl: o.homeClose ?? null,
      awayCloseMl: o.awayClose ?? null
    });
    record(g.home.id, homeScore, awayScore);
    record(g.away.id, awayScore, homeScore);
  }

  return rows;
}

/** Settle a spread bet. Returns 'win' | 'loss' | 'push' | null (unpriced). */
function settleSpread(row, side) {
  if (row.line == null) return null;
  const diff = side === 'home' ? row.margin - row.line : row.line - row.margin;
  if (diff > 0) return 'win';
  if (diff < 0) return 'loss';
  return 'push';
}

/**
 * Fit k and hfa by minimising mean squared error against the actual margin.
 * This is a margin regression, not a probability fit -- the target is points, not wins.
 */
function fitMarginCoefficients(rows, { kRange = [0.2, 1.4, 0.025], hfaRange = [-2, 6, 0.25] } = {}) {
  const usable = rows.filter((r) => r.line != null && r.homeMarginRate != null && r.awayMarginRate != null);
  if (!usable.length) return null;
  let best = null;
  for (let k = kRange[0]; k <= kRange[1] + 1e-9; k += kRange[2]) {
    for (let hfa = hfaRange[0]; hfa <= hfaRange[1] + 1e-9; hfa += hfaRange[2]) {
      let sse = 0;
      for (const r of usable) sse += (modelMargin(r, { k, hfa }) - r.margin) ** 2;
      const mse = sse / usable.length;
      if (!best || mse < best.mse) best = { k, hfa, mse, n: usable.length };
    }
  }
  return best;
}

/** Mean absolute error and bias of the margin model against the actual margin. */
function marginError(rows, probFn) {
  const u = rows.filter((r) => r.line != null && probFn(r) != null);
  if (!u.length) return null;
  const errs = u.map((r) => probFn(r) - r.margin);
  const abs = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
  const bias = errs.reduce((s, e) => s + e, 0) / errs.length;
  return { n: u.length, mae: abs, bias };
}

/**
 * Simulate spread betting: back the side the model likes when it disagrees with the line by
 * more than `threshold` points. Settles at the quoted spread price. Pushes are void (0).
 */
function simulateSpreadBets(rows, marginFn, { threshold = 2, requirePrice = true } = {}) {
  let n = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let pnl = 0;
  const returns = [];
  let clvN = 0;
  let clvSum = 0;

  for (const r of rows) {
    if (r.line == null) continue;
    const m = marginFn(r);
    if (m == null) continue;
    const edgeHome = m - r.line;
    const side = edgeHome > threshold ? 'home' : -edgeHome > threshold ? 'away' : null;
    if (!side) continue;
    const price = side === 'home' ? r.homeSpreadOdds : r.awaySpreadOdds;
    if (requirePrice && !Number.isFinite(price)) continue;

    const result = settleSpread(r, side);
    if (result == null) continue;
    n += 1;
    if (result === 'push') {
      pushes += 1;
      returns.push(0);
      continue;
    }
    const ml = Number.isFinite(price) ? price : -110;
    if (result === 'win') {
      wins += 1;
      const ret = ml > 0 ? ml / 100 : 100 / -ml;
      pnl += ret;
      returns.push(ret);
    } else {
      losses += 1;
      pnl -= 1;
      returns.push(-1);
    }

    // CLV on the spread, where ESPN has an open and close line (recent seasons only).
    if (r.spreadOpen != null && r.spreadClose != null) {
      const openLine = homeLine(r.spreadOpen);
      const closeLine = homeLine(r.spreadClose);
      if (Number.isFinite(openLine) && Number.isFinite(closeLine)) {
        const openSide = side === 'home' ? openLine : -openLine;
        const closeSide = side === 'home' ? closeLine : -closeLine;
        // We want the number to move TOWARD our side; for the favourite that means the
        // line getting shorter, for the underdog longer. Positive = line moved our way.
        clvSum += closeSide - openSide;
        clvN += 1;
      }
    }
  }

  const decided = wins + losses;
  if (!n || !decided) {
    return { n, wins, losses, pushes, hitRate: null, roi: null, roiStderr: null, pnl, clv: null };
  }
  const hitRate = wins / decided;
  const meanRet = pnl / n;
  const variance = returns.reduce((s, x) => s + (x - meanRet) ** 2, 0) / Math.max(1, n - 1);
  return {
    n,
    wins,
    losses,
    pushes,
    hitRate,
    roi: meanRet,
    roiStderr: Math.sqrt(variance / n),
    pnl,
    clv: clvN ? clvSum / clvN : null
  };
}

/**
 * Verify ESPN's `spread` really is home-perspective, rather than assuming it.
 * If the convention were inverted, every result downstream would be silently reversed.
 */
function assertSpreadConvention(rows) {
  const u = rows.filter((r) => r.line != null && Number.isFinite(r.margin));
  if (u.length < 50) return { ok: null, n: u.length, reason: 'too few rows' };
  // With a home-perspective line, the home side covers about half the time.
  const homeCovers = u.filter((r) => r.margin > r.line).length / u.length;
  // And the line should correlate positively with the actual margin.
  const meanLine = u.reduce((s, r) => s + r.line, 0) / u.length;
  const meanMargin = u.reduce((s, r) => s + r.margin, 0) / u.length;
  let cov = 0;
  let vl = 0;
  let vm = 0;
  for (const r of u) {
    cov += (r.line - meanLine) * (r.margin - meanMargin);
    vl += (r.line - meanLine) ** 2;
    vm += (r.margin - meanMargin) ** 2;
  }
  const corr = cov / Math.sqrt(vl * vm);
  return { ok: homeCovers > 0.4 && homeCovers < 0.6 && corr > 0.2, n: u.length, homeCovers, corr };
}

module.exports = {
  homeLine,
  marginRate,
  modelMargin,
  buildWalkForwardMarginRows,
  settleSpread,
  fitMarginCoefficients,
  marginError,
  simulateSpreadBets,
  assertSpreadConvention
};
