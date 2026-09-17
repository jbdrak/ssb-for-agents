'use strict';

// Evaluation bridge: adapter records -> the row shape the evaluator scores.
//
// WHY THIS EXISTS. The layer was built in two halves that were never joined.
// `lib/ratings-sources/*` normalize a source into `lib/ssb-ratings-contract.js`
// records, and `lib/ssb-external-ratings-evaluation.js` scores a win probability
// (`modelWinProbability`) against the de-vigged close (`marketFairProbability`).
// Nothing converted one into the other: the contract carried no probability
// field at all, and no function built evaluation rows from snapshot records plus
// settled outcomes. The evaluator's own tests passed because they fed it
// hand-built rows, while no product path could construct those rows - so no
// pipeline could ever produce a number about Massey, Sagarin, Sasser or tennis
// Elo, however much data accumulated.
//
// Two things close that gap:
//
//   1. the contract carries `modelWinProbability` + `modelWinProbabilityKind`
//      ('published' | 'derived'), populated only where the source genuinely
//      publishes a probability or a documented conversion exists (see
//      `PROBABILITY_SUPPORT` below for the per-source decision);
//   2. `buildRatingEvaluationRows` joins those records to settled outcomes and
//      recorded market closes, and emits exactly the rows
//      `evaluateRatingSources` / `evaluateMarketRelative` consume.
//
// DESIGN RULES
//
//   - Fail closed. A record that cannot be attributed, identified, or joined is
//     never guessed at: it is dropped, and the drop is counted by reason. The
//     return value always says which records were excluded and why, so an empty
//     or thin score block can never read as a clean result.
//   - Two inputs for one fixture is a COLLISION, not a preference. A record
//     carries no game timestamp, so when two settled outcomes resolve to the
//     same pairing (the same two teams on two dates, or a two-game series) there
//     is no way to attribute one prediction to one of them. That key is refused
//     (`ambiguous_fixture`) rather than collapsed onto the first row, the same
//     choice the team-alias registry makes for two schools that share a name.
//   - Never fabricate. A source with no probability is reported as such with a
//     reason (`probabilitySupport`), not silently absent from the output. No
//     probability is derived from a rating here: the only conversion in this
//     layer is tennis Elo's, it lives in the tennis-elo adapter, and it is
//     labelled `derived` because it is the local engine's own number.
//   - The join identity is the overlay's. Sides resolve through the same
//     `identity()`/`canonicalGameKey()` the shadow overlay uses, so a record the
//     overlay attaches to a row and a record this bridge scores are keyed the
//     same way, and an unresolvable name fails closed in both.
//   - The evaluator's own recency rule does the date work. `predictionTimestamp`
//     is the source's `asOf` (when the model was computed / published) and
//     `gameTimestamp` comes from the settled outcome, so
//     `ssb-external-ratings-evaluation.js` applies the layer's shared
//     `ATTACH_MAX_AGE_DAYS` window and refuses a stale snapshot as evidence -
//     the same rule the overlay applies at the join - rather than a second
//     age concept invented here.
//
// USAGE
//
//   const { rows, sources, skipped } = buildRatingEvaluationRows({
//     records: [sagarinEnvelope, masseyEnvelope],   // adapter envelopes, a
//                                                  // source-keyed map, or a
//                                                  // flat record list
//     outcomes: [{ league: 'NCAAF', game: 'Rutgers vs Massachusetts',
//                  winner: 'Massachusetts', gameTimestamp: '2026-09-04T00:00:00Z',
//                  settledAt: '2026-09-04T03:10:00Z' }],
//     // No `market` label: a Sagarin record is market-wildcard, and a labelled
//     // close would only join a record that claims the same market.
//     markets: [{ league: 'NCAAF', game: 'Rutgers vs Massachusetts',
//                 marketFairProbability: 0.38, closingOdds: 170 }]
//   });
//
//   const scored = evaluateRatingSources(rows, { minSample: 1 });
//   sources.massey.probability.reason   // why massey has no score block
//
// `rows` is a flat list because that is what `evaluateRatingSources` accepts and
// each row carries its own `source`, so sources are still never blended. Pass
// `dimensions: ['source', 'modelWinProbabilityKind', ...]` to segment published
// from derived numbers.

