'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOURCES, supportedLeagues, validateRatingRecord } = require('../lib/ssb-ratings-contract');

function validRecord(overrides = {}) {
  return {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-06T00:00:00Z',
    fetchedAt: '2026-09-08T12:00:00Z',
    sourceUrl: 'https://sagarin.example/cfsend.htm',
    sourceHash: 'sha256:0f1e2d3c',
    eventId: 'evt-1',
    teamA: 'Ohio State',
    teamB: 'Michigan',
    neutral: true,
    ratingA: 92.1,
    ratingB: 88.4,
    predictedScoreA: 31.2,
    predictedScoreB: 24.7,
    predictedTotal: 55.9,
    predictedMargin: 6.5,
    homeAdvantage: 2.4,
    marketOpen: -7.5,
    marketCurrent: -6.5,
    coverage: 'full',
    matchStatus: 'matched',
    unresolvedReason: null,
    ...overrides
  };
}

describe('ssb-ratings-contract', () => {
  it('accepts a fully populated valid record', () => {
    const { ok, record, errors } = validateRatingRecord(validRecord());
    assert.equal(ok, true);
    assert.deepEqual(errors, []);
    assert.equal(record.source, 'sagarin');
    assert.equal(record.league, 'NCAAF');
    assert.equal(record.ratingA, 92.1);
    assert.equal(record.coverage, 'full');
    assert.equal(record.matchStatus, 'matched');
  });

  it('normalizes to exactly the contract shape and does not mutate the input', () => {
    const input = validRecord();
    const snapshot = JSON.stringify(input);
    const { record } = validateRatingRecord(input);
    assert.deepEqual(Object.keys(record).sort(), [
      'asOf',
      'coverage',
      'eventId',
      'fetchedAt',
      'homeAdvantage',
      'league',
      'marketCurrent',
      'marketOpen',
      'matchStatus',
      'method',
      'neutral',
      'predictedMargin',
      'predictedScoreA',
      'predictedScoreB',
      'predictedTotal',
      'ratingA',
      'ratingB',
      'season',
      'source',
      'sourceHash',
      'sourceUrl',
      'teamA',
      'teamB',
      'unresolvedReason'
    ]);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('fails a record missing sourceUrl', () => {
    const { ok, errors } = validateRatingRecord(validRecord({ sourceUrl: undefined }));
    assert.equal(ok, false);
    assert.ok(errors.some((error) => /sourceUrl/.test(error)));
  });

  it('fails a record missing sourceHash', () => {
    const { ok, errors } = validateRatingRecord(validRecord({ sourceHash: '' }));
    assert.equal(ok, false);
    assert.ok(errors.some((error) => /sourceHash/.test(error)));
  });

  it('fails when asOf is present but fetchedAt is absent', () => {
    const { ok, errors } = validateRatingRecord(validRecord({ fetchedAt: undefined }));
    assert.equal(ok, false);
    assert.ok(errors.some((error) => /fetchedAt/.test(error)));
  });

  it('coerces a non-finite ratingA to null and forces coverage to partial', () => {
    const { ok, record } = validateRatingRecord(validRecord({ ratingA: Number.NaN }));
    assert.equal(ok, true);
    assert.equal(record.ratingA, null);
    assert.equal(record.coverage, 'partial');
  });

  it('treats Infinity and non-numeric strings as degraded numerics', () => {
    for (const bad of [Number.POSITIVE_INFINITY, 'not-a-number', {}]) {
      const { record } = validateRatingRecord(validRecord({ ratingB: bad }));
      assert.equal(record.ratingB, null);
      assert.equal(record.coverage, 'partial');
    }
  });

  it('does not degrade coverage when a numeric field is legitimately absent', () => {
    const { ok, record } = validateRatingRecord(
      validRecord({ ratingA: null, ratingB: null, coverage: 'partial', method: 'model_v1' })
    );
    assert.equal(ok, true);
    assert.equal(record.ratingA, null);
    assert.equal(record.coverage, 'partial');
  });

  it('does not downgrade an unavailable record even with degraded numerics', () => {
    const { record } = validateRatingRecord(
      validRecord({ coverage: 'unavailable', ratingA: Number.NaN, matchStatus: 'unmatched' })
    );
    assert.equal(record.coverage, 'unavailable');
  });

  it('fails an unknown source, league, coverage, or matchStatus', () => {
    assert.equal(validateRatingRecord(validRecord({ source: 'espn' })).ok, false);
    assert.equal(validateRatingRecord(validRecord({ league: 'EPL' })).ok, false);
    assert.equal(validateRatingRecord(validRecord({ coverage: 'provided' })).ok, false);
    assert.equal(validateRatingRecord(validRecord({ matchStatus: 'pending' })).ok, false);
  });

  it('fails a league its source does not publish', () => {
    const { ok, errors } = validateRatingRecord(validRecord({ source: 'sagarin', league: 'MLB' }));
    assert.equal(ok, false);
    assert.ok(errors.some((error) => /MLB/.test(error)));
  });

  it('requires a reason on unresolved records', () => {
    assert.equal(validateRatingRecord(validRecord({ matchStatus: 'unresolved', unresolvedReason: null })).ok, false);
    const resolved = validateRatingRecord(
      validRecord({ matchStatus: 'unresolved', unresolvedReason: 'no team alias match' })
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.record.unresolvedReason, 'no team alias match');
  });

  it('fails a non-object input without throwing', () => {
    for (const bad of [null, undefined, 'record', 42, []]) {
      const result = validateRatingRecord(bad);
      assert.equal(result.ok, false);
      assert.equal(result.record, null);
      assert.ok(result.errors.length > 0);
    }
  });

  it('exposes the three canonical sources', () => {
    assert.deepEqual(SOURCES, ['massey', 'sagarin', 'sasser']);
  });

  it('maps supported leagues per source, excluding MLB for sagarin and non-NCAAF for sasser', () => {
    assert.deepEqual(supportedLeagues('sasser'), ['NCAAF']);
    assert.ok(supportedLeagues('massey').includes('MLB'));
    assert.ok(supportedLeagues('massey').includes('WNBA'));
    assert.ok(supportedLeagues('sagarin').includes('NCAAF'));
    assert.ok(supportedLeagues('sagarin').includes('NCAAB'));
    assert.ok(!supportedLeagues('sagarin').includes('MLB'));
    assert.deepEqual(supportedLeagues('unknown-source'), []);
  });
});
