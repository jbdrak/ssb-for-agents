'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportedLeagues } = require('../lib/ssb-ratings-contract');
const { canonicalTeam } = require('../lib/ssb-ratings-team-aliases');
const sagarin = require('../lib/ratings-sources/sagarin');
const { normalizeSagarinRows, scoreSagarinRows, segmentSagarinRows } = require('../lib/sagarin-external-evaluation');
const { segmentRatingRows } = require('../lib/ssb-external-ratings-evaluation');

// ---------------------------------------------------------------------------
// Real captured pages (NOT handwritten rows)
// ---------------------------------------------------------------------------
//
// `test/fixtures/ratings/sagarin-<league>-2026-09-16.html` is the byte-faithful
// body of each live `sagarin.com/sports/<page>.htm` capture from 2026-09-16 (see
// `test/fixtures/ratings/README.md` for the URL, sha256 and the page's own
// heading date per league). The previous version of this file drove the parser
// from SYNTHETIC row arrays shaped the way the parser expected them, which is
// exactly the trap that lets a vendor parser go dead while its suite stays
// green: a fixture proves the parser against today's real bytes, and nothing
// else does.
//
// Two facts about a real page the old fixtures hid, both pinned below:
//
//   1. A page carries far more numbered rows than it has programs. The
//      whole-season ratings table (`1 Oklahoma City Thunder = 100.98 ...`, with
//      a football-only division letter between team and `=`) plus per-division
//      repeats plus an EIGENVECTOR table are all numbered too, so NBA's page
//      shows 84 numbered rows for a 30-team league. `pageCandidateRows` records
//      that as a diagnostic; it is NOT a record-count target.
//   2. Two sections are normalized and they are independent. The
//      game-prediction block holds NBA's finals matchup (2 rows) and has no rows
//      at all on NCAAB/MLS (frozen final-ratings pages); the per-team ratings
//      table holds 30-363 teams on every page. So every league now produces
//      records, and NCAAB/MLS produce them from the ratings table alone.
const CAPTURE_DATE = '2026-09-16';
const FETCHED_AT = '2026-09-16T12:00:00.000Z';

function fixturePath(league) {
  return path.join(__dirname, 'fixtures', 'ratings', `sagarin-${league.toLowerCase()}-${CAPTURE_DATE}.html`);
}

function loadPage(league) {
  return fs.readFileSync(fixturePath(league), 'utf8');
}

// Verified 2026-09-16 against the captures, by running the adapter (not by
// reading these numbers back out of it). A future column change moves the
// counts and fails this table loudly instead of silently returning a partially
// parsed page as a success.
//
//   `records`        the merged population: prediction-block + team-table rows
//   `blockRecords`   game-scoped records (the prediction block)
//   `teamRecords`    team-scoped records (the ratings table, de-duplicated)
//   `candidates`     the coverage denominator: block + team candidate rows
//   `unresolved`     team records with no canonical key in the registry
//
// `unresolved` is a pinned observation, not a target: a program the registry
// does not know must stay `unresolved` rather than be guessed into a key, and
// only the three spellings with no ESPN identity to key them to still are
// (NCAAF `UTRGV`, NCAAB `Hartford` and `St. Francis-NY`). These numbers move
// when aliases are seeded.
const PAGE_EXPECTATIONS = Object.freeze({
  NCAAF: {
    coverage: 'full',
    records: 385,
    blockRecords: 119,
    teamRecords: 266,
    candidates: 385,
    blockCandidates: 119,
    teamCandidates: 266,
    unresolved: 1,
    pageRows: 972,
    asOf: '2026-09-12',
    season: 2026
  },
  NFL: {
    coverage: 'full',
    records: 48,
    blockRecords: 16,
    teamRecords: 32,
    candidates: 48,
    blockCandidates: 16,
    teamCandidates: 32,
    unresolved: 0,
    pageRows: 136,
    asOf: '2026-09-14',
    season: 2026
  },
  NBA: {
    coverage: 'full',
    records: 32,
    blockRecords: 2,
    teamRecords: 30,
    candidates: 32,
    blockCandidates: 2,
    teamCandidates: 30,
    unresolved: 0,
    pageRows: 84,
    asOf: '2026-06-13',
    season: 2026
  },
  NHL: {
    coverage: 'full',
    records: 33,
    blockRecords: 1,
    teamRecords: 32,
    candidates: 33,
    blockCandidates: 1,
    teamCandidates: 32,
    unresolved: 0,
    pageRows: 79,
    asOf: '2026-06-14',
    season: 2026
  },
  NCAAB: {
    coverage: 'full',
    records: 363,
    blockRecords: 0,
    teamRecords: 363,
    candidates: 363,
    blockCandidates: 0,
    teamCandidates: 363,
    unresolved: 2,
    pageRows: 66,
    asOf: '2023-04-03',
    season: 2023
  },
  MLS: {
    coverage: 'full',
    records: 29,
    blockRecords: 0,
    teamRecords: 29,
    candidates: 29,
    blockCandidates: 0,
    teamCandidates: 29,
    unresolved: 0,
    pageRows: 64,
    asOf: '2024-12-07',
    season: 2024
  }
});

const CAPTURED_LEAGUES = Object.freeze(Object.keys(PAGE_EXPECTATIONS));

function normalizePage(league, overrides = {}) {
  return sagarin.normalizeSagarin({
    raw: loadPage(league),
    league,
    fetchedAt: FETCHED_AT,
    ...overrides
  });
}

/** The prediction-block population: a team-scoped row mirrors its own name. */
function gameRecords(result) {
  return result.records.filter((record) => record.teamA !== record.teamB);
}

/** The ratings-table population (one row per program, no opponent). */
function teamRecords(result) {
  return result.records.filter((record) => record.teamA === record.teamB);
}

