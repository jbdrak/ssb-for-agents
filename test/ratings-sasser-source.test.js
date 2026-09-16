'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportedLeagues, validateRatingRecord } = require('../lib/ssb-ratings-contract');
const sasser = require('../lib/ratings-sources/sasser');

// Format-accurate excerpt of davidsasser.com/cfb. The page is a Next.js app that
// server-renders its per-game model data inside the RSC flight stream as
// `self.__next_f.push([1,"<escaped stream>"])`; the fixture carries a handful of
// real Week-3 games (a handful of rows, NOT a dataset) so the adapter meets the
// exact payload shape: `week.season`, a `week.updatedAt` line, and per game a
// `projection` (home/away scores), a `market` (opening/current/projected lines)
// and a `picks.spread`. One test substitutes an unknown program name in memory
// (never in this file) so the fail-closed path runs over the real payload shape.
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'ratings', 'sasser-cfb-2026-w3.html');
const FIXTURE_HTML = fs.readFileSync(FIXTURE_PATH, 'utf8');

const FETCHED_AT = '2026-09-15T12:00:00.000Z';

function normalize(overrides = {}) {
  return sasser.normalizeSasser({
    raw: FIXTURE_HTML,
    league: 'NCAAF',
    fetchedAt: FETCHED_AT,
    ...overrides
  });
}

