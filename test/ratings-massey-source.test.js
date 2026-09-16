'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportedLeagues, validateRatingRecord } = require('../lib/ssb-ratings-contract');
const { getSupportedLeagues } = require('../lib/league-presets');
const massey = require('../lib/ratings-sources/massey');
const masseyWeb = require('../lib/ratings-sources/massey-web');

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

// College basketball is off-season in mid-September, so the live NCAA D1 page's
// heading reads "Using games thru Preseason" and carries no date. Same column
// layout as the football export.
const NCAAB_CSV_FIXTURE = `College Basketball : NCAA D1 Using games thru Preseason
Team,Rec,Δ,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL
Indiana,0-0 0.000,+1,1 12.10,1 85.00,1 70.00,1 45.00,2.14,1 60.00,1 70.00,8.59,1.41
Ohio St,0-0 0.000,+2,6 10.94,6 80.17,6 68.02,1 45.01,2.29,5 68.11,16 67.14,8.60,1.40
`;

// ---------------------------------------------------------------------------
// Synthetic export *payload* fixtures for the transport (./massey-web).
// ---------------------------------------------------------------------------
//
// These are hand-built, not a Massey dump: the column layout mirrors the live
// ratings table so the adapter contract is exercised, and the numeric cells are
// put through the payload obfuscation below so the decoder has real work to do.
// `OBFU` is a synthetic stand-in for the page's `stamp.obfu` constant; its
// trailing digits are what the page itself parses as the decode seed.
const OBFU = '0123456789abcdef0123456789abcdef941';
const EXPORT_TITLES = [
  'Team',
  null,
  'Rec',
  null,
  '&Delta;',
  'Rat',
  null,
  'Pwr',
  null,
  'Off',
  null,
  'Def',
  null,
  'HFA',
  'SoS',
  null,
  'SSF',
  null,
  'EW',
  'EL'
];
const EXPORT_GFAC = [0, 0, 0, 2, 0, 1, 2, 1, 2, 1, 2, 1, 2, 2, 1, 2, 1, 2, 2, 2];
const EXPORT_DECIMALS = [null, null, null, 3, null, null, 2, null, 2, null, 2, null, 2, 2, null, 2, null, 2, 2, 2];

const EXPORT_CI = EXPORT_TITLES.map((title, index) => {
  const column = { gfac: EXPORT_GFAC[index] };
  if (title !== null) column.title = title;
  if (EXPORT_DECIMALS[index] !== null) column.decimals = EXPORT_DECIMALS[index];
  return column;
});

// Display values, i.e. what the page renders and what the adapter must recover.
const EXPORT_DISPLAY_ROWS = [
  [
    ['Indiana', '', '/cf2026/3484'],
    ['Big 10', '', '/cf2026/10678'],
    '2-0',
    1,
    ['+1', 'ltgreen', '', 1],
    1,
    9.1,
    3,
    83.65,
    3,
    69.32,
    2,
    42.2,
    2.14,
    71,
    50.14,
    40,
    63.59,
    8.59,
    1.41
  ],
  [
    ['Ohio St', '', '/cf2026/1067'],
    ['Big 10', '', '/cf2026/10678'],
    '1-1',
    0.5,
    ['-5', 'ltgreen', '', -5],
    6,
    8.94,
    1,
    85.17,
    6,
    68.02,
    1,
    45.01,
    2.29,
    5,
    68.11,
    16,
    67.14,
    8.6,
    1.4
  ]
];

/**
 * The inverse of the page's per-cell obfuscation: walk the columns exactly as
 * the decoder does and re-apply the keystream, so the fixture is genuinely
 * obfuscated rather than a decoded payload the decoder happens to pass through.
 */