const { SOURCES } = require('./ssb-ratings-contract');
const { canonicalGameKey, identity, recordsBySource } = require('./ssb-ratings-overlay');

/** Sentinel for "this market input applies to every market of its fixture". */
const WILDCARD = '*';

/** `winner: 'draw'` - see `outcomeSideFor`: a draw is not a win for a WIN% source. */
const DRAW = 'draw';

/**
 * Per-source probability availability, with the reason it will be reported
 * under. Every source in the contract's `SOURCES` must appear here; the
 * completeness is asserted by the bridge's tests, so adding a fifth source
 * cannot silently skip the declaration.
 *
 * `available: false` is a decision, not a gap: it is what an evaluation reports
 * instead of a score block that would otherwise be indistinguishable from "no
 * data yet".
 */
const PROBABILITY_SUPPORT = Object.freeze({
  sagarin: Object.freeze({
    available: true,
    kind: 'published',
    reason:
      "sagarin prints the favorite's win probability in its prediction block WIN% column, " +
      "carried verbatim for the record's teamA"
  }),
  tennis_elo: Object.freeze({
    available: true,
    kind: 'derived',
    reason:
      'tennis_elo publishes ratings only; the carried number is DERIVED by the local Elo engine - ' +
      'expectedScore(ratingA, ratingB) = 1 / (1 + 10^((ratingB - ratingA) / 400)) over the ' +
      'surface-aware ratings on the record - and is not a vendor-published probability'
  }),
  massey: Object.freeze({
    available: false,
    kind: null,
    reason:
      'massey publishes a team rating (Rat) and a season expected-wins column (EW/EL), never a win ' +
      'probability, and no documented rating-to-probability conversion exists for it - so massey is ' +
      'scoped out of probability scoring rather than scored on an invented mapping'
  }),
  massey_games: Object.freeze({
    available: true,
    kind: 'published',
    reason:
      "massey's games board prints a per-fixture Pwin column, carried verbatim for the record's " +
      "teamA (the home side) - the source's own number, not one this layer derived"
  }),
  sasser: Object.freeze({
    available: false,
    kind: null,
    reason:
      'sasser publishes projected scores and a printed market line, not a win probability, and none ' +
      'is derived from its projected scores here'
  })
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value) {
  return Array.isArray(value) ? value : [];
}

/** Trim/collapse/upper-case one join segment (the overlay's own normalization). */
function segment(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function probabilityOf(record) {
  const value = record && record.modelWinProbability;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** A short, readable label for a record or an input row, for diagnostics. */
function describeRecord(record) {
  if (!isPlainObject(record)) return String(record).slice(0, 60);
  const a = typeof record.teamA === 'string' ? record.teamA : '?';
  const b = typeof record.teamB === 'string' ? record.teamB : '?';
  return `${a} vs ${b}`;
}

function describeInput(row, index) {
  const label = isPlainObject(row) && typeof row.game === 'string' ? row.game : String(row);
  return `${label} (input #${index + 1})`.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function leagueScoped(league, key) {
  const leagueKey = segment(league);
  return leagueKey === '' || key === null ? null : `${leagueKey}|${key}`;
}

/** `LEAGUE|SIDE|SIDE` for a record's two sides, order-independent. */
function recordPairKey(record) {
  return leagueScoped(record.league, canonicalGameKey(`${record.teamA} vs ${record.teamB}`, record.league));
}

/** `LEAGUE|SIDE|SIDE` for a settled outcome / market input's own `game` label. */
function inputPairKey(row) {
  if (!isPlainObject(row) || typeof row.game !== 'string') return null;
  return leagueScoped(row.league, canonicalGameKey(row.game, row.league));
}

// ---------------------------------------------------------------------------
// Input indexes
// ---------------------------------------------------------------------------

/**
 * A join index: `map` holds the one row per key, `ambiguous` holds the keys that
 * more than one row claimed. Two rows for one key is not a "last one wins"
 * situation - they are two different games (the same pairing on two dates), and
 * a contract record carries no game timestamp, so nothing can attribute one
 * prediction to one of them. The key is therefore marked ambiguous and refused,
 * which is the layer's standing rule: prefer unresolved over collapsed.
 *
 * @typedef {{ map: Map<string, Object>, ambiguous: Set<string> }} JoinIndex
 */

/**
 * Index settled outcomes by `LEAGUE|SIDE|SIDE`. A row without a game label, or
 * whose sides do not resolve, is dropped and counted.
 *
 * @param {Array<any>} rows
 * @returns {{ index: JoinIndex, problems: Array<{reason: string, sample: string}>, usable: number }}
 */
function indexOutcomes(rows) {
  const map = new Map();
  const ambiguous = new Set();
  const problems = [];
  rows.forEach((row, index) => {
    if (!isPlainObject(row) || typeof row.game !== 'string') {
      problems.push({ reason: 'outcome_without_game', sample: describeInput(row, index) });
      return;
    }
    const key = inputPairKey(row);
    if (!key) {
      problems.push({ reason: 'outcome_identity_unresolved', sample: describeInput(row, index) });
      return;
    }
    if (map.has(key)) {
      ambiguous.add(key);
      problems.push({ reason: 'ambiguous_outcome_for_fixture', sample: describeInput(row, index) });
      return;
    }
    map.set(key, row);
  });
  return { index: { map, ambiguous }, problems, usable: map.size - ambiguous.size };
}

/**
 * Index market inputs by `LEAGUE|SIDE|SIDE|MARKET`, with the market segment
 * defaulting to the wildcard so a fixture-level close can serve any market. Two
 * closes for one market of one fixture are contradictory, so that key is
 * ambiguous and serves no record (the model probability is still evaluable; only
 * the market comparison is withheld).
 *
 * @param {Array<any>} rows
 * @returns {{ index: JoinIndex, problems: Array<{reason: string, sample: string}>, usable: number }}
 */
function indexMarkets(rows) {
  const map = new Map();
  const ambiguous = new Set();
  const problems = [];
  rows.forEach((row, index) => {
    if (!isPlainObject(row) || typeof row.game !== 'string') {
      problems.push({ reason: 'market_without_game', sample: describeInput(row, index) });
      return;
    }
    const key = inputPairKey(row);
    if (!key) {
      problems.push({ reason: 'market_identity_unresolved', sample: describeInput(row, index) });
      return;
    }
    const marketKey = `${key}|${segment(row.market) || WILDCARD}`;
    if (map.has(marketKey)) {
      ambiguous.add(marketKey);
      problems.push({ reason: 'ambiguous_market_for_fixture', sample: describeInput(row, index) });
      return;
    }
    map.set(marketKey, row);
  });
  return { index: { map, ambiguous }, problems, usable: map.size - ambiguous.size };
}

/** The one settled outcome for a fixture, or `null` when none is usable. */
function outcomeFor(index, pairKey) {
  if (index.ambiguous.has(pairKey)) return { ambiguous: true, row: null };
  const row = index.map.get(pairKey);
  return row ? { ambiguous: false, row } : null;
}

/** The market input for a record: its own market scope, or the fixture's wildcard. */
function marketFor(index, pairKey, recordMarket) {
  const specific = segment(recordMarket);
  const candidates = specific === '' ? [`${pairKey}|${WILDCARD}`] : [`${pairKey}|${specific}`];
  for (const key of candidates) {
    if (index.ambiguous.has(key)) return null;
    const hit = index.map.get(key);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

/**
 * The evaluator's outcome for the record's own `teamA` side, or `null` when the
 * outcome names a side that is not in this fixture (fail closed: an outcome that
 * cannot be attributed to a side is not evidence about that side).
 *
 * A `winner` of `'draw'` maps to a LOSS: the carried probability is a `WIN%`, so
 * a draw is not a win, and scoring it as anything else would grade a
 * non-winning bet as a win.
 *
 * @param {Record<string, any>} record
 * @param {Record<string, any>} outcome
 * @returns {'win' | 'loss' | null}
 */
function outcomeSideFor(record, outcome) {
  const winner = outcome.winner;
  if (typeof winner === 'string' && winner.trim().toLowerCase() === DRAW) return 'loss';
  const winnerId = identity(winner, record.league);
  if (!winnerId) return null;
  if (winnerId === identity(record.teamA, record.league)) return 'win';
  if (winnerId === identity(record.teamB, record.league)) return 'loss';
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One contract record -> one evaluation row, or a stated reason it cannot be one.
 * Pure: it reads the two join indexes and never mutates them, and it is the only
 * place that decides whether a record is scoreable.
 *
 * @param {{ source: string, support: Object, record: Record<string, any>,
 *           outcomes: JoinIndex, markets: JoinIndex }} context
 * @returns {{ reason?: string, row?: Record<string, any> }}
 */
function rowForRecord(context) {
  const { source, support, record, outcomes, markets } = context;

  // 1. The probability, and its attribution. A record with no number cannot be
  //    scored; the reason distinguishes "this source never publishes one" from
  //    "this record lost the one it should have".
  const probability = probabilityOf(record);
  if (probability === null) {
    return { reason: support.available ? 'record_missing_probability' : 'probability_unavailable' };
  }
  const kind = record.modelWinProbabilityKind;
  if (kind !== 'published' && kind !== 'derived') return { reason: 'probability_unattributed' };

  // 2. Identity. A team-scoped record (a team-list rating) has no fixture to
  //    score; an unresolvable side has no key at all.
  const sideA = identity(record.teamA, record.league);
  const sideB = identity(record.teamB, record.league);
  if (!sideA || !sideB) return { reason: 'identity_unresolved' };
  if (sideA === sideB) return { reason: 'team_scoped_record' };
  const pairKey = recordPairKey(record);
  if (!pairKey) return { reason: 'identity_unresolved' };

  // 3. The result. No settled outcome yet is a legitimate state - the row becomes
  //    the evaluator's `unmatched` bucket, which is never graded. An outcome
  //    naming a side outside this fixture is a defect and is excluded entirely,
  //    and so is a fixture that more than one settled outcome claims: one
  //    prediction row cannot be attributed to one of two games.
  const found = outcomeFor(outcomes, pairKey);
  if (found && found.ambiguous) return { reason: 'ambiguous_fixture' };
  const outcome = found ? found.row : null;
  let result = null;
  if (outcome) {
    result = outcomeSideFor(record, outcome);
    if (result === null) return { reason: 'winner_not_in_matchup' };
  }

  const market = marketFor(markets, pairKey, record.market);
  const row = {
    source,
    league: record.league,
    // The market the PROBABILITY is scoped to, taken from the record only. A
    // market input's own label never lands here: it says which close we compared
    // against, not what the model's number is about, and copying it would relabel
    // a win probability as a spread opinion.
    market: typeof record.market === 'string' && record.market.trim() !== '' ? record.market.trim() : null,
    selection: record.teamA,
    modelWinProbability: probability,
    modelWinProbabilityKind: kind,
    matched: outcome !== null,
    outcome: result,
    // The source's own as-of date IS the decision time: it is when the model was
    // computed from games through that date. The evaluator then applies the
    // layer's shared recency window against `gameTimestamp`.
    predictionTimestamp: typeof record.asOf === 'string' && record.asOf !== '' ? record.asOf : null,
    sourceTimestamp: typeof record.asOf === 'string' && record.asOf !== '' ? record.asOf : null
  };
  if (outcome) {
    if (typeof outcome.gameTimestamp === 'string' && outcome.gameTimestamp !== '') {
      row.gameTimestamp = outcome.gameTimestamp;
    }
    if (typeof outcome.settledAt === 'string' && outcome.settledAt !== '') {
      row.settledAt = outcome.settledAt;
    }
  }
  if (market) {
    const fair = finiteNumber(market.marketFairProbability);
    if (fair !== null) row.marketFairProbability = fair;
    const closing = finiteNumber(market.closingOdds);
    if (closing !== null) row.closingOdds = closing;
    const decision = finiteNumber(market.odds);
    if (decision !== null) row.odds = decision;
  }

  return { row };
}

/**
 * Why a source can or cannot be scored on a probability.
 *
 * @param {unknown} source
 * @returns {{ available: boolean, kind: 'published' | 'derived' | null, reason: string }}
 */
function probabilitySupport(source) {
  const entry = isPlainObject(source) ? null : PROBABILITY_SUPPORT[String(source)];
  if (entry) return { available: entry.available, kind: entry.kind, reason: entry.reason };
  return {
    available: false,
    kind: null,
    reason: `${String(source)} is not a source in the ratings contract`
  };
}

/**
 * Turn adapter records plus settled outcomes (and optionally recorded market
 * closes) into the rows `lib/ssb-external-ratings-evaluation.js` scores.
 *
 * `records` accepts the shadow overlay's own input vocabulary: adapter envelopes
 * (`{ source, records }`), a source-keyed map, or a flat record list. `outcomes`
 * are settled results (`{ league, game, winner, gameTimestamp?, settledAt? }`)
 * where `winner` names one of the two sides (`'draw'` means neither won) and
 * `game` is the same matchup label a candidate row uses. `markets` carry the
 * de-vigged close (`{ league, game, market?, marketFairProbability, closingOdds?,
 * odds? }`) for the market-relative gate.
 *
 * A market input's `market` must match the RECORD's own scope, and a
 * market-wildcard record is served only by a market-less input: a carried
 * probability is a win probability, so it must never be compared against another
 * market's closing line, and the row's `market` is never taken from the market
 * input (that would relabel a win probability as a spread opinion).
 *
 * @param {{ records?: unknown, outcomes?: Array<Object>, markets?: Array<Object> }} [options]
 * @returns {{ rows: Array<Object>, sources: Object<string, Object>, skipped: Array<Object>, counts: Object }}
 */
function buildRatingEvaluationRows(options) {
  const opts = isPlainObject(options) ? options : {};
  const bySource = recordsBySource(opts.records);

  const outcomes = indexOutcomes(isList(opts.outcomes));
  const markets = indexMarkets(isList(opts.markets));

  let recordsSeen = 0;
  let recordsSkipped = 0;
  let inputSkipped = 0;
  let joined = 0;

  // reason -> { source, reason, count, sample[] }. One aggregation for both the
  // per-record drops and the input-level problems, so every exclusion is
  // reported in one place.
  const excluded = new Map();
  const note = (source, reason, sample) => {
    const key = `${source === null ? '' : source}|${reason}`;
    let entry = excluded.get(key);
    if (!entry) {
      entry = { source: source === null ? null : source, reason, count: 0, sample: [] };
      excluded.set(key, entry);
    }
    entry.count += 1;
    if (entry.sample.length < 3) entry.sample.push(sample);
  };
  for (const problem of outcomes.problems) {
    note(null, problem.reason, problem.sample);
    inputSkipped += 1;
  }
  for (const problem of markets.problems) {
    note(null, problem.reason, problem.sample);
    inputSkipped += 1;
  }

  const rows = [];
  /** @type {Object<string, Object>} */
  const sources = {};
  for (const source of SOURCES) {
    const support = probabilitySupport(source);
    const recordList = bySource[source];
    recordsSeen += recordList.length;
    let sourceJoined = 0;
    let sourceRows = 0;

    for (const record of recordList) {
      const built = rowForRecord({ source, support, record, outcomes: outcomes.index, markets: markets.index });
      if (built.reason) {
        note(source, built.reason, describeRecord(record));
        recordsSkipped += 1;
        continue;
      }
      /** @type {Record<string, any>} */
      const row = /** @type {any} */ (built.row);
      rows.push(row);
      sourceRows += 1;
      if (row.matched) {
        sourceJoined += 1;
        joined += 1;
      }
    }

    sources[source] = {
      source,
      records: recordList.length,
      rows: sourceRows,
      joined: sourceJoined,
      unmatched: sourceRows - sourceJoined,
      probability: support
    };
  }

  const skipped = [...excluded.values()].sort(
    (a, b) => String(a.source).localeCompare(String(b.source)) || a.reason.localeCompare(b.reason)
  );

  return {
    rows,
    sources,
    skipped,
    counts: {
      records: recordsSeen,
      rows: rows.length,
      joined,
      unmatched: rows.length - joined,
      // `records - recordsSkipped === rows`: every offered record either became a
      // row or was excluded for a stated reason.
      recordsSkipped,
      inputSkipped,
      // Usable input rows: the ones that are not problems and did not collide.
      outcomes: outcomes.usable,
      markets: markets.usable
    }
  };
}

module.exports = { buildRatingEvaluationRows, probabilitySupport, PROBABILITY_SUPPORT, WILDCARD };
