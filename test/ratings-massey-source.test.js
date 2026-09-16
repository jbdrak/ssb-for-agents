'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportedLeagues, validateRatingRecord } = require('../lib/ssb-ratings-contract');
const { getSupportedLeagues } = require('../lib/league-presets');
const massey = require('../lib/ratings-sources/massey');

// A handful of hand-built rows in the shape of Massey's per-sport ratings
// export: a title line carrying "Using games thru", then the ratings header,
// then one row per team. These are NOT a real Massey dump (their terms reserve
// all rights); they reproduce the exact column layout so the adapter is
// exercised against one team in each registry state:
//
//   - Indiana        a plain registry hit
//   - Ohio St        a `St`/`State` abbreviation the canonicalizer must expand
//   - Hawai'i        an accented spellings the canonicalizer must fold
//   - Nowhere Tech   an unregistered program -> unresolved, never a guess
//   - Broken Row     a present team with an unreadable `Rat` -> partial coverage
//   - Correlation    the table's own correlation footer, not a team
//
// The `Rat`/`Pwr`/`Off`/`Def`/`SoS` cells are modelled with the leading rank
// Massey prints (`6 8.94`); HFA is printed bare (`2.29`), matching the live page.
const CSV_FIXTURE = `College Football : FBS Using games thru Sun, Sep 13, 2026
Team,Rec,Δ,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL
Correlation,669,,1000,978,945,948,-79,257,788,630,-599
Indiana,2-0 1.000,+1,1 9.10,3 83.65,3 69.32,2 42.20,2.14,71 50.14,40 63.59,8.59,1.41
Ohio St,1-1 0.500,-5,6 8.94,1 85.17,6 68.02,1 45.01,2.29,5 68.11,16 67.14,8.60,1.40
Hawai'i,1-1 0.500,+2,90 7.10,102 47.38,88 55.00,95 28.00,2.10,120 20.00,110 40.00,3.00,9.00
Nowhere Tech,0-1 0.000,+3,131 5.00,130 40.00,131 40.00,130 20.00,2.20,131 10.00,131 10.00,1.00,11.00
Broken Row,,,not-a-number
`;

// Same data, columns in a different order: the adapter must map by header name,
// not by position.
const PERMUTED_FIXTURE = `College Football : FBS Using games thru Sun, Sep 13, 2026
HFA,Def,Rat,Team,Off,Pwr,SoS
2.14,42.20,9.10,Indiana,69.32,83.65,50.14
`;

// A header but zero team rows: unavailable, never a vacuous empty success.
const HEADER_ONLY_FIXTURE = `College Football : FBS Using games thru Sun, Sep 13, 2026
Team,Rec,Δ,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL
`;

const FETCHED_AT = '2026-09-15T12:00:00.000Z';

function normalize(overrides = {}) {
  return massey.normalizeMassey({
    raw: CSV_FIXTURE,
    league: 'NCAAF',
    fetchedAt: FETCHED_AT,
    ...overrides
  });
}

function byTeam(result, name) {
  const record = result.records.find((row) => row.teamA === name);
  assert.ok(record, `expected a record for ${name}`);
  return record;
}