describe('sagarin source adapter: real captured pages, per league', () => {
  for (const league of CAPTURED_LEAGUES) {
    const expected = PAGE_EXPECTATIONS[league];

    it(`reads ${league}'s real page and reports coverage honestly`, () => {
      const result = normalizePage(league);

      assert.equal(result.league, league);
      assert.equal(result.method, 'overall');
      assert.equal(result.block, 'regular');
      // Every captured league now yields records, including NCAAB/MLS whose
      // prediction blocks are empty.
      assert.equal(result.coverage, 'full');
      assert.equal(result.coverage, expected.coverage);
      assert.equal(result.records.length, expected.records);
      assert.equal(gameRecords(result).length, expected.blockRecords);
      assert.equal(teamRecords(result).length, expected.teamRecords);
      assert.equal(result.blockCandidateRows, expected.blockCandidates);
      assert.equal(result.teamCandidateRows, expected.teamCandidates);
      assert.equal(result.candidateRows, expected.candidates);
      assert.equal(result.pageCandidateRows, expected.pageRows);
      assert.equal(result.asOf, expected.asOf);
      assert.equal(result.season, expected.season);
      // The heading date is the page's own; ours is the fetch time.
      assert.notEqual(result.asOf, result.fetchedAt);
      assert.equal(result.fetchedAt, FETCHED_AT);
      assert.ok(result.records.every((record) => record.asOf === expected.asOf));
      assert.ok(result.records.every((record) => record.fetchedAt === FETCHED_AT));
      assert.match(result.sourceHash, /^[0-9a-f]{64}$/);
      assert.ok(result.records.every((record) => record.sourceHash === result.sourceHash));
      assert.equal(typeof result.coverageReason, 'string');
      assert.equal(
        teamRecords(result).filter((record) => record.matchStatus === 'unresolved').length,
        expected.unresolved
      );
      // Nothing was silently dropped: every candidate row in BOTH sections
      // became a record, and every record passes the shared contract validator.
      assert.equal(result.skipped.length, 0);
      assert.equal(result.records.length, expected.candidates);
      assert.equal(result.unresolvedReason, null);
      for (const record of result.records) {
        const validation = require('../lib/ssb-ratings-contract').validateRatingRecord(record);
        assert.deepEqual(validation.errors, []);
        assert.equal(validation.ok, true);
      }
    });
  }

  it('parses no more records than the two sections have candidate rows, for every league', () => {
    for (const league of CAPTURED_LEAGUES) {
      const result = normalizePage(league);
      // The parsed candidates are exactly the two populations.
      assert.equal(result.candidateRows, result.blockCandidateRows + result.teamCandidateRows);
      assert.ok(result.candidateRows >= result.blockCandidateRows);
      // `pageCandidateRows` counts numbered LINES, and on a tag-wrapped page a
      // team row does not start with its index, so the diagnostic can sit below
      // the table's row count (NCAAB: 66 counted lines for 363 tagged rows).
      // That is why it is a diagnostic and never a parse target.
      assert.ok(
        result.pageCandidateRows >= result.blockCandidateRows,
        `${league}: page rows ${result.pageCandidateRows} < block rows ${result.blockCandidateRows}`
      );
      if (league === 'NCAAB') {
        assert.ok(result.pageCandidateRows < result.teamCandidateRows, 'tag-led rows are not numbered lines');
      } else {
        assert.ok(result.pageCandidateRows >= result.teamCandidateRows);
      }
    }
  });
});

describe('sagarin source adapter: real page row semantics', () => {
  // The page now yields BOTH populations, so a lookup by name must say which
  // one it means: a team-scoped ratings row mirrors its own name into `teamB`,
  // a game-scoped prediction row does not.
  const rows = gameRecords(normalizePage('NCAAF'));
  const byTeam = (name) => rows.find((record) => record.teamA === name);

  it('maps a home favorite from the real CFB page', () => {
    const pittsburgh = byTeam('Pittsburgh');
    assert.equal(pittsburgh.teamB, 'Syracuse');
    assert.equal(pittsburgh.neutral, false);
    assert.equal(pittsburgh.predictedMargin, 10.26);
    // The `@` team's score is the `home` column.
    assert.equal(pittsburgh.predictedScoreA, 27.46);
    assert.equal(pittsburgh.predictedScoreB, 17.2);
    assert.equal(pittsburgh.predictedTotal, 44.66);
  });

  it('maps a neutral-site favorite from the real CFB page', () => {
    const arizonaState = byTeam('Arizona State');
    assert.equal(arizonaState.teamB, 'Kansas');
    assert.equal(arizonaState.neutral, true);
    assert.equal(arizonaState.predictedMargin, 6.02);
    assert.equal(arizonaState.predictedScoreA, 34.91);
    assert.equal(arizonaState.predictedScoreB, 28.89);
  });

  it('maps an away favorite at a true home venue from the real CFB page', () => {
    const miami = byTeam('Miami-Florida');
    assert.equal(miami.teamB, 'Wake Forest');
    assert.equal(miami.neutral, false);
    assert.equal(miami.predictedMargin, 14.89);
    // The favorite is the AWAY side here, so its projected score is the `away`
    // column while the home underdog takes the `home` column.
    assert.equal(miami.predictedScoreA, 24.82);
    assert.equal(miami.predictedScoreB, 9.93);
    assert.equal(miami.predictedTotal, 34.75);
  });

  it('maps the real `N @` double marker (neutral venue, closer team favored)', () => {
    const virginia = byTeam('Virginia');
    assert.equal(virginia.teamB, 'West Virginia');
    assert.equal(virginia.neutral, true);
    assert.equal(virginia.predictedScoreA, 26.02);
    assert.equal(virginia.predictedScoreB, 14.91);
    assert.equal(virginia.predictedTotal, 40.94);
  });

  it('preserves the regular-vs-experimental method split on the real page', () => {
    const overall = normalizePage('NCAAF', { method: 'overall' });
    const predictor = normalizePage('NCAAF', { method: 'predictor' });
    const golden = normalizePage('NCAAF', { method: 'golden_mean' });
    const recent = normalizePage('NCAAF', { method: 'recent' });
    const experimental = normalizePage('NCAAF', { method: 'experimental_overall' });

    const marginOf = (result) => gameRecords(result).find((record) => record.teamA === 'Pittsburgh').predictedMargin;
    assert.equal(marginOf(overall), 10.26);
    assert.equal(marginOf(predictor), 9.3);
    assert.equal(marginOf(golden), 11.61);
    assert.equal(marginOf(recent), 10.39);
    // The experimental home-away block is a different method and a different
    // number for the same fixture; the two blocks are never merged.
    assert.equal(marginOf(experimental), 13.93);
    assert.equal(experimental.block, 'experimental');
    assert.ok(experimental.records.every((record) => record.method === 'experimental_overall'));
    assert.ok(overall.records.every((record) => record.method === 'overall'));
    // The experimental methods have no ratings-table column, so they emit no
    // team rows and contribute no team candidates.
    assert.deepEqual(teamRecords(experimental), []);
    assert.equal(experimental.teamCandidateRows, 0);
    assert.equal(experimental.blockCandidateRows, PAGE_EXPECTATIONS.NCAAF.blockCandidates);
  });

  it('reads every method of every real page without skipping a row', () => {
    for (const league of CAPTURED_LEAGUES) {
      for (const method of sagarin.SAGARIN_METHODS) {
        const result = normalizePage(league, { method });
        const expected = PAGE_EXPECTATIONS[league];
        // Ratings-table methods normalize both sections; the experimental
        // methods are prediction-block-only and so carry the block's rows.
        const experimental = method.startsWith('experimental_');
        const expectedRecords = experimental ? expected.blockRecords : expected.records;
        assert.equal(result.skipped.length, 0, `${league} ${method} skipped rows`);
        if (expectedRecords === 0) {
          // NCAAB/MLS have no experimental block at all, and the experimental
          // methods have no team rows: an empty section is not a quiet success.
          assert.equal(result.coverage, 'unavailable', `${league} ${method} coverage`);
          assert.deepEqual(result.records, []);
          continue;
        }
        assert.equal(result.coverage, 'full', `${league} ${method} coverage`);
        assert.equal(result.records.length, expectedRecords, `${league} ${method} record count`);
        assert.equal(result.candidateRows, expectedRecords, `${league} ${method} candidate rows`);
      }
    }
  });
});