function obfuscateRows(rows, columns, obfu) {
  let key = parseInt(String(obfu).slice(32), 10);
  const encoded = rows.map((row) => row.slice());
  for (let c = 0; c < columns.length; c++) {
    const type = columns[c].gfac;
    if (!type) continue;
    for (let r = 0; r < encoded.length; r++) {
      key = (0x1fb9 * key + 0x4d2) % 0x400;
      const wrapped = Array.isArray(encoded[r][c]);
      const value = wrapped ? encoded[r][c][0] : encoded[r][c];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const next = type === 1 ? value + key : type === 2 ? value * (key + 1) : value;
      if (wrapped) encoded[r][c][0] = next;
      else encoded[r][c] = next;
    }
  }
  return encoded;
}

const EXPORT_PAYLOAD = {
  CI: EXPORT_CI,
  DI: obfuscateRows(EXPORT_DISPLAY_ROWS, EXPORT_CI, OBFU),
  subname: ' : FBS',
  seas: 'cf2026',
  rating: { maxdate: 'Sun, Sep 13, 2026' }
};

// The inverse of the page's URL `decstr`, used to build the fixture page token.
function encodeExportUrl(text, key = 0x7e5) {
  const bytes = [];
  let state = key;
  for (const char of Buffer.from(String(text), 'binary')) {
    state = (0x1fb9 * state + 0x4d2) % 0x100;
    bytes.push((char + state) % 0x100);
  }
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
}

const EXPORT_RELATIVE_URL = '/json/rate.php?argv=fixture-token&task=json';
const EXPORT_JSON_URL_TOKEN = encodeExportUrl(EXPORT_RELATIVE_URL);

// A real, dated transfer vector: the page token observed live on 2026-09-15 and
// the export URL it decodes to. This is a per-load routing token, not ratings
// data, and it is here to pin the cipher constants to the vendor's, which a
// self-round-trip cannot do.
const LIVE_JSON_TOKEN =
  'flOmHEVgrdbT3nGtTzGKZuFwyQpqvdMB2Quwx3xLzlzVeOkeY6HQL9Xqu_aWd-qnE3b_PpsL5QIIHPQHum33lka5IZW5HTBHKnMONpepHsdZtjqjqgocYziHGUzKsSHSXBhUweYyS35pnGtf79WAEZAAXv3_VH2dp7CGUTroohN1XZQgQm6l6M7n';
const LIVE_EXPORT_RELATIVE_URL =
  '/json/rate.php?argv=slxlZrMjujc7FOv1L0Uz618yov_bd-l1dzJ-ICQjsLL1wPnhbluRKzKy0hSBj-gV39AN9n6oCP6-MoaTOAPIJchbHTuLa7KpHCbHhWc4sGw.&task=json';

