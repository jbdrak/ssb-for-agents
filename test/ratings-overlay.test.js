'use strict';

// Task 10 (external-ratings benchmark): the additive shadow overlay.
//
// The overlay attaches external ratings to candidate rows and (via the
// record-candidates feature snapshot) into the ledger. It must be provably
// rank-neutral: it only ADDS `row.ratings`, never touches kaiCall/tier/
// verdict/edge/score fields, and never clobbers a pre-existing row.ratings.
//
// Every test here is hermetic: pure records in, rows out, no network, no I/O.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyRatingsOverlay, canonicalGameKey } = require('../lib/ssb-ratings-overlay');

const clone = (value) => JSON.parse(JSON.stringify(value));

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FETCHED_AT = '2026-09-15T10:00:00.000Z';

// Two NCAAF games that SHARE the team "Ohio State". A name-only join attaches
// game 1's sagarin row to game 2's candidate row; the composite
// (league, canonical game identity, market) key must not.
const ROWS = [
  {
    league: 'NCAAF',
    market: 'Moneyline',
    gameId: 'NCAAF:GAME:UM:OSU:1',
    game: 'Michigan vs Ohio State',
    selection: 'Michigan',
    odds: -140,
    kaiCall: 'BET',
    displayTier: 'TIER 1',
    confidenceTier: 'TIER 1',
    finalVerdict: 'BET',
    consensusEdge: 4.2,
    screenScore: 8.1,
    riskScore: 0.12
  },
  {
    league: 'NCAAF',
    market: 'Moneyline',
    gameId: 'NCAAF:GAME:OSU:PSU:2',
    game: 'Ohio State vs Penn State',
    selection: 'Penn State',
    odds: 120,
    kaiCall: 'CONSIDER',
    displayTier: 'TIER 2',
    confidenceTier: 'TIER 2',
    finalVerdict: 'CONSIDER',
    consensusEdge: 1.5,
    screenScore: 6.4,
    riskScore: 0.44
  }
];

const SAGARIN_RECORDS = [
  {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-13',
    fetchedAt: FETCHED_AT,
    sourceUrl: 'http://sagarin.com/sports/cfsend.htm',
    sourceHash: HASH_A,
    teamA: 'Michigan',
    teamB: 'Ohio State',
    neutral: false,
    predictedScoreA: 31,
    predictedScoreB: 24,
    predictedTotal: 55,
    predictedMargin: -7.5,
    coverage: 'full',
    matchStatus: 'unmatched'
  },
  {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-13',
    fetchedAt: FETCHED_AT,
    sourceUrl: 'http://sagarin.com/sports/cfsend.htm',
    sourceHash: HASH_A,
    teamA: 'Ohio State',
    teamB: 'Penn State',
    neutral: false,
    predictedScoreA: 27,
    predictedScoreB: 24,
    predictedTotal: 51,
    predictedMargin: 3.5,
    coverage: 'full',
    matchStatus: 'unmatched'
  }
];

// Team-scoped Massey row: `teamA === teamB` means "no opponent published",
// so it joins on the canonical team and legitimately applies to every game
// that team plays (it is a team rating, not a game prediction).
const MASSEY_RECORDS = [
  {
    source: 'massey',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-14',
    fetchedAt: FETCHED_AT,
    sourceUrl: 'https://masseyratings.com/cf/fbs/ratings',
    sourceHash: HASH_B,
    teamA: 'Ohio State',
    teamB: 'Ohio State',
    neutral: null,
    ratingA: 92.4,
    ratingB: 92.4,
    coverage: 'full',
    matchStatus: 'unmatched'
  },
  {
    source: 'massey',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-14',
    fetchedAt: FETCHED_AT,
    sourceUrl: 'https://masseyratings.com/cf/fbs/ratings',
    sourceHash: HASH_B,
    teamA: 'Michigan',
    teamB: 'Michigan',
    neutral: null,
    ratingA: 88.1,
    ratingB: 88.1,
    coverage: 'full',
    matchStatus: 'unmatched'
  }
];

const ALL_RECORDS = [...SAGARIN_RECORDS, ...MASSEY_RECORDS];

const RANKING_FIELDS = [
  'kaiCall',
  'displayTier',
  'confidenceTier',
  'finalVerdict',
  'consensusEdge',
  'screenScore',
  'riskScore'
];