describe('sagarin source adapter: the published WIN% column', () => {
  // Read the captured bytes with THIS file's own regex rather than the adapter's,
  // so the two readers must agree about column order: a `WIN%` / `MONEY` swap in
  // the page would move one without the other and fail here.
  const ROW_LINE =
    /^\s*(\d{1,3})\s+(.+?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(.+?)\s+(-?\d+)\s+(-?\d+)%/;

  function measuredRows(league) {
    const rows = [];
    for (const line of loadPage(league).split(/\r?\n/)) {
      const match = ROW_LINE.exec(line);
      if (!match) continue;
      // The venue marker must be followed by whitespace (the adapter's own rule),
      // so a team called "Northern Illinois" keeps its N; it can repeat (`N @`),
      // so it is stripped in a loop exactly as the adapter does.
      const name = (value) => {
        let rest = String(value || '').trim();
        for (let guard = 0; guard < 4; guard += 1) {
          const marker = /^([N@]{1,2})(?:\s+|$)(.*)$/.exec(rest);
          if (!marker) break;
          rest = marker[2].trim();
        }
        return rest;
      };
      rows.push({
        favorite: name(match[2]),
        underdog: name(match[8]),
        money: Number(match[9]),
        winPercent: Number(match[10])
      });
    }
    return rows;
  }

  it('carries the page’s own WIN% for every real prediction row', () => {
    let compared = 0;
    for (const league of CAPTURED_LEAGUES) {
      const records = gameRecords(normalizePage(league));
      const measured = measuredRows(league);
      // Both blocks (regular + experimental) print the same column, so only the
      // regular block's rows are zipped against the adapter's game records.
      const regular = measured.slice(0, records.length);
      assert.equal(records.length, regular.length, `${league}: record count`);

      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        assert.equal(record.teamA, regular[i].favorite, `${league} row ${i + 1} favorite`);
        assert.equal(record.teamB, regular[i].underdog, `${league} row ${i + 1} underdog`);
        assert.equal(record.modelWinProbabilityKind, 'published');
        assert.equal(record.modelWinProbability, regular[i].winPercent / 100, `${league} row ${i + 1} WIN%`);
        compared += 1;
      }
    }
    // The gate is not vacuous: it compared every regular-block record the adapter
    // emits across all six captures (119 NCAAF + 16 NFL + 2 NBA + 1 NHL). Team
    // rows carry no win probability and are excluded by the game-scoped filter.
    assert.equal(compared, 138);
  });

  it('cross-checks the WIN% against the adjacent MONEY column', () => {
    // `MONEY` is the underdog's price "to 100", so it and `WIN%` are two printed
    // forms of one probability: round(100 * M / (100 + M)) must reproduce the
    // whole percent. This is the evidence that the leading pair - and not the
    // trailing home-margin pair - is the favorite's win probability.
    let checked = 0;
    let offByOne = 0;
    for (const league of CAPTURED_LEAGUES) {
      for (const row of measuredRows(league)) {
        const implied = Math.round((100 * row.money) / (100 + row.money));
        checked += 1;
        if (implied !== row.winPercent) offByOne += 1;
      }
    }
    assert.equal(checked, 276);
    // Sagarin rounds the percent independently of the rounded price, so two rows
    // on the NFL page sit one point apart. Anything wider means the columns moved.
    assert.equal(offByOne, 2);
  });

  it('reads the favorite’s probability, not the home team’s', () => {
    const rows = gameRecords(normalizePage('NCAAF'));
    const byTeam = (name) => rows.find((record) => record.teamA === name);

    // `Miami-Florida` is the printed favorite while `@ Wake Forest` is home, and
    // the page reads 82%: the column follows the favorite.
    const awayFavorite = byTeam('Miami-Florida');
    assert.equal(awayFavorite.modelWinProbability, 0.82);
    assert.ok(awayFavorite.modelWinProbability > 0.5);

    // ...and on the home side it still follows the favorite, not the venue.
    assert.equal(byTeam('Pittsburgh').modelWinProbability, 0.75);
    // NBA's two regular-block rows are the same two teams with a different
    // printed favorite on each, and the page reads a different percent for each -
    // which is only possible if the column follows the favorite.
    const nba = gameRecords(normalizePage('NBA'));
    assert.equal(nba.find((record) => record.teamA === 'New York Knicks').modelWinProbability, 0.55);
    assert.equal(nba.find((record) => record.teamA === 'San Antonio Spurs').modelWinProbability, 0.56);
    assert.notEqual(
      nba.find((record) => record.teamA === 'New York Knicks').modelWinProbability,
      nba.find((record) => record.teamA === 'San Antonio Spurs').modelWinProbability
    );
  });

  it('never inflates the source’s whole-percent precision', () => {
    // The column is printed as whole percents, so every carried value is an exact
    // whole percent - a value with more digits would be a derived number wearing
    // a published label. (Compared with a tolerance: 0.57 * 100 is 56.999... in
    // binary floating point.) Team rows carry no probability at all, so they are
    // skipped rather than silently passing on a null.
    let checked = 0;
    for (const league of CAPTURED_LEAGUES) {
      for (const record of normalizePage(league).records) {
        if (record.modelWinProbability === null) continue;
        checked += 1;
        const scaled = record.modelWinProbability * 100;
        assert.ok(
          Math.abs(scaled - Math.round(scaled)) < 1e-9,
          `${league}: ${record.modelWinProbability} is not a whole percent`
        );
      }
    }
    assert.equal(checked, 138);
  });

  it('fails loudly rather than quietly carrying an out-of-range percent', () => {
    // Simulated drift: the column prints a value outside 0-100 (a scale or column
    // change). The contract rejects the record, so the row is skipped with its
    // errors and the page can no longer report `full`.
    const raw = loadPage('NCAAF');
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*1\s+@ Pittsburgh\s/.test(line));
    assert.ok(index > 0);
    lines[index] = lines[index].replace(' 75% ', ' 150% ');
    const result = sagarin.normalizeSagarin({ raw: lines.join('\n'), league: 'NCAAF', fetchedAt: FETCHED_AT });

    assert.equal(result.coverage, 'partial');
    // The team table is untouched, so only the block loses a row.
    assert.equal(result.records.length, PAGE_EXPECTATIONS.NCAAF.records - 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'invalid_record');
    assert.ok(result.skipped[0].errors.some((error) => /modelWinProbability/.test(error)));
  });

  it('loses the whole block if the page stops printing the column', () => {
    // The row pattern requires `WIN%`, so removing it makes rows unreadable
    // rather than silently probability-less: that is the real drift signal, and
    // it is why no second guard is needed on the record itself.
    const raw = loadPage('NCAAF');
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*2\s+@ Oregon\s/.test(line));
    assert.ok(index > 0);
    lines[index] = lines[index].replace(' 96% ', ' 96 ');
    const result = sagarin.normalizeSagarin({ raw: lines.join('\n'), league: 'NCAAF', fetchedAt: FETCHED_AT });

    assert.equal(result.coverage, 'partial');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'unparseable_row');
  });
});