describe('massey source adapter: normalize', () => {
  it('parses the ratings export into contract records', () => {
    const result = normalize();

    assert.equal(result.source, 'massey');
    assert.equal(result.league, 'NCAAF');
    assert.equal(result.coverage, 'full');
    assert.equal(result.method, 'overall');
    assert.equal(result.season, 2026);
    assert.equal(result.records.length, 5);
    assert.match(result.sourceHash, /^[0-9a-f]{64}$/);
    assert.ok(result.records.every((record) => record.sourceHash === result.sourceHash));
    assert.ok(result.records.every((record) => record.method === 'overall'));
    assert.ok(result.records.every((record) => record.matchStatus !== 'matched'));
    assert.equal(result.sourceUrl, massey.pageUrlFor('NCAAF'));
  });

  it('takes asOf from the "Using games thru" line, separate from fetchedAt', () => {
    const result = normalize();
    assert.equal(result.asOf, '2026-09-13');
    assert.notEqual(result.asOf, result.fetchedAt);
    assert.equal(result.fetchedAt, FETCHED_AT);
    assert.ok(result.records.every((record) => record.asOf === result.asOf));
    assert.ok(result.records.every((record) => record.fetchedAt === FETCHED_AT));
  });

  it('maps the Rat column to ratingA/ratingB and HFA to homeAdvantage', () => {
    const result = normalize();

    const indiana = byTeam(result, 'Indiana');
    assert.equal(indiana.ratingA, 9.1);
    assert.equal(indiana.ratingB, 9.1);
    assert.equal(indiana.homeAdvantage, 2.14);

    const ohio = byTeam(result, 'Ohio State');
    assert.equal(ohio.ratingA, 8.94);
    assert.equal(ohio.homeAdvantage, 2.29);

    // Pwr/Off/Def/SoS have no contract field yet, so they are deliberately
    // dropped rather than smuggled onto the record.
    assert.deepEqual(Object.keys(indiana).sort(), Object.keys(validateRatingRecord(indiana).record).sort());
    assert.equal(indiana.pwr, undefined);
    assert.equal(indiana.off, undefined);
    assert.equal(indiana.def, undefined);
    assert.equal(indiana.sos, undefined);
  });

  it('maps columns by header name so a reordered export still resolves', () => {
    const result = normalize({ raw: PERMUTED_FIXTURE });
    assert.equal(result.asOf, '2026-09-13');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].teamA, 'Indiana');
    assert.equal(result.records[0].ratingA, 9.1);
    assert.equal(result.records[0].homeAdvantage, 2.14);
  });

  it('routes names through the cross-source canonicalizer', () => {
    const result = normalize();

    // `St`/`State` expansion and accent folding come from the shared module.
    assert.equal(byTeam(result, 'Ohio State').teamA, 'Ohio State');
    assert.equal(byTeam(result, "Hawai'i").teamA, "Hawai'i");

    const unknown = byTeam(result, 'Nowhere Tech');
    assert.equal(unknown.matchStatus, 'unresolved');
    assert.match(unknown.unresolvedReason, /Nowhere Tech/);
    assert.match(unknown.unresolvedReason, /NCAAF/);
  });

  it('keeps an unreadable rating row but degrades its coverage', () => {
    const broken = byTeam(normalize(), 'Broken Row');
    assert.equal(broken.ratingA, null);
    assert.equal(broken.coverage, 'partial');
  });

  it('skips the table correlation footer and blank lines', () => {
    const result = normalize();
    assert.ok(!result.records.some((record) => /correlation/i.test(record.teamA)));
    assert.equal(result.skipped.length, 0);
  });

  it('produces records the contract validator accepts', () => {
    for (const record of normalize().records) {
      const { ok, errors } = validateRatingRecord(record);
      assert.deepEqual(errors, []);
      assert.equal(ok, true);
    }
  });

  it('reports a header-only export as unavailable, not empty success', () => {
    const result = normalize({ raw: HEADER_ONLY_FIXTURE });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.ok(result.unresolvedReason.length > 0);
  });

  it('reports an export with no ratings header as unavailable', () => {
    const result = normalize({ raw: 'nothing useful here\n' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /header/i);
  });
});