describe('canonicalGameKey', () => {
  it('is order-independent across a matchup and resolves aliases the same on both sides', () => {
    assert.equal(
      canonicalGameKey('Michigan vs Ohio State', 'NCAAF'),
      canonicalGameKey('Ohio State vs Michigan', 'NCAAF')
    );
    assert.equal(canonicalGameKey('Ohio St vs Michigan', 'CFB'), canonicalGameKey('Michigan vs Ohio State', 'NCAAF'));
  });

  it('returns null when either side cannot be canonicalized (fail closed, never a guessed key)', () => {
    assert.equal(canonicalGameKey('Michigan vs Nowhere Tech', 'NCAAF'), null);
    assert.equal(canonicalGameKey('Michigan', 'NCAAF'), null);
    assert.equal(canonicalGameKey(null, 'NCAAF'), null);
  });
});

describe('applyRatingsOverlay', () => {
  it('attaches each source under a composite (league, canonical game identity, market) key', () => {
    const rows = applyRatingsOverlay(clone(ROWS), { ratings: ALL_RECORDS });

    for (const source of ['massey', 'sagarin', 'sasser']) {
      assert.ok(Object.prototype.hasOwnProperty.call(rows[0].ratings, source), `${source} key must exist`);
    }
  });

  it('does not bleed one game\u2019s rating onto another that shares a team name', () => {
    const rows = applyRatingsOverlay(clone(ROWS), { ratings: ALL_RECORDS });

    // Provenance stamp: the attached entry carries the row's own game label.
    assert.equal(rows[0].ratings.sagarin.game, rows[0].game);
    assert.equal(rows[1].ratings.sagarin.game, rows[1].game);

    // Game-specific prediction: -7.5 belongs to UM/OSU only.
    assert.equal(rows[0].ratings.sagarin.records.length, 1);
    assert.equal(rows[0].ratings.sagarin.records[0].predictedMargin, -7.5);
    assert.equal(rows[0].ratings.sagarin.records[0].teamB, 'Ohio State');

    // A name-only join would have attached -7.5 here too; the composite key must not.
    assert.equal(rows[1].ratings.sagarin.records.length, 1);
    assert.equal(rows[1].ratings.sagarin.records[0].predictedMargin, 3.5);
  });

  it('joins a team-scoped (no-opponent) record to every game that team plays', () => {
    const rows = applyRatingsOverlay(clone(ROWS), { ratings: ALL_RECORDS });

    assert.equal(rows[0].ratings.massey.game, rows[0].game);
    assert.equal(rows[0].ratings.massey.records[0].ratingA, 88.1); // Michigan
    assert.equal(rows[0].ratings.massey.records[1].ratingA, 92.4); // Ohio State
    assert.equal(rows[1].ratings.massey.records.length, 1); // Ohio State only
    assert.equal(rows[1].ratings.massey.records[0].ratingA, 92.4);
  });

  it('reports every source explicitly, null when the source is unavailable', () => {
    const rows = applyRatingsOverlay(clone([{ league: 'Tennis', market: 'Moneyline', game: 'Alcaraz vs Sinner' }]), {
      ratings: ALL_RECORDS
    });
    assert.deepEqual(rows[0].ratings, { massey: null, sagarin: null, sasser: null, tennis_elo: null });
  });

  it('never clobbers a pre-existing row.ratings (only add)', () => {
    const preexisting = { massey: null, sagarin: { game: 'kept', records: [] }, sasser: null };
    const row = { ...clone(ROWS[0]), ratings: clone(preexisting) };
    const rows = applyRatingsOverlay([row], { ratings: ALL_RECORDS });
    assert.deepEqual(rows[0].ratings, preexisting);
  });

  it('scopes an optional record.market to that market only', () => {
    const spreadRecord = {
      source: 'sasser',
      method: 'model_v1',
      league: 'NCAAF',
      season: 2026,
      asOf: '2026-09-14',
      fetchedAt: FETCHED_AT,
      sourceUrl: 'https://davidsasser.com/cfb',
      sourceHash: HASH_B,
      market: 'Point Spread',
      teamA: 'Michigan',
      teamB: 'Ohio State',
      neutral: false,
      predictedScoreA: 31,
      predictedScoreB: 24,
      predictedTotal: 55,
      predictedMargin: 7,
      coverage: 'partial',
      matchStatus: 'unmatched'
    };
    const spreadRow = { ...clone(ROWS[0]), market: 'Point Spread' };
    const rows = applyRatingsOverlay(clone([ROWS[0], spreadRow]), { ratings: [spreadRecord] });
    assert.equal(rows[0].ratings.sasser, null); // Moneyline row must not get a spread-scoped record
    assert.equal(rows[1].ratings.sasser.records[0].predictedMargin, 7);
  });

  it('accepts adapter envelopes and source-keyed maps as well as a flat record list', () => {
    const byEnvelope = applyRatingsOverlay(clone(ROWS), {
      ratings: [
        { source: 'sagarin', league: 'NCAAF', records: SAGARIN_RECORDS },
        { source: 'massey', league: 'NCAAF', records: MASSEY_RECORDS }
      ]
    });
    const byMap = applyRatingsOverlay(clone(ROWS), {
      ratings: { sagarin: SAGARIN_RECORDS, massey: MASSEY_RECORDS }
    });
    const flat = applyRatingsOverlay(clone(ROWS), { ratings: ALL_RECORDS });
    assert.deepEqual(byEnvelope, flat);
    assert.deepEqual(byMap, flat);
  });

  it('walks result buckets ({ league, market, plays }) the way the scan hands them over', () => {
    const buckets = [{ league: 'NCAAF', market: 'Moneyline', plays: clone(ROWS) }];
    const result = applyRatingsOverlay(buckets, { ratings: ALL_RECORDS });
    assert.equal(result[0].plays[0].ratings.sagarin.records[0].predictedMargin, -7.5);
  });

  it('is rank-neutral: overlay off vs on differ only by ratings', () => {
    const off = clone(ROWS); // baseline: no overlay applied
    const on = applyRatingsOverlay(clone(ROWS), { ratings: ALL_RECORDS });

    // Named invariant fields are identical row for row.
    for (let i = 0; i < ROWS.length; i++) {
      for (const field of RANKING_FIELDS) {
        assert.equal(on[i][field], off[i][field], `${field} changed on row ${i}`);
      }
      // A pre-existing ratings key would have made the two runs indistinguishable.
      assert.equal(off[i].ratings, undefined);
      assert.notDeepEqual(on[i].ratings, off[i].ratings);
    }

    // Strongest form: strip `ratings` from the overlay run and the rows are byte-identical.
    const stripped = on.map((row) => {
      const copy = { ...row };
      delete copy.ratings;
      return copy;
    });
    assert.deepEqual(stripped, off);
  });

  it('does not attach a rating when the row has no resolvable game identity', () => {
    const rows = applyRatingsOverlay(clone([ROWS[0]]), { ratings: ALL_RECORDS });
    // Sanity control for the previous test: the same row WITHOUT a game resolves to nulls.
    const noGame = applyRatingsOverlay(clone([{ ...ROWS[0], game: undefined }]), { ratings: ALL_RECORDS });
    assert.equal(rows[0].ratings.sagarin.records[0].predictedMargin, -7.5);
    assert.equal(noGame[0].ratings.sagarin, null);
  });
});