describe('sagarin source adapter: coverage gate', () => {
  // Damage every candidate row of a real block except two: a layout change that
  // breaks the row regex must surface as `partial`, never as a quiet success.
  function corruptBlockRows(raw, keep = 2) {
    const lines = raw.split(/\r?\n/);
    let lastMarker = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Predictions_with_Totals')) {
        lastMarker = i;
        break;
      }
    }
    let experimentalAt = -1;
    for (let i = lines.length - 1; i > lastMarker; i--) {
      if (lines[i].includes('EXPERIMENTAL NUMBERS')) {
        experimentalAt = i;
        break;
      }
    }
    const end = experimentalAt === -1 ? lines.length : experimentalAt;
    let seen = 0;
    for (let i = lastMarker + 1; i < end; i++) {
      if (!/^\s*\d{1,3}\s/.test(lines[i])) continue;
      seen += 1;
      if (seen <= keep) continue;
      lines[i] = `${seen}   @ Broken Row           not-a-number`;
    }
    return lines.join('\n');
  }

  // The same idea for the ratings table: keep the leading index, the `=` and the
  // `W L` head intact and destroy only the PREDICTOR pipe group. The row still
  // matches the team discriminator and therefore stays a COVERAGE CANDIDATE, but
  // the requested column no longer yields a value.
  function corruptTeamColumns(raw, keep = 0) {
    const lines = raw.split(/\r?\n/);
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/<[^>]*>/g, '');
      if (!/^\s*\d{1,3}\s+(.+?)\s*=\s*-?\d+\.\d+\s+\d{1,3}\s+\d{1,3}/.test(stripped)) continue;
      if (stripped.includes('*')) continue;
      const groups = stripped.split('|');
      if (groups.length < 5) continue;
      seen += 1;
      if (seen <= keep) continue;
      groups[2] = '   not-a-number';
      lines[i] = groups.join('|');
    }
    return lines.join('\n');
  }

  it('demotes a block whose rows stopped matching the row layout', () => {
    const raw = loadPage('NCAAF');
    const result = sagarin.normalizeSagarin({ raw: corruptBlockRows(raw), league: 'NCAAF', fetchedAt: FETCHED_AT });

    assert.equal(result.coverage, 'partial');
    // The ratings table is untouched and still contributes its 266 team rows.
    assert.equal(result.records.length, 2 + PAGE_EXPECTATIONS.NCAAF.teamRecords);
    assert.equal(result.blockCandidateRows, PAGE_EXPECTATIONS.NCAAF.blockCandidates);
    assert.equal(result.teamCandidateRows, PAGE_EXPECTATIONS.NCAAF.teamCandidates);
    assert.equal(result.candidateRows, PAGE_EXPECTATIONS.NCAAF.candidates);
    assert.equal(result.skipped.length, 117);
    assert.equal(result.unresolvedReason, null);
    assert.equal(
      result.coverageReason,
      '268 of 385 candidate rows parsed (119 regular-block + 266 team-table candidate row(s)) (117 unreadable)'
    );
  });

  it('names both parsed sections in the reason, so a shortfall says where', () => {
    const result = sagarin.normalizeSagarin({
      raw: corruptBlockRows(loadPage('NCAAF')),
      league: 'NCAAF',
      fetchedAt: FETCHED_AT
    });
    assert.match(result.coverageReason, /regular-block/);
    assert.match(result.coverageReason, /team-table/);
  });

  it('demotes to unavailable when no candidate row in EITHER section survives', () => {
    // Corrupting the prediction block alone is no longer enough to empty the
    // page: the ratings table is a second population, and a page that still
    // yields 266 team rows is genuinely `partial`, not `unavailable`.
    const raw = loadPage('NCAAF');
    const blockOnly = sagarin.normalizeSagarin({
      raw: corruptBlockRows(raw, 0),
      league: 'NCAAF',
      method: 'predictor',
      fetchedAt: FETCHED_AT
    });
    assert.equal(blockOnly.coverage, 'partial');
    assert.equal(blockOnly.records.length, PAGE_EXPECTATIONS.NCAAF.teamRecords);

    const result = sagarin.normalizeSagarin({
      raw: corruptTeamColumns(corruptBlockRows(raw, 0)),
      league: 'NCAAF',
      method: 'predictor',
      fetchedAt: FETCHED_AT
    });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    // Both sections still offered candidates; every one of them was unreadable.
    assert.equal(result.blockCandidateRows, PAGE_EXPECTATIONS.NCAAF.blockCandidates);
    assert.equal(result.teamCandidateRows, PAGE_EXPECTATIONS.NCAAF.teamCandidates);
    assert.equal(result.skipped.length, PAGE_EXPECTATIONS.NCAAF.candidates);
    assert.match(result.unresolvedReason, /block/i);
    assert.match(result.unresolvedReason, /ratings table/i);
  });

  it('skips a single unreadable row inside the block and says so', () => {
    const raw = loadPage('NCAAF');
    const lines = raw.split(/\r?\n/);
    // Break exactly one real block row (rank 2 of the regular block).
    const index = lines.findIndex((line) => /^\s*2\s+@ Oregon\s/.test(line));
    assert.ok(index > 0, 'the real Oregon row must be present in the capture');
    lines[index] = '    2   @ Oregon               not-a-number';
    const result = sagarin.normalizeSagarin({ raw: lines.join('\n'), league: 'NCAAF', fetchedAt: FETCHED_AT });

    assert.equal(result.coverage, 'partial');
    assert.equal(result.records.length, PAGE_EXPECTATIONS.NCAAF.records - 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'unparseable_row');
    assert.match(result.skipped[0].text, /not-a-number/);
    assert.match(result.coverageReason, /384 of 385 candidate rows parsed .* \(1 unreadable\)/);
  });

  it('skips a team row whose columns moved out of the verified layout', () => {
    // A team-table layout drift: the row still matches the team discriminator, so
    // it stays a candidate, but its rating columns no longer parse. That must be
    // a skipped candidate and drop the page from `full` - the whole point of
    // counting the ratings table in the coverage denominator.
    const result = sagarin.normalizeSagarin({
      raw: corruptTeamColumns(loadPage('NCAAF'), 1),
      league: 'NCAAF',
      method: 'predictor',
      fetchedAt: FETCHED_AT
    });

    assert.equal(result.coverage, 'partial');
    // Exactly one team row was left intact, so the rest are skipped candidates.
    assert.equal(result.teamCandidateRows, PAGE_EXPECTATIONS.NCAAF.teamCandidates);
    assert.equal(result.records.length, PAGE_EXPECTATIONS.NCAAF.blockCandidates + 1);
    assert.equal(result.skipped.length, PAGE_EXPECTATIONS.NCAAF.teamCandidates - 1);
    assert.equal(result.skipped[0].reason, 'unreadable_team_row');
    assert.match(result.coverageReason, /\(265 unreadable\)/);
  });

  it('demotes a block whose rows still match but no longer yield a complete record', () => {
    // A value-shift drift: ROW_PATTERN still matches every row, but a row that
    // loses its home/away marker parses into an incomplete record (no projected
    // score). The envelope must not keep reporting `full`.
    const raw = loadPage('NCAAF');
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*4\s+Miami-Florida\s/.test(line));
    assert.ok(index > 0, 'the real Miami-Florida row must be present in the capture');
    assert.ok(lines[index].includes('@ Wake Forest'));
    lines[index] = lines[index].replace('@ Wake Forest', ' Wake Forest');
    const result = sagarin.normalizeSagarin({ raw: lines.join('\n'), league: 'NCAAF', fetchedAt: FETCHED_AT });

    assert.equal(result.coverage, 'partial');
    assert.equal(result.records.length, PAGE_EXPECTATIONS.NCAAF.records);
    assert.equal(result.skipped.length, 0);
    // Team-scoped rows carry `coverage: 'partial'` when they are unresolved, so
    // the incomplete-count assertion is scoped to the game population (that is
    // the population `coverage` on a record is about here).
    assert.equal(gameRecords(result).filter((record) => record.coverage !== 'full').length, 1);
    assert.match(result.coverageReason, /385 of 385 candidate rows parsed .* \(1 incomplete\)/);
    assert.equal(result.unresolvedReason, null);
  });

  it('reports unavailable, never empty success, when the prediction block is absent', () => {
    const result = sagarin.normalizeSagarin({
      raw: '<html>no predictions block here</html>',
      league: 'NCAAF',
      fetchedAt: FETCHED_AT
    });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /block/i);
  });
});

