'use strict';

/**
 * Ledger metrics: hit rate with a confidence interval, ROI, and the
 * beat-the-close rate.
 *
 * The repo has printed a hit rate before, but never one traceable to settled
 * bets — the published figure was synthetic, and `README.md` says so ("these
 * validate the ranking engine, they do NOT prove profitability"). Everything
 * here is derived from `ledger.bets` + `ledger.settlements` + recorded closes,
 * and every bucket is returned with its sample size so a 3-bet bucket can never
 * read like a 300-bet one.
 *
 * Nothing in this module invents a number:
 *   - A bucket below `minSample` decided outcomes is flagged `insufficientSample`
 *     and its hit rate is reported as-is but explicitly untrustworthy.
 *   - ROI is computed only from rows whose decision price is an actual price.
 *     A row whose price is an implied-probability display string contributes 0
 *     and is counted in `unpricedRows` instead of being silently averaged in.
 *   - Mean CLV is computed only where `clvPct` exists (a captured close), so it
 *     is null rather than 0 when no close has been captured. Reporting a 0 mean
 *     CLV would look like "we neither beat nor lost to the close" when the truth
 *     is "we have never measured it".
 */

const { classifyPrice, impliedFraction } = require('./record-quality');

const DEFAULT_MIN_SAMPLE = 30;
/** 95% two-sided. */
const Z_95 = 1.96;

/**
 * Wilson score interval for a binomial proportion. Preferred over the normal
 * approximation because it stays inside [0, 1] and behaves at small n, which is
 * exactly the regime this repo is in.
 *
 * @param {number} wins
 * @param {number} n
 * @returns {{low: number, high: number}|null} null when n is 0
 */
function wilsonInterval(wins, n, z = Z_95) {
  if (!Number.isFinite(wins) || !Number.isFinite(n) || n <= 0) return null;
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator)
  };
}

/** Profit in units for one graded row, or null when the price is unusable. */
function profitUnits(row) {
  const stake = Number(row.stake);
  const odds = classifyPrice(row.odds);
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (row.outcome === 'push') return 0;
  if (odds.american == null && odds.decimal == null) return null;
  if (row.outcome === 'loss') return -stake;
  if (row.outcome !== 'win') return 0;
  if (odds.decimal != null) return stake * (odds.decimal - 1);
  return odds.american > 0 ? stake * (odds.american / 100) : stake * (100 / Math.abs(odds.american));
}

/**
 * Summarise a set of graded rows.
 *
 * @param {Array<Object>} rows - { odds, stake, outcome, clvPct? }
 * @param {Object} [opts] - { minSample }
 * @returns {Object}
 */
