'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportedLeagues } = require('../lib/ssb-ratings-contract');
const sagarin = require('../lib/ratings-sources/sagarin');
const { normalizeSagarinRows, scoreSagarinRows, segmentSagarinRows } = require('../lib/sagarin-external-evaluation');
const { segmentRatingRows } = require('../lib/ssb-external-ratings-evaluation');

// Format-accurate excerpts of Sagarin's legacy fixed-width CFB page. These are a
// handful of real rows (not a dataset) so the fixture exercises the exact
// column layout: home favorite, neutral-site favorite, away favorite, and the
// double `N @` marker, plus one deliberately unparseable row.
const REGULAR_FIXTURE = [
  'Predictions_with_Totals_and_Moneylines',
  '',
  '2026 College Football through games of September 12 Saturday - Week 2',
  'HOME ADVANTAGE=                  2.41   2.41   2.41   2.41   2.41',
  '',
  '          FAVORITE             Rating   Pred  Golden Recent Strong  UNDERDOG                MONEY  WIN%    home   away  TOTAL  HMARG WIN% MONEY',
  '    1   @ Pittsburgh            10.26   9.30  11.61  10.39  10.41   Syracuse                 297    75%   27.46  17.20  44.66  10.26  75%   297',
  '   28 N   Arizona State          6.02   3.72   3.28  10.18  11.88 @ Kansas                   193    66%   28.89  34.91  63.79  -6.02 -66%   193',
  '   33     SMU                    2.37  -1.54  -0.34   6.13   6.44 @ Louisville               130    57%   36.26  38.63  74.88  -2.37 -57%   130',
  '    4   @ Broken Row           not-a-number',
  '   72 N @ Virginia              11.11   4.86   5.09  38.06  44.23   West Virginia            323    76%   26.02  14.91  40.94  11.11  76%   323'
].join('\n');

const EXPERIMENTAL_FIXTURE = [
  'EXPERIMENTAL NUMBERS INVOLVING HOME-AWAY ADJUSTMENTS FOR EACH TEAM',
  '2026 College Football through games of September 12 Saturday - Week 2',
  'HOME ADVANTAGE=                  2.41   2.41   2.41   2.41   2.41',
  '',
  '          FAVORITE             Rating   Pred  Golden Recent Strong  UNDERDOG                MONEY  WIN%    home   away  TOTAL  HMARG WIN% MONEY',
  '    1   @ Pittsburgh            13.93  12.97  15.28  14.06  14.07   Syracuse                 422    81%   29.29  15.37  44.66  13.93  81%   422',
  '    3     Houston               12.63   7.69   5.04  18.80  29.22 @ Texas Tech               373    79%   24.17  36.80  60.98 -12.63 -79%   373'
].join('\n');

const FETCHED_AT = '2026-09-15T12:00:00.000Z';

function normalize(overrides = {}) {
  return sagarin.normalizeSagarin({
    raw: REGULAR_FIXTURE,
    league: 'NCAAF',
    fetchedAt: FETCHED_AT,
    ...overrides
  });
}