describe('sagarin source adapter: the per-team RATINGS table', () => {
  // This file's own copy of the team-row discriminator (not the adapter's), so
  // the counts below are independent evidence about the captured bytes.
  const PAGE_TEAM_ROW =
    /^\s*(\d{1,3})\s+(.+?)\s*=\s*(-?\d+\.\d+)\s+(\d{1,3})\s+(\d{1,3})(?:\s+(\d{1,3}))?\s+(\d+\.\d+)\(\s*(\d+)\)/;

  function printedTeamRows(league) {
    return loadPage(league)
      .split(/\r?\n/)
      .map((line) => PAGE_TEAM_ROW.exec(line.replace(/<[^>]*>/g, '')))
      .filter(Boolean);
  }

  it('de-duplicates the per-division repeats, keeping the ranked occurrence', () => {
    for (const league of CAPTURED_LEAGUES) {
      const expected = PAGE_EXPECTATIONS[league];
      const matches = printedTeamRows(league);
      const sentinel = matches.filter((match) => match[2].includes('*'));
      // Each program is printed TWICE on every capture (the ranked table, then
      // per-division/conference repeats), which is what makes the de-duplication
      // load-bearing rather than cosmetic.
      assert.equal(matches.length - sentinel.length, expected.teamCandidates * 2, `${league}: printed team rows`);
      const result = normalizePage(league);
      assert.equal(result.teamCandidateRows, expected.teamCandidates, `${league}: candidates`);
      assert.equal(teamRecords(result).length, expected.teamCandidates, `${league}: records`);
    }
  });

  it('skips the page’s non-team sentinel by its label, not by its row index', () => {
    // `267  ***UNRATED***        __ = -91.00 5 43 0.00( 0) ...` carries a REAL
    // numeric index, so the leading-index anchor does NOT exclude it. Verified
    // rather than assumed - this is the assertion the decision card asked for.
    const raw = loadPage('NCAAF');
    assert.match(raw, /^\s*\d{1,3}\s+\*\*\*UNRATED\*\*\*/m);
    const sentinel = printedTeamRows('NCAAF').filter((match) => match[2].includes('*'));
    assert.equal(sentinel.length, 2);
    assert.ok(sentinel.every((match) => Number.isInteger(Number(match[1]))));

    const result = normalizePage('NCAAF');
    assert.equal(
      result.records.some((record) => record.teamA.includes('*')),
      false
    );
    assert.equal(
      result.records.some((record) => /UNRATED/.test(record.teamA)),
      false
    );
    // And no other league's page carries the row at all.
    for (const league of CAPTURED_LEAGUES) {
      if (league === 'NCAAF') continue;
      assert.equal(printedTeamRows(league).filter((match) => match[2].includes('*')).length, 0, league);
    }
  });

  it('reads NCAAB team rows through the page’s inline <font> markup', () => {
    const lines = loadPage('NCAAB').split(/\r?\n/);
    // The same discriminator WITHOUT the per-line tag strip finds nothing: this
    // page wraps every team row in a `<font>` run, so the tag tolerance is what
    // stands between the league and zero team records. Removing the strip takes
    // this count to 0, which is exactly what makes it a real test.
    assert.equal(lines.filter((line) => PAGE_TEAM_ROW.test(line)).length, 0);
    assert.ok(lines.some((line) => PAGE_TEAM_ROW.test(line.replace(/<[^>]*>/g, ''))));

    const result = normalizePage('NCAAB');
    assert.equal(result.teamCandidateRows, PAGE_EXPECTATIONS.NCAAB.teamCandidates);
    assert.equal(teamRecords(result).length, 363);
    assert.equal(result.records.length, 363, 'NCAAB emitted zero records before this landed');
    // Tag stripping happens in the team-table scan only: the page-level
    // diagnostic is still measured on the raw lines.
    assert.equal(result.pageCandidateRows, PAGE_EXPECTATIONS.NCAAB.pageRows);
  });

  it('strips the college-football division letter without touching the name', () => {
    const teams = teamRecords(normalizePage('NCAAF'));
    // The page prints `Notre Dame           A`, where `A` is the I-A division
    // column. The registry knows the school, not the label with the letter.
    assert.ok(teams.some((record) => record.teamA === 'Notre Dame'));
    assert.ok(!teams.some((record) => /\s[A-Z]{1,2}$/.test(record.teamA)));
    assert.equal(canonicalTeam('Notre Dame           A', 'NCAAF'), null);
    assert.equal(canonicalTeam('Notre Dame', 'NCAAF'), 'Notre Dame');
    // No other league prints a division column, so nothing else is stripped.
    const nhl = teamRecords(normalizePage('NHL'));
    assert.ok(nhl.some((record) => record.teamA === 'Tampa Bay Lightning'));
  });

  it('reads each method from its own ratings-table column', () => {
    const value = (method, team) =>
      teamRecords(normalizePage('NBA', { method })).find((record) => record.teamA === team).ratingA;

    // The page's own header is `RATING W L SCHEDL(RANK) VS top N | VS top N |
    // PREDICTOR | GOLDEN_MEAN | RECENT | STRONG RECENT`, so the pipe groups line
    // up with the method names.
    assert.equal(value('overall', 'Oklahoma City Thunder'), 100.98);
    assert.equal(value('predictor', 'Oklahoma City Thunder'), 101.05);
    assert.equal(value('golden_mean', 'Oklahoma City Thunder'), 102.1);
    assert.equal(value('recent', 'Oklahoma City Thunder'), 100.05);
    // A second program, so the numbers are not one row read four ways.
    assert.equal(value('overall', 'San Antonio Spurs'), 100.9);
    assert.equal(value('predictor', 'San Antonio Spurs'), 100.75);
    // The columns really are different numbers.
    assert.notEqual(value('overall', 'Oklahoma City Thunder'), value('predictor', 'Oklahoma City Thunder'));
  });

  it('leaves an unregistered program unresolved rather than inventing a key', () => {
    // The live CFB page's only team row with no ESPN-published identity to key
    // it to. (This test used the NFL page's `Washington Redskins` row as its
    // example; that spelling is now registered against `Washington Commanders`,
    // which the assertion at the end of this test pins instead.)
    const football = teamRecords(normalizePage('NCAAF'));

    const unregistered = football.find((record) => record.teamA === 'UTRGV');
    assert.ok(unregistered, 'the page prints UTRGV');
    assert.equal(unregistered.matchStatus, 'unresolved');
    assert.match(unregistered.unresolvedReason, /no canonical match in NCAAF/);
    // Unresolved is a registry gap, not a parse failure: the printed rating is
    // still carried.
    assert.equal(typeof unregistered.ratingA, 'number');
    assert.equal(unregistered.ratingB, unregistered.ratingA);

    const notreDame = football.find((record) => record.teamA === 'Notre Dame');
    assert.equal(notreDame.matchStatus, 'unmatched');
    assert.equal(notreDame.unresolvedReason, null);
    assert.equal(notreDame.coverage, 'full');
    assert.equal(notreDame.ratingA, 95.24);

    // ...and a program the page still prints under its former name joins its
    // current ESPN key instead of staying unresolved.
    const commanders = teamRecords(normalizePage('NFL')).find((record) => record.teamA === 'Washington Commanders');
    assert.ok(commanders, 'the page prints Washington Redskins');
    assert.equal(commanders.matchStatus, 'unmatched');
    assert.equal(commanders.unresolvedReason, null);
    assert.equal(commanders.ratingA, 19.3);
  });

  it('gives team rows the Massey shape', () => {
    const teams = teamRecords(normalizePage('NBA'));
    assert.equal(teams.length, 30);
    assert.equal(new Set(teams.map((record) => record.teamA)).size, 30, 'one record per program');
    for (const record of teams) {
      // A ratings-table row has no opponent, so the team mirrors itself; a
      // consumer must read `teamB` as a structural placeholder.
      assert.equal(record.teamA, record.teamB);
      assert.equal(record.neutral, null);
      assert.equal(record.eventId, null);
      assert.equal(typeof record.ratingA, 'number');
      assert.equal(record.ratingB, record.ratingA);
      assert.equal(record.predictedScoreA, null);
      assert.equal(record.predictedScoreB, null);
      assert.equal(record.predictedTotal, null);
      assert.equal(record.predictedMargin, null);
      assert.equal(record.modelWinProbability, null);
      assert.equal(record.modelWinProbabilityKind, null);
      assert.equal(record.method, 'overall');
    }
  });

  it('carries the page’s single home edge on team rows, as the envelope does', () => {
    for (const league of CAPTURED_LEAGUES) {
      const result = normalizePage(league);
      for (const record of teamRecords(result)) {
        assert.equal(record.homeAdvantage, result.homeAdvantage, `${league} ${record.teamA}`);
      }
    }
    // A page that prints the edge as plain text carries it; the NCAAB page wraps
    // it in a <font> run, which the existing home-advantage reader does not
    // reach - that is pre-existing behaviour quoted here, not a team-row rule.
    assert.equal(normalizePage('NCAAF').homeAdvantage, 2.41);
    assert.equal(normalizePage('NBA').homeAdvantage, 1.82);
  });
});