describe('massey source adapter: coverage', () => {
  it('exposes exactly the contract-supported Massey leagues', () => {
    assert.deepEqual(massey.supportedLeagues(), supportedLeagues('massey'));
    assert.ok(massey.supportedLeagues().includes('MLB'));
    assert.ok(massey.supportedLeagues().includes('WNBA'));
    assert.ok(!massey.supportedLeagues().includes('NCAAB'));
  });

  it('has a verified ratings page for every supported league', () => {
    for (const league of massey.supportedLeagues()) {
      assert.match(massey.pageUrlFor(league), /^https:\/\/masseyratings\.com\/.+\/ratings$/);
    }
  });

  it('reports a canonical league it does not cover as unavailable with a sport-specific reason', () => {
    // NCAAB is a real canonical league (the contract lists it); this adapter
    // simply does not cover it. The gap must read as a stated reason, never an
    // empty table that is indistinguishable from a quiet day.
    const reason = massey.unsupportedReason('NCAAB');
    assert.ok(reason, 'NCAAB must carry an unsupported reason');
    assert.match(reason, /NCAAB/);
    // Massey does publish a college-basketball ratings page, so the reason must
    // not claim the source lacks the sport, and it is a real league, so it is
    // not the unrecognized-code reason either.
    assert.doesNotMatch(reason, /not published/i);
    assert.doesNotMatch(reason, /not a canonical league code/i);

    const result = normalize({ league: 'NCAAB' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.equal(result.unresolvedReason, reason);
    assert.equal(result.source, 'massey');
  });

  it('names the source for a canonical league it does not publish', () => {
    // UFC and Tennis are canonical SSB leagues (lib/league-presets.js); Massey
    // publishes no team ratings for either. The reason must say so and name the
    // source, never claim the code is not a league.
    for (const league of ['UFC', 'TENNIS']) {
      const reason = massey.unsupportedReason(league);
      assert.ok(reason, `${league} must carry an unsupported reason`);
      assert.match(reason, /massey/i);
      assert.doesNotMatch(reason, /not a canonical league code|not a recognized league code/i);

      const result = normalize({ league });
      assert.equal(result.coverage, 'unavailable');
      assert.deepEqual(result.records, []);
      assert.equal(result.league, league);
      assert.equal(result.unresolvedReason, reason);
    }
  });

  it('never calls a repo league code unrecognized', () => {
    // Every league in the repo's registry either resolves a page or gets a
    // scope reason from this adapter; none of them is "not a league".
    const mapped = new Set([...massey.supportedLeagues(), 'NCAAB']);
    for (const league of getSupportedLeagues()) {
      if (mapped.has(league)) continue;
      const reason = massey.unsupportedReason(league);
      assert.ok(reason, `${league} must carry a reason`);
      assert.ok(reason.includes(league), `${league} reason must name the league`);
      assert.match(reason, /massey/i);
      assert.doesNotMatch(reason, /not a recognized league code/i);
    }
  });

  it('tells an unrecognized league code apart from a canonical sport', () => {
    const typo = massey.unsupportedReason('NCAFF');
    assert.match(typo, /not a recognized league code/i);
    // Distinct from a real-sport scope gap and from a covered sport.
    assert.notEqual(typo, massey.unsupportedReason('UFC'));
    assert.notEqual(typo, massey.unsupportedReason('NCAAB'));
    assert.equal(massey.unsupportedReason('MLB'), null);
    assert.equal(massey.unsupportedReason('NCAAF'), null);
  });

  it('keeps the coverage map in step with the contract registry', () => {
    // Every contract-supported league must resolve a page and report no reason;
    // an uncovered league must resolve no page.
    for (const league of supportedLeagues('massey')) {
      assert.equal(massey.unsupportedReason(league), null);
      assert.ok(massey.pageUrlFor(league));
    }
    assert.deepEqual(massey.supportedLeagues().slice().sort(), supportedLeagues('massey').slice().sort());
    assert.equal(massey.pageUrlFor('NCAAB'), null);
    assert.equal(massey.pageUrlFor('UFC'), null);
  });
});

describe('massey source adapter: fetch', () => {
  it('fetches the league ratings page through the injected transport', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => CSV_FIXTURE };
    };

    const result = await massey.fetchMassey({ league: 'NCAAF', fetchImpl, now: FETCHED_AT });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, massey.pageUrlFor('NCAAF'));
    assert.equal(result.raw, CSV_FIXTURE);
    assert.equal(result.sourceUrl, massey.pageUrlFor('NCAAF'));
    assert.equal(result.fetchedAt, FETCHED_AT);
  });

  it('honours an explicit export URL resolved from the page action', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => CSV_FIXTURE };
    };

    const result = await massey.fetchMassey({
      league: 'NFL',
      fetchImpl,
      exportUrl: 'https://masseyratings.com/nfl/ratings?export=1'
    });

    assert.equal(calls[0], 'https://masseyratings.com/nfl/ratings?export=1');
    assert.equal(result.exportUrl, 'https://masseyratings.com/nfl/ratings?export=1');
    // Provenance still points at the human-facing page.
    assert.equal(result.sourceUrl, massey.pageUrlFor('NFL'));
  });

  it('requires an injected fetch and rejects an unsupported league', async () => {
    await assert.rejects(() => massey.fetchMassey({ league: 'NCAAF' }), /fetchImpl/);

    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
    await assert.rejects(() => massey.fetchMassey({ league: 'NCAAB', fetchImpl }), /NCAAB/);
  });
});