describe('ledger survival', () => {
  // The overlay attaches to the raw plays that become candidates, so the
  // ratings only reach the ledger through the record-candidates feature
  // snapshot whitelist. Drop the `ratings: value('ratings')` line and this
  // field vanishes while every other test stays green.
  it('survives into the candidate featureSnapshot (whitelist line is load-bearing)', () => {
    const { normalizeScanCandidates } = require('../lib/record-candidates');

    const plays = clone(ROWS);
    applyRatingsOverlay(plays, { ratings: ALL_RECORDS });

    const candidates = normalizeScanCandidates([{ league: 'NCAAF', market: 'Moneyline', plays }], {
      scanId: 'scan-ratings'
    });

    const snapshot = candidates[0].featureSnapshot;
    assert.equal(snapshot.ratings.sagarin.game, candidates[0].game);
    assert.equal(snapshot.ratings.sagarin.records[0].predictedMargin, -7.5);
    assert.equal(snapshot.ratings.massey.records[0].ratingA, 88.1);

    // Snapshot is an isolated JSON-safe clone: mutating the row cannot reach it.
    candidates[0].ratings = { tampered: true };
    assert.equal(snapshot.ratings.sagarin.records[0].predictedMargin, -7.5);
  });

  it('records an explicit null when the overlay never ran on a play', () => {
    const { normalizeScanCandidates } = require('../lib/record-candidates');
    const candidates = normalizeScanCandidates([{ league: 'NCAAF', market: 'Moneyline', plays: [clone(ROWS[0])] }], {
      scanId: 'scan-no-overlay'
    });
    assert.equal(candidates[0].featureSnapshot.ratings, null);
  });
});