function byEvent(result, id) {
  const record = result.records.find((row) => row.eventId === id);
  assert.ok(record, `expected a record for event ${id}`);
  return record;
}

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !~ ${expected}`);
}

describe('sasser source adapter: normalize', () => {
  it('extracts the week payload into contract records', () => {
    const result = normalize();

    assert.equal(result.source, 'sasser');
    assert.equal(result.league, 'NCAAF');
    assert.equal(result.method, 'model_v1');
    assert.equal(result.season, 2026);
    // A per-game projection overlay is partial by design: it publishes no team rating.
    assert.equal(result.coverage, 'partial');
    assert.equal(result.records.length, 5);
    assert.equal(result.skipped.length, 0);
    assert.match(result.sourceHash, /^[0-9a-f]{64}$/);
    assert.ok(result.records.every((record) => record.sourceHash === result.sourceHash));
    assert.ok(result.records.every((record) => record.method === 'model_v1'));
    assert.ok(result.records.every((record) => record.coverage === 'partial'));
    assert.ok(result.records.every((record) => record.ratingA === null && record.ratingB === null));
    assert.equal(result.sourceUrl, 'https://davidsasser.com/cfb');
  });

  it('takes asOf from the page\'s "Updated" line, separate from fetchedAt', () => {
    const result = normalize();
    // The page prints "Monday, September 14 · 11:30 AM CT" for a 2026 season.
    assert.equal(result.asOf, '2026-09-14');
    assert.notEqual(result.asOf, result.fetchedAt);
    assert.equal(result.fetchedAt, FETCHED_AT);
    assert.ok(result.records.every((record) => record.asOf === '2026-09-14'));
    assert.ok(result.records.every((record) => record.fetchedAt === FETCHED_AT));
  });

  it('maps the projected scores, total and margin with the home team as teamA', () => {
    const result = normalize();
    const pittsburgh = byEvent(result, '401858225');

    assert.equal(pittsburgh.teamA, 'Pittsburgh');
    assert.equal(pittsburgh.teamB, 'Syracuse');
    assert.equal(pittsburgh.neutral, false);
    assert.equal(pittsburgh.predictedScoreA, 30.23007775);
    assert.equal(pittsburgh.predictedScoreB, 16.806360249999997);
    closeTo(pittsburgh.predictedTotal, 47.036438, 'predicted total');
    closeTo(pittsburgh.predictedMargin, 13.4237175, 'predicted margin');
  });

  it('orients the market lines to teamA (home) instead of the favorite', () => {
    const result = normalize();

    // Home favorite: the printed "Pittsburgh −10.5" is already teamA-relative.
    const pittsburgh = byEvent(result, '401858225');
    assert.equal(pittsburgh.marketOpen, -10.5);
    assert.equal(pittsburgh.marketCurrent, -10.5);

    // Away favorite naming teamB must be flipped so it stays teamA-relative:
    // Wake Forest is a home underdog, so the line is positive for teamA.
    const wakeForest = byEvent(result, '401858226');
    assert.equal(wakeForest.marketOpen, 19.5);
    assert.equal(wakeForest.marketCurrent, 21.0);
    closeTo(wakeForest.predictedMargin, -18.097485, 'predicted margin');

    // A line that moved between open and current keeps both values.
    const texasTech = byEvent(result, '401856811');
    assert.equal(texasTech.marketOpen, -13.5);
    assert.equal(texasTech.marketCurrent, -7.5);
  });

  it('carries the neutral-site marker and the venue-order home/away teams', () => {
    const result = normalize();
    const neutral = byEvent(result, '401856812');

    assert.equal(neutral.neutral, true);
    assert.equal(neutral.teamA, 'Kansas');
    assert.equal(neutral.teamB, 'Arizona State');
    closeTo(neutral.predictedMargin, -1.4007415, 'neutral-site margin');
  });

  it('routes names through the cross-source canonicalizer and fails closed on an unknown program', () => {
    const result = normalize();

    assert.equal(byEvent(result, '401858225').matchStatus, 'unmatched');

    const tulane = byEvent(result, '401856792');
    // Tulane is a registered FBS program, so both sides of the game resolve.
    assert.equal(tulane.teamA, 'Kansas State');
    assert.equal(tulane.teamB, 'Tulane');
    assert.equal(tulane.matchStatus, 'unmatched');

    // A program the registry does not seed stays unresolved rather than guessed.
    // The captured fixture bytes are left intact; the unknown name is swapped in
    // memory so the real parser still runs over the real payload shape.
    const unknown = sasser.normalizeSasser({
      raw: FIXTURE_HTML.replace(/Tulane/g, 'Nowhere Tech'),
      league: 'NCAAF',
      fetchedAt: FETCHED_AT
    });
    const unresolvedGame = unknown.records.find((row) => row.eventId === '401856792');
    assert.ok(unresolvedGame, 'the substituted game must still parse');
    assert.equal(unresolvedGame.teamA, 'Kansas State');
    assert.equal(unresolvedGame.teamB, 'Nowhere Tech');
    assert.equal(unresolvedGame.matchStatus, 'unresolved');
    assert.match(unresolvedGame.unresolvedReason, /Nowhere Tech/);
    assert.match(unresolvedGame.unresolvedReason, /NCAAF/);
  });

  it('produces records the contract validator accepts', () => {
    for (const record of normalize().records) {
      const { ok, errors } = validateRatingRecord(record);
      assert.deepEqual(errors, []);
      assert.equal(ok, true);
    }
  });

  it('reports a non-CFB league as unavailable with a reason', () => {
    const result = normalize({ league: 'NFL' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.equal(result.source, 'sasser');
    assert.match(result.unresolvedReason, /NFL/);
  });

  it('reports a page with no model payload as unavailable, not empty success', () => {
    const result = normalize({ raw: '<html><body>portfolio</body></html>' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /payload|week/i);
  });
});

describe('sasser source adapter: coverage', () => {
  it('is CFB only and matches the contract registry', () => {
    assert.deepEqual(sasser.supportedLeagues(), ['NCAAF']);
    assert.deepEqual(sasser.supportedLeagues(), supportedLeagues('sasser'));
  });

  it('resolves only the /cfb model page', () => {
    assert.equal(sasser.pageUrlFor('NCAAF'), 'https://davidsasser.com/cfb');
    assert.equal(sasser.pageUrlFor('CFB'), 'https://davidsasser.com/cfb');
    assert.equal(sasser.pageUrlFor('NFL'), null);
  });

  it('separates a real-league scope gap from an unrecognized code', () => {
    assert.equal(sasser.unsupportedReason('NCAAF'), null);
    assert.equal(sasser.unsupportedReason('CFB'), null);

    const scopeGap = sasser.unsupportedReason('NFL');
    assert.match(scopeGap, /NFL/);
    assert.match(scopeGap, /not covered/i);
    assert.doesNotMatch(scopeGap, /not a canonical league code|not a recognized league code/i);

    // UFC and Tennis are canonical SSB leagues (lib/league-presets.js) Sasser
    // simply does not cover: the reason names the source, never the code.
    for (const league of ['UFC', 'TENNIS']) {
      const reason = sasser.unsupportedReason(league);
      assert.ok(reason, `${league} must carry a reason`);
      assert.match(reason, /sasser/i);
      assert.doesNotMatch(reason, /not a canonical league code|not a recognized league code/i);
    }

    const typo = sasser.unsupportedReason('NCAFF');
    assert.match(typo, /not a recognized league code/i);
    assert.notEqual(typo, scopeGap);
  });
});

describe('sasser source adapter: fetch', () => {
  it('fetches the /cfb page through the injected transport', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => FIXTURE_HTML };
    };

    const result = await sasser.fetchSasser({ league: 'NCAAF', fetchImpl, now: FETCHED_AT });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://davidsasser.com/cfb');
    assert.equal(result.raw, FIXTURE_HTML);
    assert.equal(result.sourceUrl, 'https://davidsasser.com/cfb');
    assert.equal(result.fetchedAt, FETCHED_AT);
  });

  it('refuses an unsupported league without hitting the network', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '' };
    };

    await assert.rejects(() => sasser.fetchSasser({ league: 'NFL', fetchImpl }), /NFL/);
    assert.equal(called, false);
  });

  it('throws on a non-2xx response and requires an injected fetch', async () => {
    const failing = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(() => sasser.fetchSasser({ league: 'NCAAF', fetchImpl: failing }), /503/);
    await assert.rejects(() => sasser.fetchSasser({ league: 'NCAAF' }), /fetchImpl/);
  });
});