describe('sagarin source adapter: normalize', () => {
  it('parses the fixed-width block into contract records', () => {
    const result = normalize();

    assert.equal(result.source, 'sagarin');
    assert.equal(result.league, 'NCAAF');
    assert.equal(result.coverage, 'full');
    assert.equal(result.method, 'overall');
    assert.equal(result.block, 'regular');
    assert.equal(result.season, 2026);
    assert.equal(result.records.length, 4);
    assert.equal(result.homeAdvantage, 2.41);
    assert.match(result.sourceHash, /^[0-9a-f]{64}$/);
    assert.ok(result.records.every((record) => record.sourceHash === result.sourceHash));
    assert.ok(result.records.every((record) => record.matchStatus === 'unmatched'));
    assert.ok(result.records.every((record) => record.method === 'overall'));
  });

  it('stores the heading date as asOf separately from fetchedAt', () => {
    const result = normalize();
    assert.equal(result.asOf, '2026-09-12');
    assert.notEqual(result.asOf, result.fetchedAt);
    assert.equal(result.fetchedAt, FETCHED_AT);
    assert.ok(result.records.every((record) => record.asOf === '2026-09-12'));
    assert.ok(result.records.every((record) => record.fetchedAt === FETCHED_AT));
  });

  it('maps both teams, predicted scores, totals and the neutral marker', () => {
    const rows = normalize().records;
    const [pittsburgh, arizonaState, smu, virginia] = rows;

    // Home favorite: the `@` team's score lives in the `home` column.
    assert.equal(pittsburgh.teamA, 'Pittsburgh');
    assert.equal(pittsburgh.teamB, 'Syracuse');
    assert.equal(pittsburgh.neutral, false);
    assert.equal(pittsburgh.predictedMargin, 10.26);
    assert.equal(pittsburgh.predictedScoreA, 27.46);
    assert.equal(pittsburgh.predictedScoreB, 17.2);
    assert.equal(pittsburgh.predictedTotal, 44.66);

    // Neutral site, favorite is the away side -> margin sign is still favorite-positive.
    assert.equal(arizonaState.teamA, 'Arizona State');
    assert.equal(arizonaState.teamB, 'Kansas');
    assert.equal(arizonaState.neutral, true);
    assert.equal(arizonaState.predictedMargin, 6.02);
    assert.equal(arizonaState.predictedScoreA, 34.91);
    assert.equal(arizonaState.predictedScoreB, 28.89);

    // Away favorite at a true home venue.
    assert.equal(smu.teamA, 'SMU');
    assert.equal(smu.teamB, 'Louisville');
    assert.equal(smu.neutral, false);
    assert.equal(smu.predictedMargin, 2.37);
    assert.equal(smu.predictedScoreA, 38.63);
    assert.equal(smu.predictedScoreB, 36.26);

    // `N @` double marker: neutral venue, closer team is the favorite.
    assert.equal(virginia.teamA, 'Virginia');
    assert.equal(virginia.teamB, 'West Virginia');
    assert.equal(virginia.neutral, true);
    assert.equal(virginia.predictedScoreA, 26.02);
    assert.equal(virginia.predictedScoreB, 14.91);
    assert.equal(virginia.predictedTotal, 40.94);
  });

  it('produces records the contract validator accepts', () => {
    const { validateRatingRecord } = require('../lib/ssb-ratings-contract');
    for (const record of normalize().records) {
      const { ok, errors } = validateRatingRecord(record);
      assert.deepEqual(errors, []);
      assert.equal(ok, true);
    }
  });

  it('skips a garbage line without throwing and reports it', () => {
    const result = normalize();
    assert.equal(result.records.length, 4);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'unparseable_row');
    assert.match(result.skipped[0].text, /Broken Row/);
    assert.equal(result.skipped[0].line, 10);
  });

  it('preserves the method split instead of collapsing it', () => {
    const recent = normalize({ method: 'recent' });
    assert.equal(recent.method, 'recent');
    assert.equal(recent.records.length, 4);
    assert.ok(recent.records.every((record) => record.method === 'recent'));
    assert.deepEqual(
      recent.records.map((record) => record.predictedMargin),
      [10.39, 10.18, 6.13, 38.06]
    );

    const predictor = normalize({ method: 'predictor' });
    assert.deepEqual(
      predictor.records.map((record) => record.predictedMargin),
      [9.3, 3.72, -1.54, 4.86]
    );
  });

  it('never merges the experimental home-away block into the regular block', () => {
    const regular = normalize();
    const experimental = sagarin.normalizeSagarin({
      raw: EXPERIMENTAL_FIXTURE,
      league: 'NCAAF',
      fetchedAt: FETCHED_AT,
      method: 'experimental_overall'
    });

    assert.equal(experimental.block, 'experimental');
    assert.equal(experimental.method, 'experimental_overall');
    assert.equal(experimental.coverage, 'full');
    assert.equal(experimental.records.length, 2);
    assert.ok(experimental.records.every((record) => record.method === 'experimental_overall'));
    // Same fixture teams, different block: the margins must not be conflated.
    assert.equal(experimental.records[0].predictedMargin, 13.93);
    assert.equal(regular.records[0].predictedMargin, 10.26);
    assert.notEqual(experimental.records[0].method, regular.records[0].method);
  });

  it('fails closed for MLB with the player-ratings reason', () => {
    const result = normalize({ league: 'MLB' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /player ratings/i);

    const experimental = normalize({ league: 'MLB', method: 'experimental_overall' });
    assert.equal(experimental.coverage, 'unavailable');
    assert.match(experimental.unresolvedReason, /player ratings/i);
  });

  it('reports an unknown league as unavailable rather than empty success', () => {
    const result = normalize({ league: 'WNBA' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.ok(result.unresolvedReason.length > 0);
  });

  it('reports unavailable when the prediction block is missing', () => {
    const result = normalize({ raw: 'nothing useful here\n' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.match(result.unresolvedReason, /block/i);
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

// Shapes confirmed against the live pages: NBA/CBB/NHL rows omit the trailing
// `HMARG WIN% MONEY` triple, and the CBB page labels the block
// `Predictions_with_Totals` while spelling its season `2022-2023`.
const NBA_SHAPE_FIXTURE = [
  'Predictions_with_Totals_and_Moneylines',
  'Final NBA 2025-2026 through games of 2026 June 13 Saturday - NBA FINALS - FINAL RATINGS',
  'HOME ADVANTAGE=                  1.82   1.76   1.76   1.93   1.93',
  '          FAVORITE             Rating   Pred  Golden Recent Strong  UNDERDOG               MONEY   WIN%    home   away  TOTAL',
  '    1   @ New York Knicks        1.77   2.22   0.86   2.77   3.47   San Antonio Spurs        124    55%  113.58 112.73 226.32'
].join('\n');

const CBB_SHAPE_FIXTURE = [
  'Predictions_with_Totals',
  'FINAL College Basketball 2022-2023    Div I games only    through games of 2023 April 3 Monday - Final Ratings',
  'HOME ADVANTAGE=                  3.09   3.09   3.09   3.09   3.09',
  '          FAVORITE             Rating   Pred  Golden Recent Strong  UNDERDOG               MONEY   WIN%    home   away  TOTAL',
  '    1   @ Connecticut           1.77   2.22   0.86   2.77   3.47   Alabama                  124    55%  113.58 112.73 226.32'
].join('\n');

describe('sagarin source adapter: live page shape variations', () => {
  it('parses rows that omit the trailing HMARG/WIN%/MONEY triple', () => {
    const result = sagarin.normalizeSagarin({
      raw: NBA_SHAPE_FIXTURE,
      league: 'NBA',
      fetchedAt: FETCHED_AT
    });
    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 1);
    // Season label carries two years; the one next to the month is the season.
    assert.equal(result.asOf, '2026-06-13');
    assert.equal(result.season, 2026);
    const record = result.records[0];
    assert.equal(record.teamA, 'New York Knicks');
    assert.equal(record.teamB, 'San Antonio Spurs');
    assert.equal(record.predictedMargin, 1.77);
    assert.equal(record.predictedScoreA, 113.58);
    assert.equal(record.predictedScoreB, 112.73);
    assert.equal(record.predictedTotal, 226.32);
  });

  it("accepts the college-basketball page's shorter block label", () => {
    const result = sagarin.normalizeSagarin({
      raw: CBB_SHAPE_FIXTURE,
      league: 'NCAAB',
      fetchedAt: FETCHED_AT
    });
    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 1);
    assert.equal(result.asOf, '2023-04-03');
    assert.equal(result.season, 2023);
    assert.equal(result.records[0].league, 'NCAAB');
  });

  it('accepts the CFB/CBB aliases and emits canonical league codes', () => {
    const cfb = sagarin.normalizeSagarin({ raw: REGULAR_FIXTURE, league: 'CFB', fetchedAt: FETCHED_AT });
    assert.equal(cfb.league, 'NCAAF');
    assert.equal(cfb.records.length, 4);
    assert.equal(sagarin.unsupportedReason('CFB'), null);
    assert.equal(sagarin.unsupportedReason('CBB'), null);
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
    assert.equal(normalized.records.length, BENCHMARK_EXPECTED.rows);
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