describe('sagarin source adapter: leagues without team ratings', () => {
  // An unsupported league returns before the payload is read, so these use an
  // empty body on purpose - there is no page to capture for MLB.
  function normalizeUnsupported(league, overrides = {}) {
    return sagarin.normalizeSagarin({ raw: '', league, fetchedAt: FETCHED_AT, ...overrides });
  }

  it('fails closed for MLB with the player-ratings reason', () => {
    const result = normalizeUnsupported('MLB');
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /player ratings/i);

    const experimental = normalizeUnsupported('MLB', { method: 'experimental_overall' });
    assert.equal(experimental.coverage, 'unavailable');
    assert.match(experimental.unresolvedReason, /player ratings/i);
  });

  it('reports an unknown league as unavailable rather than empty success', () => {
    const result = normalizeUnsupported('WNBA');
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.ok(result.unresolvedReason.length > 0);
  });

  it('accepts the CFB/CBB aliases and emits canonical league codes', () => {
    const cfb = sagarin.normalizeSagarin({ raw: loadPage('NCAAF'), league: 'CFB', fetchedAt: FETCHED_AT });
    assert.equal(cfb.league, 'NCAAF');
    assert.equal(cfb.records.length, PAGE_EXPECTATIONS.NCAAF.records);
    const cbb = sagarin.normalizeSagarin({ raw: loadPage('NCAAB'), league: 'CBB', fetchedAt: FETCHED_AT });
    assert.equal(cbb.league, 'NCAAB');
    assert.equal(sagarin.unsupportedReason('CFB'), null);
    assert.equal(sagarin.unsupportedReason('CBB'), null);
  });

  it('excludes MLB from Sagarin coverage with a reason', () => {
    assert.ok(!supportedLeagues('sagarin').includes('MLB'));
    assert.ok(!sagarin.supportedLeagues().includes('MLB'));
    assert.deepEqual(sagarin.supportedLeagues(), supportedLeagues('sagarin'));
    assert.match(sagarin.unsupportedReason('MLB'), /player ratings/i);
    assert.match(sagarin.unsupportedReason('WNBA'), /not published/i);
    assert.equal(sagarin.unsupportedReason('NCAAF'), null);
  });
});