const PAGE_HTML = `<html><head><script>stamp.obfu = "${OBFU}";stamp.jsonURL = "${EXPORT_JSON_URL_TOKEN}";stamp.cacheHash = "15e5f58c9db98428a37e43b2c2b72463";</script></head></html>`;

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
    assert.ok(massey.supportedLeagues().includes('NCAAB'));
  });

  it('has a verified ratings page for every supported league', () => {
    for (const league of massey.supportedLeagues()) {
      assert.match(massey.pageUrlFor(league), /^https:\/\/masseyratings\.com\/.+\/ratings$/);
    }
  });

  it('covers NCAAB through the verified NCAA D1 ratings page', () => {
    assert.ok(massey.supportedLeagues().includes('NCAAB'));
    assert.equal(massey.unsupportedReason('NCAAB'), null);
    // The NCAA D1 table, not the `/cb/ratings` section landing: the CFB
    // precedent uses the division sub-path (`/cf/fbs/ratings`).
    assert.equal(massey.pageUrlFor('NCAAB'), 'https://masseyratings.com/cb/ncaa-d1/ratings');

    const result = normalize({ league: 'NCAAB', raw: NCAAB_CSV_FIXTURE });
    assert.equal(result.source, 'massey');
    assert.equal(result.league, 'NCAAB');
    assert.equal(result.coverage, 'full');
    assert.ok(result.records.length > 0);
    assert.equal(result.sourceUrl, massey.pageUrlFor('NCAAB'));
  });

  it('does not change any other league when NCAAB is added', () => {
    // Every previously-covered league still resolves its page and reports no
    // reason, and each still carries its original route.
    const expectedPages = {
      NCAAF: 'https://masseyratings.com/cf/fbs/ratings',
      NFL: 'https://masseyratings.com/nfl/ratings',
      NBA: 'https://masseyratings.com/nba/ratings',
      NHL: 'https://masseyratings.com/nhl/ratings',
      MLB: 'https://masseyratings.com/mlb/mlb/ratings',
      MLS: 'https://masseyratings.com/dls/mls/ratings',
      WNBA: 'https://masseyratings.com/wnba/ratings'
    };
    for (const [league, page] of Object.entries(expectedPages)) {
      assert.equal(massey.unsupportedReason(league), null);
      assert.equal(massey.pageUrlFor(league), page);
    }
  });

  it('names the source for a sport it publishes no ratings for', () => {
    // UFC is a canonical SSB league (lib/league-presets.js) with no Massey
    // ratings page. The reason must say so and name the source, never claim the
    // code is not a league.
    for (const league of ['UFC']) {
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

  it('does not claim massey lacks a sport it actually publishes', () => {
    // Verified live (2026-09-15): massey publishes tour-level ATP/WTA ratings
    // (`/atp/ratings`, `/wta/ratings`) and named domestic soccer leagues (MLS is
    // its own entry). A reason saying the sport is "not published" would be
    // false, so it must state the real scope gap instead.
    for (const league of ['TENNIS', 'SOCCER']) {
      const reason = massey.unsupportedReason(league);
      assert.ok(reason, `${league} must carry a reason`);
      assert.match(reason, /massey/i);
      assert.ok(reason.includes(league), `${league} reason must name the league`);
      assert.doesNotMatch(reason, /not published/i);
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
    const mapped = new Set(massey.supportedLeagues());
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
    assert.notEqual(typo, massey.unsupportedReason('SOCCER'));
    assert.equal(massey.unsupportedReason('NCAAB'), null);
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
    assert.ok(massey.pageUrlFor('NCAAB'));
    assert.equal(massey.pageUrlFor('UFC'), null);
    assert.equal(massey.pageUrlFor('SOCCER'), null);
  });
});

describe('massey export transport: obfuscation decode', () => {
  it("decodes the page's export URL token with the vendor cipher", () => {
    // The live vector pins the constants; a self-round-trip cannot.
    assert.equal(masseyWeb.decodeExportUrl(LIVE_JSON_TOKEN), LIVE_EXPORT_RELATIVE_URL);
    assert.equal(masseyWeb.decodeExportUrl(EXPORT_JSON_URL_TOKEN), EXPORT_RELATIVE_URL);
  });

  it('derives the payload seed the page itself uses, and fails closed without one', () => {
    assert.equal(masseyWeb.decodeSeed(OBFU), 941);
    assert.throws(() => masseyWeb.decodeSeed('no-trailing-digits'), /obfuscation changed/);
  });

  it('reads the page tokens and resolves a same-host absolute export URL', () => {
    const tokens = masseyWeb.readPageTokens(PAGE_HTML);
    assert.equal(tokens.obfu, OBFU);
    assert.equal(tokens.jsonURL, EXPORT_JSON_URL_TOKEN);
    assert.equal(
      masseyWeb.resolveExportUrl(EXPORT_JSON_URL_TOKEN, massey.pageUrlFor('NCAAF')),
      `https://masseyratings.com${EXPORT_RELATIVE_URL}`
    );
    // A page with no inline config has no tokens, so the caller can say so.
    assert.deepEqual(masseyWeb.readPageTokens('<html></html>'), { obfu: null, jsonURL: null });
  });

  it('de-obfuscates the payload rows back to the displayed values', () => {
    const rows = masseyWeb.decodeMasseyRows(EXPORT_PAYLOAD, OBFU);
    assert.equal(rows.length, 2);

    assert.equal(rows[0][0][0], 'Indiana');
    assert.equal(rows[0][2], '2-0');
    // gfac 1 columns are ranks, gfac 2 columns are the values.
    assert.equal(rows[0][5], 1);
    assert.equal(rows[0][6], 9.1);
    assert.equal(rows[0][13], 2.14);
    assert.equal(rows[1][5], 6);
    assert.equal(rows[1][6], 8.94);
    assert.equal(rows[1][13], 2.29);

    // Non-numeric cells are left alone; a payload with no table is null.
    assert.equal(rows[0][4][0], '+1');
    assert.equal(masseyWeb.decodeMasseyRows({ CI: [], DI: [] }, OBFU), null);
  });
});

describe('massey export transport: payload to adapter CSV', () => {
  it('folds each rank/value pair into one cell and the adapter reads it back', () => {
    const { raw, rowCount } = masseyWeb.masseyExportCsv(EXPORT_PAYLOAD, { obfu: OBFU, league: 'NCAAF' });
    const lines = raw.trim().split('\n');

    assert.equal(rowCount, 2);
    assert.match(lines[0], /Using games thru Sun, Sep 13, 2026/);
    assert.equal(lines[1], 'Team,Rec,&Delta;,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL');
    // Massey's untitled conference cell is dropped, the win pct folds into Rec,
    // and each ranked stat folds into a single `rank value` cell the adapter's
    // numeric reader resolves to the value.
    assert.equal(lines[2], 'Indiana,2-0 1.000,+1,1 9.10,3 83.65,3 69.32,2 42.20,2.14,71 50.14,40 63.59,8.59,1.41');
    assert.equal(lines[3], 'Ohio St,1-1 0.500,-5,6 8.94,1 85.17,6 68.02,1 45.01,2.29,5 68.11,16 67.14,8.60,1.40');

    const result = massey.normalizeMassey({ raw, league: 'NCAAF', fetchedAt: FETCHED_AT });
    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 2);
    assert.equal(result.asOf, '2026-09-13');
    assert.equal(result.season, 2026);

    const indiana = result.records.find((record) => record.teamA === 'Indiana');
    assert.equal(indiana.ratingA, 9.1);
    assert.equal(indiana.homeAdvantage, 2.14);

    const ohio = result.records.find((record) => record.teamA === 'Ohio State');
    assert.equal(ohio.ratingA, 8.94);
    assert.equal(ohio.homeAdvantage, 2.29);
  });

  it('fails closed on a payload it cannot decode', () => {
    assert.throws(() => masseyWeb.masseyExportCsv({}, { obfu: OBFU }), /no CI\/DI ratings table/);
    assert.throws(
      () => masseyWeb.masseyExportCsv({ CI: [{ title: 'Team', gfac: 0 }], DI: null }, { obfu: OBFU }),
      /no CI\/DI ratings table/
    );
  });
});

describe('massey source adapter: fetch', () => {
  /** Injected transport: the ratings page, then the export endpoint. */
  function makeExportFetch(calls, override = {}) {
    return async (url) => {
      const target = String(url);
      calls.push(target);
      if (override[target]) return override[target];
      if (/^https:\/\/masseyratings\.com\/.+\/ratings$/.test(target)) {
        return { ok: true, status: 200, text: async () => PAGE_HTML };
      }
      if (target === `https://masseyratings.com${EXPORT_RELATIVE_URL}`) {
        return { ok: true, status: 200, text: async () => JSON.stringify(EXPORT_PAYLOAD) };
      }
      return { ok: false, status: 404, text: async () => '' };
    };
  }

  it('runs the page -> token -> export chain and returns parseable CSV', async () => {
    const calls = [];
    const result = await massey.fetchMassey({ league: 'NCAAF', fetchImpl: makeExportFetch(calls), now: FETCHED_AT });

    assert.equal(calls.length, 2, 'the page issues the token, then the export is fetched with it');
    assert.equal(calls[0], massey.pageUrlFor('NCAAF'));
    assert.equal(calls[1], `https://masseyratings.com${EXPORT_RELATIVE_URL}`);
    assert.equal(result.sourceUrl, massey.pageUrlFor('NCAAF'));
    assert.equal(result.exportUrl, `https://masseyratings.com${EXPORT_RELATIVE_URL}`);
    assert.equal(result.fetchedAt, FETCHED_AT);

    const normalized = massey.normalizeMassey({ raw: result.raw, league: 'NCAAF', fetchedAt: result.fetchedAt });
    assert.equal(normalized.coverage, 'full');
    assert.equal(normalized.asOf, '2026-09-13');
    assert.equal(normalized.records.find((record) => record.teamA === 'Indiana').ratingA, 9.1);
  });

  it('passes an operator-supplied export URL that returns CSV straight through', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => CSV_FIXTURE };
    };

    const result = await massey.fetchMassey({
      league: 'NFL',
      fetchImpl,
      exportUrl: 'https://masseyratings.com/nfl/ratings?export=1',
      now: FETCHED_AT
    });

    assert.deepEqual(calls, ['https://masseyratings.com/nfl/ratings?export=1']);
    assert.equal(result.raw, CSV_FIXTURE);
    assert.equal(result.exportUrl, 'https://masseyratings.com/nfl/ratings?export=1');
    // Provenance still points at the human-facing page.
    assert.equal(result.sourceUrl, massey.pageUrlFor('NFL'));
  });

  it('decodes an operator-supplied export URL that returns the export JSON', async () => {
    const calls = [];
    const exportUrl = 'https://masseyratings.com/json/rate.php?argv=fixture-token&task=json';
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url) === exportUrl) return { ok: true, status: 200, text: async () => JSON.stringify(EXPORT_PAYLOAD) };
      return { ok: true, status: 200, text: async () => PAGE_HTML };
    };

    const result = await massey.fetchMassey({ league: 'NCAAF', fetchImpl, exportUrl, now: FETCHED_AT });

    // The token alone decodes nothing, so the page is still read for its seed.
    assert.deepEqual(calls, [exportUrl, massey.pageUrlFor('NCAAF')]);
    const normalized = massey.normalizeMassey({ raw: result.raw, league: 'NCAAF', fetchedAt: result.fetchedAt });
    assert.equal(normalized.records.length, 2);
    assert.equal(normalized.asOf, '2026-09-13');
  });

  it('fails closed when the page carries no export token', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>no inline config</html>' });
    await assert.rejects(
      () => massey.fetchMassey({ league: 'NCAAF', fetchImpl }),
      /ratings page carried no export token/
    );
  });

  it('reports an HTTP failure as an HTTP failure', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '<title>Just a moment...</title>' });
    await assert.rejects(() => massey.fetchMassey({ league: 'NCAAF', fetchImpl }), /massey: HTTP 403 from/);
  });

  it('fetches the NCAAB ratings page it now covers', async () => {
    const calls = [];
    const fetchImpl = makeExportFetch(calls);
    const result = await massey.fetchMassey({ league: 'NCAAB', fetchImpl, now: FETCHED_AT });

    assert.equal(calls[0], 'https://masseyratings.com/cb/ncaa-d1/ratings');
    assert.equal(result.sourceUrl, massey.pageUrlFor('NCAAB'));
  });

  it('requires an injected fetch and rejects an unsupported league', async () => {
    await assert.rejects(() => massey.fetchMassey({ league: 'NCAAF' }), /fetchImpl/);

    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
    await assert.rejects(() => massey.fetchMassey({ league: 'UFC', fetchImpl }), /UFC/);
  });
});
