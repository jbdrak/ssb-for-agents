'use strict';

// Normalized external-ratings record contract.
//
// Every ratings source (Massey, Sagarin, Sasser) normalizes into this one shape so
// nothing downstream needs to know which source produced a record. Validation is
// pure (no network, no I/O) and fails closed: missing or ambiguous provenance stays
// an explicit error, and an unusable number becomes null with degraded coverage
// rather than a guessed value.

const SOURCES = Object.freeze(['massey', 'sagarin', 'sasser']);

const COVERAGE_VALUES = Object.freeze(['full', 'partial', 'unavailable']);
const MATCH_STATUS_VALUES = Object.freeze(['matched', 'unmatched', 'unresolved']);

// Canonical league codes shared with the rest of the repo (see lib/ssb-query-parser.js).
const CANONICAL_LEAGUES = Object.freeze(['MLB', 'MLS', 'NBA', 'NCAAB', 'NCAAF', 'NFL', 'NHL', 'WNBA']);

// Per-source coverage, alphabetized. Massey is the only source with MLB team ratings;
// Sagarin's baseball page is player ratings, so MLB is deliberately absent there.
const SUPPORTED_LEAGUES = Object.freeze({
  massey: Object.freeze(['MLB', 'MLS', 'NBA', 'NCAAF', 'NFL', 'NHL', 'WNBA']),
  sagarin: Object.freeze(['MLS', 'NBA', 'NCAAB', 'NCAAF', 'NFL', 'NHL']),
  sasser: Object.freeze(['NCAAF'])
});

const NUMERIC_FIELDS = Object.freeze([
  'ratingA',
  'ratingB',
  'predictedScoreA',
  'predictedScoreB',
  'predictedTotal',
  'predictedMargin',
  'homeAdvantage',
  'marketOpen',
  'marketCurrent'
]);

const IDENTITY_FIELDS = Object.freeze(['teamA', 'teamB', 'sourceUrl', 'sourceHash']);

function supportedLeagues(source) {
  const leagues = SUPPORTED_LEAGUES[source];
  return leagues ? leagues.slice() : [];
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isDateString(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function toFiniteNumber(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null ? 'null' : typeof value;
}

/**
 * Normalize and validate one external-ratings record.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, record: Record<string, any> | null, errors: string[] }}
 */
function validateRatingRecord(input) {
  if (!isPlainObject(input)) {
    return { ok: false, record: null, errors: ['record must be a plain object'] };
  }
  const raw = /** @type {Record<string, any>} */ (input);
  const errors = [];

  /** @type {Record<string, any>} */
  const record = {
    source: null,
    method: null,
    league: null,
    season: null,
    asOf: null,
    fetchedAt: null,
    sourceUrl: null,
    sourceHash: null,
    eventId: null,
    teamA: null,
    teamB: null,
    neutral: null,
    ratingA: null,
    ratingB: null,
    predictedScoreA: null,
    predictedScoreB: null,
    predictedTotal: null,
    predictedMargin: null,
    homeAdvantage: null,
    marketOpen: null,
    marketCurrent: null,
    coverage: null,
    matchStatus: null,
    unresolvedReason: null
  };

  if (!SOURCES.includes(raw.source)) {
    errors.push(`invalid source: ${formatValue(raw.source)}`);
  } else {
    record.source = raw.source;
  }

  if (!CANONICAL_LEAGUES.includes(raw.league)) {
    errors.push(`invalid league: ${formatValue(raw.league)}`);
  } else if (record.source !== null && !SUPPORTED_LEAGUES[record.source].includes(raw.league)) {
    errors.push(`league ${raw.league} is not published by ${record.source}`);
  } else {
    record.league = raw.league;
  }

  for (const field of IDENTITY_FIELDS) {
    if (isNonEmptyString(raw[field])) record[field] = raw[field];
    else errors.push(`missing or invalid ${field}`);
  }

  for (const field of ['method', 'eventId']) {
    if (raw[field] === null || raw[field] === undefined) record[field] = null;
    else if (isNonEmptyString(raw[field])) record[field] = raw[field];
    else errors.push(`invalid ${field}`);
  }

  if (isDateString(raw.fetchedAt)) record.fetchedAt = raw.fetchedAt;
  else errors.push('missing or invalid fetchedAt');

  if (raw.asOf === null || raw.asOf === undefined) record.asOf = null;
  else if (isDateString(raw.asOf)) record.asOf = raw.asOf;
  else errors.push('invalid asOf');

  record.season = toFiniteNumber(raw.season);
  record.neutral = typeof raw.neutral === 'boolean' ? raw.neutral : null;

  let degraded = false;
  for (const field of NUMERIC_FIELDS) {
    if (raw[field] === null || raw[field] === undefined) continue;
    const value = toFiniteNumber(raw[field]);
    if (value === null) degraded = true;
    else record[field] = value;
  }

  if (!COVERAGE_VALUES.includes(raw.coverage)) {
    errors.push(`invalid coverage: ${formatValue(raw.coverage)}`);
  } else {
    record.coverage = raw.coverage;
  }

  if (!MATCH_STATUS_VALUES.includes(raw.matchStatus)) {
    errors.push(`invalid matchStatus: ${formatValue(raw.matchStatus)}`);
  } else {
    record.matchStatus = raw.matchStatus;
  }

  if (raw.unresolvedReason === null || raw.unresolvedReason === undefined) record.unresolvedReason = null;
  else if (isNonEmptyString(raw.unresolvedReason)) record.unresolvedReason = raw.unresolvedReason;
  else errors.push('invalid unresolvedReason');

  if (record.matchStatus === 'unresolved' && record.unresolvedReason === null) {
    errors.push('unresolved records require unresolvedReason');
  }

  // Fail closed: an unusable numeric cannot leave coverage claiming a complete record.
  if (degraded && record.coverage === 'full') record.coverage = 'partial';

  return { ok: errors.length === 0, record, errors };
}

module.exports = { SOURCES, supportedLeagues, validateRatingRecord };