describe('sagarin source adapter: fetch', () => {
  it('uses the injected fetch once and returns raw, sourceUrl and fetchedAt', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => 'page-bytes' };
    };

    const result = await sagarin.fetchSagarin({ league: 'NCAAF', fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://sagarin.com/sports/cfsend.htm');
    assert.equal(result.raw, 'page-bytes');
    assert.equal(result.sourceUrl, 'http://sagarin.com/sports/cfsend.htm');
    assert.equal(typeof result.fetchedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  });

  it('maps each supported league to its verified page', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => 'x' };
    };
    for (const league of ['NCAAF', 'NFL', 'NBA', 'NCAAB', 'NHL', 'MLS']) {
      await sagarin.fetchSagarin({ league, fetchImpl });
    }
    assert.deepEqual(urls, [
      'http://sagarin.com/sports/cfsend.htm',
      'http://sagarin.com/sports/nflsend.htm',
      'http://sagarin.com/sports/nbasend.htm',
      'http://sagarin.com/sports/cbsend.htm',
      'http://sagarin.com/sports/nhlsend.htm',
      'http://sagarin.com/sports/soccer.htm'
    ]);
  });

  it('refuses an unsupported league instead of fetching an empty page', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '' };
    };

    await assert.rejects(() => sagarin.fetchSagarin({ league: 'MLB', fetchImpl }), /player ratings/i);
    assert.equal(called, false);
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(() => sagarin.fetchSagarin({ league: 'NCAAF', fetchImpl }), /503/);
  });

  it('requires an injected fetch implementation', async () => {
    await assert.rejects(() => sagarin.fetchSagarin({ league: 'NCAAF' }), /fetchImpl/);
  });
});

// ---------------------------------------------------------------------------
// Benchmark fixture: docs/research/sagarin-ncaaf-benchmark-2026-09-06.md
// ---------------------------------------------------------------------------
//
// `test/fixtures/ratings/sagarin-ncaaf-2026-w2.json` is a SYNTHETIC-BUT-
// REPRESENTATIVE reconstruction of that one-week Sagarin snapshot. The doc
// verified its counts against ESPN's dated college-football scoreboard feeds;
// the fixture only re-encodes those numbers so the adapter and the shared
// evaluation module are pinned to real arithmetic. It is a regression fixture,
// NOT a model estimate: the doc's own caveats bind here (the 90% winner rate is
// a short snapshot, it mixes FBS/FCS games, and it must never be presented as
// stable accuracy).

const BENCHMARK_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'ratings', 'sagarin-ncaaf-2026-w2.json');
const BENCHMARK_EXPECTED = Object.freeze({
  rows: 118,
  matched: 90,
  unmatched: 28,
  correct: 81,
  incorrect: 9,
  daily: Object.freeze({
    '2026-09-03': Object.freeze({ wins: 9, losses: 2 }),
    '2026-09-04': Object.freeze({ wins: 8, losses: 0 }),
    '2026-09-05': Object.freeze({ wins: 63, losses: 5 }),
    '2026-09-06': Object.freeze({ wins: 1, losses: 2 })
  })
});

function loadBenchmarkFixture() {
  return JSON.parse(fs.readFileSync(BENCHMARK_FIXTURE_PATH, 'utf8'));
}