function summarise(rows, opts = {}) {
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const list = Array.isArray(rows) ? rows : [];
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let staked = 0;
  let pnl = 0;
  let unpricedRows = 0;
  let clvSum = 0;
  let clvSample = 0;

  for (const row of list) {
    if (!row) continue;
    if (row.outcome === 'win') wins += 1;
    else if (row.outcome === 'loss') losses += 1;
    else if (row.outcome === 'push') pushes += 1;
    const profit = profitUnits(row);
    if (profit == null) unpricedRows += 1;
    else {
      staked += Number(row.stake);
      pnl += profit;
    }
    if (typeof row.clvPct === 'number' && Number.isFinite(row.clvPct)) {
      clvSum += row.clvPct;
      clvSample += 1;
    }
  }

  const decided = wins + losses;
  const sample = list.length;
  const round = (value, dp) => (Number.isFinite(value) ? Number(value.toFixed(dp)) : null);

  return {
    sample,
    decided,
    wins,
    losses,
    pushes,
    hitRate: decided > 0 ? round(wins / decided, 4) : null,
    hitRateCi: wilsonInterval(wins, decided),
    stakedUnits: round(staked, 4),
    pnlUnits: round(pnl, 4),
    roiPct: staked > 0 ? round((pnl / staked) * 100, 2) : null,
    unpricedRows,
    clvSample,
    // null (never 0) when no close has been captured: "unmeasured" is not
    // "neither beat nor lost to the close".
    meanClvPct: clvSample > 0 ? round(clvSum / clvSample, 4) : null,
    insufficientSample: decided < minSample
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function summariseGroups(rows, keyFn, opts) {
  const out = {};
  for (const [key, group] of groupBy(rows, keyFn)) out[key] = summarise(group, opts);
  return out;
}

/** Coarse price bucket, so a heavy favourite never averages with a plus-money dog. */
function oddsBucket(odds) {
  const classified = classifyPrice(odds);
  const american = classified.american;
  if (american == null) return 'unpriced';
  if (american <= -200) return 'heavy_favourite';
  if (american < -100) return 'favourite';
  if (american <= 100) return 'even';
  if (american <= 200) return 'underdog';
  return 'big_underdog';
}

/**
 * The beat-the-close report over recorded CANDIDATES, not just bets.
 *
 * This is the leading indicator: it needs far fewer observations than win rate
 * to show signal, and it uses the whole recorded scan rather than only the rows
 * someone chose to bet.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { minSample }
 * @returns {Object}
 */
function beatTheCloseReport(ledger, opts = {}) {
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const rows = [];
  let withoutClose = 0;
  let withCloseNoPrice = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const hasClose = candidate.closeOdds != null || candidate.closeImpliedProbability != null;
    if (!hasClose) {
      withoutClose += 1;
      continue;
    }
    if (typeof candidate.clvPct !== 'number' || !Number.isFinite(candidate.clvPct)) {
      withCloseNoPrice += 1;
      continue;
    }
    rows.push({
      tier: candidate.tier || (candidate.featureSnapshot && candidate.featureSnapshot.signalTier) || 'unknown',
      market: candidate.market || 'unknown',
      league: candidate.league || 'unknown',
      book: candidate.closeBook || 'unknown',
      clvPct: candidate.clvPct,
      beat: candidate.clvPct > 0,
      // Kept so a reader can see the magnitude, not just the sign.
      decisionImplied: impliedFraction(candidate.odds),
      closeImplied: candidate.closeImpliedProbability
    });
  }

  const beat = rows.filter((row) => row.beat).length;
  const rate = rows.length > 0 ? beat / rows.length : null;

  const summariseClv = (list) => ({
    sample: list.length,
    beat: list.filter((row) => row.beat).length,
    rate: list.length > 0 ? Number((list.filter((row) => row.beat).length / list.length).toFixed(4)) : null,
    meanClvPct:
      list.length > 0 ? Number((list.reduce((sum, row) => sum + row.clvPct, 0) / list.length).toFixed(4)) : null,
    insufficientSample: list.length < minSample
  });

  const byKey = (keyFn) => {
    const out = {};
    for (const [key, group] of groupBy(rows, keyFn)) out[key] = summariseClv(group);
    return out;
  };

  return {
    candidates: candidates.length,
    withoutClose,
    withCloseNoPrice,
    sample: rows.length,
    beat,
    rate: rate == null ? null : Number(rate.toFixed(4)),
    rateCi: wilsonInterval(beat, rows.length),
    meanClvPct:
      rows.length > 0 ? Number((rows.reduce((sum, row) => sum + row.clvPct, 0) / rows.length).toFixed(4)) : null,
    insufficientSample: rows.length < minSample,
    byTier: byKey((row) => row.tier),
    byMarket: byKey((row) => row.market),
    byLeague: byKey((row) => row.league),
    byBook: byKey((row) => row.book)
  };
}

/**
 * Rows ready for summarising: settled bets joined to their recorded candidate
 * (for the close and any real CLV).
 *
 * @param {Object} ledger
 * @returns {Array<Object>}
 */
function settledRows(ledger) {
  const bets = Array.isArray(ledger && ledger.bets) ? ledger.bets : [];
  const settlements = Array.isArray(ledger && ledger.settlements) ? ledger.settlements : [];
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];

  const settlementByBet = new Map();
  for (const settlement of settlements) {
    if (!settlement || !settlement.betId) continue;
    const prior = settlementByBet.get(settlement.betId);
    // Latest settledAt wins; a present timestamp always beats a missing one.
    if (
      !prior ||
      (settlement.settledAt && !prior.settledAt) ||
      (settlement.settledAt && settlement.settledAt > prior.settledAt)
    ) {
      settlementByBet.set(settlement.betId, settlement);
    }
  }

  const candidateById = new Map();
  for (const candidate of candidates) {
    if (candidate && candidate.candidateId) candidateById.set(candidate.candidateId, candidate);
  }

  const rows = [];
  for (const bet of bets) {
    if (!bet || typeof bet !== 'object') continue;
    const settlement = settlementByBet.get(bet.id);
    const outcome = settlement ? settlement.status : bet.status;
    if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'push') continue;
    const candidate = bet.candidateId ? candidateById.get(bet.candidateId) : undefined;
    const snapshot = bet.candidateSnapshot || bet.featureSnapshot || (candidate && candidate.featureSnapshot) || {};
    rows.push({
      betId: bet.id,
      odds: bet.oddsAtDecision ?? snapshot.decisionOdds ?? (candidate && candidate.odds) ?? null,
      stake: Number(bet.stake) > 0 ? Number(bet.stake) : 1,
      outcome,
      tier: snapshot.signalTier || snapshot.confidenceTier || bet.tier || (candidate && candidate.tier) || 'unknown',
      market: bet.market || (candidate && candidate.market) || 'unknown',
      league: bet.league || (candidate && candidate.league) || 'unknown',
      // Only a captured close yields this; the open-to-current proxy is
      // deliberately NOT substituted here.
      clvPct: typeof (candidate && candidate.clvPct) === 'number' ? candidate.clvPct : null
    });
  }
  return rows;
}

/**
 * Full evaluation document for a ledger.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { minSample }
 * @returns {Object}
 */
function evaluateLedger(ledger, opts = {}) {
  const rows = settledRows(ledger);
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  return {
    minSample,
    overall: summarise(rows, { minSample }),
    byTier: summariseGroups(rows, (row) => row.tier, { minSample }),
    byMarket: summariseGroups(rows, (row) => row.market, { minSample }),
    byLeague: summariseGroups(rows, (row) => row.league, { minSample }),
    byOddsBucket: summariseGroups(rows, (row) => oddsBucket(row.odds), { minSample }),
    beatTheClose: beatTheCloseReport(ledger, { minSample })
  };
}

module.exports = {
  DEFAULT_MIN_SAMPLE,
  Z_95,
  wilsonInterval,
  profitUnits,
  oddsBucket,
  summarise,
  summariseGroups,
  beatTheCloseReport,
  settledRows,
  evaluateLedger
};