function runBenchmarkFixture() {
  const fixture = loadBenchmarkFixture();
  const normalized = sagarin.normalizeSagarin({
    raw: fixture.pageLines.join('\n'),
    league: fixture.league,
    fetchedAt: fixture.fetchedAt
  });
  return { fixture, normalized };
}

// Zip the adapter's contract records to the fixture's per-row verified result.
// Matched rows carry the doc's verified outcome; unmatched rows carry NO
// outcome at all, so the evaluator can never grade them as losses.
function benchmarkEvaluationRows(normalized, games) {
  return normalized.records.map((record, index) => {
    const game = games[index];
    return {
      outcome: game.matched ? game.outcome : null,
      matched: game.matched,
      segment: game.segment,
      date: game.matched ? game.date : null,
      predictionTimestamp: game.matched ? `${game.date}T16:00:00.000Z` : null
    };
  });
}

describe('sagarin source adapter: 2026 week-2 verified benchmark fixture', () => {
  it('parses the whole snapshot through the adapter with nothing skipped', () => {
    const { fixture, normalized } = runBenchmarkFixture();

    assert.equal(fixture.games.length, BENCHMARK_EXPECTED.rows);
    assert.equal(fixture.pageLines.length, BENCHMARK_EXPECTED.rows + 6);
    assert.equal(normalized.coverage, 'full');
    assert.equal(normalized.skipped.length, 0);
    assert.equal(normalized.blockCandidateRows, BENCHMARK_EXPECTED.rows);
    assert.equal(normalized.records.length, BENCHMARK_EXPECTED.rows);
    // This fixture is prediction-block rows only, so it exercises the block half
    // of the coverage denominator and contributes no team candidates.
    assert.equal(normalized.teamCandidateRows, 0);
    // The doc's stale heading: asOf is the page's own date, not our fetch time.
    assert.equal(normalized.asOf, fixture.asOf);
    assert.equal(normalized.season, fixture.season);
    assert.notEqual(normalized.asOf, normalized.fetchedAt);
  });

  it('reproduces the doc counts through the evaluation module', () => {
    const { fixture, normalized } = runBenchmarkFixture();
    const scored = scoreSagarinRows(benchmarkEvaluationRows(normalized, fixture.games));

    assert.deepEqual(scored.counts, {
      total: BENCHMARK_EXPECTED.rows,
      resolved: BENCHMARK_EXPECTED.matched,
      unmatched: BENCHMARK_EXPECTED.unmatched,
      unresolved: 0,
      pushed: 0
    });
  });

  it('reproduces the daily winner split without grading unmatched rows', () => {
    const { fixture, normalized } = runBenchmarkFixture();
    const rows = benchmarkEvaluationRows(normalized, fixture.games);

    // A game date is not one of Sagarin's FBS/FCS segment values, so this uses
    // the source-agnostic segmenter: the Sagarin wrapper's resolver coerces
    // every segment field to FBS/FCS/other, which would collapse the dates.
    const segmented = segmentRatingRows(rows, {
      segments: ['segment', 'date'],
      dimensions: ['date'],
      minSample: 1
    });

    assert.deepEqual(segmented.dimensions, ['date']);
    let wins = 0;
    let losses = 0;
    for (const [date, expected] of Object.entries(BENCHMARK_EXPECTED.daily)) {
      const segment = segmented.segments[date];
      assert.ok(segment, `missing daily segment ${date}`);
      assert.equal(segment.wins, expected.wins, date);
      assert.equal(segment.losses, expected.losses, date);
      assert.equal(segment.totalDecided, expected.wins + expected.losses, date);
      wins += segment.wins;
      losses += segment.losses;
    }
    assert.equal(wins, BENCHMARK_EXPECTED.correct);
    assert.equal(losses, BENCHMARK_EXPECTED.incorrect);
    assert.equal(wins / (wins + losses), 0.9);
    assert.equal(segmented.counts.unmatched, BENCHMARK_EXPECTED.unmatched);
  });

  it('segments the matched rows by the FBS/FCS level the doc warns about', () => {
    const { fixture, normalized } = runBenchmarkFixture();
    const segmented = segmentSagarinRows(benchmarkEvaluationRows(normalized, fixture.games), { minSample: 1 });

    assert.deepEqual(segmented.dimensions, ['segment']);
    // Every correct call was an FBS game; the two FCS-involving games both lost.
    assert.equal(segmented.segments.FBS.wins, 81);
    assert.equal(segmented.segments.FBS.losses, 7);
    assert.equal(segmented.segments.FCS.wins, 0);
    assert.equal(segmented.segments.FCS.losses, 2);
  });

  it('keeps unmatched rows as their own status, never resolved and never a loss', () => {
    const { fixture, normalized } = runBenchmarkFixture();
    const { rows, unresolved } = normalizeSagarinRows(benchmarkEvaluationRows(normalized, fixture.games));

    assert.equal(unresolved.length, 0);
    const unmatched = rows.filter((row) => row.status === 'unmatched');
    assert.equal(unmatched.length, BENCHMARK_EXPECTED.unmatched);
    // No verified result was invented for an excluded row.
    assert.ok(unmatched.every((row) => row.outcome === null));
    assert.equal(rows.filter((row) => row.status === 'matched').length, BENCHMARK_EXPECTED.matched);
  });

  it('is internally consistent with the doc it was derived from', () => {
    const fixture = loadBenchmarkFixture();
    const matched = fixture.games.filter((game) => game.matched);

    assert.equal(fixture.games.length, BENCHMARK_EXPECTED.rows);
    assert.equal(matched.length, BENCHMARK_EXPECTED.matched);
    assert.equal(fixture.games.length - matched.length, BENCHMARK_EXPECTED.unmatched);

    // The doc names its nine misses; the fixture's losses are exactly those.
    const misses = matched.filter((game) => game.outcome === 'loss').map((game) => `${game.favorite}-${game.underdog}`);
    assert.deepEqual(misses.sort(), [
      'Charlotte-The Citadel',
      'Georgia Tech-Colorado',
      'Hawaii-UNLV',
      'Louisville-Ole Miss',
      'Oklahoma State-Tulsa',
      'Rutgers-Massachusetts',
      'Utah State-Idaho State',
      'Western Kentucky-Nevada',
      'Wisconsin-Notre Dame'
    ]);
  });
});
