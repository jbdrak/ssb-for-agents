'use strict';

// The evaluation bridge: adapter records -> the rows the evaluator scores.
//
// This file exists because the layer was previously two halves that could never
// meet: the adapters produced contract records with no probability field at all,
// and the evaluator scored a `modelWinProbability` nothing in the product could
// construct. Its tests passed on hand-built rows while no real path could feed
// it. Everything asserted here is anchored to captured vendor payloads
// (`test/fixtures/ratings/`) or to the verified one-week benchmark fixture, so
// the chain is exercised with real bytes rather than with rows shaped the way
// the assertions expect.
//
// A green suite must not be able to hide a dead path, so each section pairs its
// happy path with the discriminating input: the winner is mapped to a NAMED
// side (a swap yields 9/81 instead of 81/9), the market gate returns no number
// until a market input is supplied, and a source with no published probability
// is asserted to be ABSENT from `evaluateRatingSources`' own output - which is
// exactly why the bridge reports it separately.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { SOURCES, PROBABILITY_KINDS, validateRatingRecord } = require('../lib/ssb-ratings-contract');
const { evaluateRatingSources, evaluateMarketRelative } = require('../lib/ssb-external-ratings-evaluation');
const {
  buildRatingEvaluationRows,
  probabilitySupport,
  PROBABILITY_SUPPORT
} = require('../lib/ssb-ratings-evaluation-bridge');
const sagarin = require('../lib/ratings-sources/sagarin');
const massey = require('../lib/ratings-sources/massey');
const sasser = require('../lib/ratings-sources/sasser');

const FIXTURES = path.join(__dirname, 'fixtures', 'ratings');
const CAPTURE_DATE = '2026-09-16';
const FETCHED_AT = '2026-09-16T12:00:00.000Z';

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Hand-built contract records: for the fail-closed cases only. Every one goes
// through the shared validator, so a case can only exercise the bridge with a
// record the contract itself accepts.
// ---------------------------------------------------------------------------

function contractRecord(overrides = {}) {
  const { ok, record, errors } = validateRatingRecord({
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-10',
    fetchedAt: FETCHED_AT,
    sourceUrl: 'http://sagarin.com/sports/cfsend.htm',
    sourceHash: 'a'.repeat(64),
    eventId: null,
    teamA: 'Pittsburgh',
    teamB: 'Syracuse',
    neutral: false,
    ratingA: null,
    ratingB: null,
    predictedScoreA: 27.46,
    predictedScoreB: 17.2,
    predictedTotal: 44.66,
    predictedMargin: 10.26,
    homeAdvantage: 2.41,
    marketOpen: null,
    marketCurrent: null,
    modelWinProbability: 0.75,
    modelWinProbabilityKind: 'published',
    coverage: 'full',
    matchStatus: 'unmatched',
    unresolvedReason: null,
    ...overrides
  });
  assert.deepEqual(errors, [], 'the fixture record must be contract-valid');
  assert.equal(ok, true);
  return record;
}

const PITT_OUTCOME = Object.freeze({
  league: 'NCAAF',
  game: 'Pittsburgh vs Syracuse',
  winner: 'Pittsburgh',
  gameTimestamp: '2026-09-12T16:00:00.000Z',
  settledAt: '2026-09-12T19:30:00.000Z'
});

function build(options) {
  return buildRatingEvaluationRows(options);
}

// ---------------------------------------------------------------------------
// 1. The real chain: captured Sagarin page -> adapter -> bridge -> evaluator.
// ---------------------------------------------------------------------------

const BENCHMARK = JSON.parse(readFixture('sagarin-ncaaf-2026-w2.json'));
// The doc's verified counts for this snapshot, plus what the BRIDGE can score
// from it. The two differ on purpose: the fixture is a synthetic-but-
// representative reconstruction whose 90 "matched" games include 17 pairings
// printed twice with different dates (see the ambiguity test below), and a single
// prediction row cannot be attributed to one of two games. So the bridge refuses
// those 34 records and scores 56, which is the honest number - not the doc's.
//
// `rows` is the wider set: every record the bridge can attribute to a fixture
// key, which now includes the 28 FCS-involving games whose team names used to be
// unkeyable (the registry seeds FCS spellings now, so `unkeyable` is 0). Those
// 28 carry no settled outcome in the fixture, so they are reported `unmatched`
// and never graded as losses - `rows === joined + unmatched`.
const BENCHMARK_EXPECTED = Object.freeze({
  records: 118,
  docMatched: 90,
  docUnmatched: 28,
  docCorrect: 81,
  docIncorrect: 9,
  ambiguousRecords: 34,
  ambiguousInputs: 17,
  rows: 84,
  unkeyable: 0,
  unmatched: 28,
  joined: 56,
  scored: 56,
  correct: 47,
  incorrect: 9
});

function benchmarkRecords() {
  return sagarin.normalizeSagarin({
    raw: BENCHMARK.pageLines.join('\n'),
    league: BENCHMARK.league,
    fetchedAt: BENCHMARK.fetchedAt
  }).records;
}

// Settled outcomes from the fixture's own verified per-game results: the winner
// is built from the NAMED side (favorite vs underdog), never from the expected
// outcome, so a bridge that mapped the winner to the wrong side of the fixture
// would flip the aggregate to 9/81 and fail.
function benchmarkOutcomes() {
  return BENCHMARK.games
    .filter((game) => game.matched)
    .map((game) => ({
      league: BENCHMARK.league,
      // Deliberately the REVERSED label order, to pin the order-independent key.
      game: `${game.underdog} vs ${game.favorite}`,
      winner: game.outcome === 'win' ? game.favorite : game.underdog,
      gameTimestamp: `${game.date}T16:00:00.000Z`,
      settledAt: `${game.date}T23:00:00.000Z`
    }));
}

describe('ratings evaluation bridge: captured Sagarin page -> adapter -> bridge -> evaluator', () => {
  it('parses the benchmark page and carries the published probability on every record', () => {
    const records = benchmarkRecords();
    assert.equal(records.length, BENCHMARK_EXPECTED.records);
    assert.ok(records.every((record) => record.modelWinProbabilityKind === 'published'));
    assert.ok(records.every((record) => record.modelWinProbability >= 0 && record.modelWinProbability <= 1));
    // The fixture's own printed column, read independently of the adapter.
    const rutgers = records[0];
    assert.equal(rutgers.teamA, 'Rutgers');
    assert.equal(rutgers.modelWinProbability, 0.5);
  });

  it('joins records to settled outcomes and reports every exclusion by reason', () => {
    const result = build({ records: benchmarkRecords(), outcomes: benchmarkOutcomes() });

    assert.equal(result.counts.records, BENCHMARK_EXPECTED.records);
    assert.equal(result.counts.rows, BENCHMARK_EXPECTED.rows);
    assert.equal(result.counts.joined, BENCHMARK_EXPECTED.joined);
    assert.equal(result.counts.unmatched, BENCHMARK_EXPECTED.unmatched);
    assert.equal(result.counts.recordsSkipped, BENCHMARK_EXPECTED.ambiguousRecords + BENCHMARK_EXPECTED.unkeyable);
    assert.equal(result.counts.inputSkipped, BENCHMARK_EXPECTED.ambiguousInputs);
    assert.equal(result.counts.outcomes, BENCHMARK_EXPECTED.joined);

    // A keyed record whose game has no settled outcome is `unmatched`, not a
    // loss and not a skip - the distinction the FCS rows sit on.
    assert.equal(result.counts.rows, result.counts.joined + result.counts.unmatched);

    // Every record that produced no row is accounted for, and the reasons are
    // the real ones: 17 of the fixture's pairings are printed twice on different
    // dates, so one prediction cannot be attributed to one game. No record is
    // dropped for identity any more - the registry seeds the FCS spellings that
    // used to make these records unkeyable.
    const byReason = Object.fromEntries(
      result.skipped.map((entry) => [`${entry.source}|${entry.reason}`, entry.count])
    );
    assert.deepEqual(byReason, {
      'null|ambiguous_outcome_for_fixture': BENCHMARK_EXPECTED.ambiguousInputs,
      'sagarin|ambiguous_fixture': BENCHMARK_EXPECTED.ambiguousRecords
    });
    assert.ok(result.skipped.every((entry) => entry.sample.length > 0 && entry.sample.length <= 3));

    // The accounting closes: every offered record became a row or a stated drop,
    // and every dropped input is counted.
    assert.equal(result.counts.records - result.counts.recordsSkipped, result.counts.rows);

    assert.deepEqual(result.sources.sagarin, {
      source: 'sagarin',
      records: BENCHMARK_EXPECTED.records,
      rows: BENCHMARK_EXPECTED.rows,
      joined: BENCHMARK_EXPECTED.joined,
      unmatched: BENCHMARK_EXPECTED.unmatched,
      probability: { available: true, kind: 'published', reason: PROBABILITY_SUPPORT.sagarin.reason }
    });
  });

  it('refuses a fixture two settled outcomes claim instead of picking one', () => {
    // The real shape, from the fixture: the same pairing on two dates. A record
    // carries no game timestamp, so scoring it against either result would be a
    // guess - and the guess flips win to loss half the time.
    const pair = { league: 'NCAAF', game: 'Pittsburgh vs Syracuse', winner: 'Pittsburgh' };
    const result = build({
      records: [contractRecord()],
      outcomes: [pair, { ...pair, gameTimestamp: '2026-09-13T16:00:00.000Z' }]
    });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(result.counts, {
      records: 1,
      rows: 0,
      joined: 0,
      unmatched: 0,
      recordsSkipped: 1,
      inputSkipped: 1,
      outcomes: 0,
      markets: 0
    });
    const byReason = Object.fromEntries(
      result.skipped.map((entry) => [`${entry.source}|${entry.reason}`, entry.count])
    );
    assert.deepEqual(byReason, { 'sagarin|ambiguous_fixture': 1, 'null|ambiguous_outcome_for_fixture': 1 });
  });

  it('scores the real chain and reproduces the verified winner split over the joinable rows', () => {
    const result = build({ records: benchmarkRecords(), outcomes: benchmarkOutcomes() });
    const scored = evaluateRatingSources(result.rows, { dimensions: ['league'], minSample: 1 });

    // Coverage before any score, as the evaluator's own contract requires.
    assert.equal(scored.sources.sagarin.coverage.total, BENCHMARK_EXPECTED.rows);
    assert.equal(scored.sources.sagarin.coverage.resolved, BENCHMARK_EXPECTED.joined);
    assert.equal(scored.sources.sagarin.coverage.sampleSize, BENCHMARK_EXPECTED.scored);
    assert.equal(scored.sources.sagarin.coverage.unresolved, 0);
    assert.equal(scored.sources.sagarin.coverage.unmatched, BENCHMARK_EXPECTED.unmatched);

    // A non-empty scored block on the real numbers: 47 wins, 9 losses. The
    // winner is resolved from the NAMED side, so a swapped mapping gives 9/47.
    // (The doc's full-snapshot 81/9 covers all 90 games it counted; 34 of those
    // are refused above as unattributable, and all 34 were wins, which is why the
    // totals differ by 34 rather than by some other amount.)
    const segment = scored.sources.sagarin.segments.NCAAF;
    assert.ok(segment, 'the bridge output must produce a scored segment');
    assert.equal(segment.wins, BENCHMARK_EXPECTED.correct);
    assert.equal(segment.losses, BENCHMARK_EXPECTED.incorrect);
    assert.equal(segment.totalDecided, BENCHMARK_EXPECTED.scored);
    // The difference from the doc is fully explained: all 34 refused records were
    // wins, so 47 + 34 reconciles exactly with the doc's 81.
    assert.equal(BENCHMARK_EXPECTED.correct + BENCHMARK_EXPECTED.ambiguousRecords, BENCHMARK_EXPECTED.docCorrect);

    const brier = scored.sources.sagarin.scores.modelWinProbability.brier;
    assert.equal(brier.samples, BENCHMARK_EXPECTED.scored);
    assert.ok(brier.value > 0 && brier.value < 1);
  });

  it('attributes each row to the side the source picked, not the fixture order', () => {
    const result = build({ records: benchmarkRecords(), outcomes: benchmarkOutcomes() });
    // Rutgers was the fixture's favorite (selection) and LOST to Massachusetts.
    const rutgers = result.rows.find((row) => row.selection === 'Rutgers');
    assert.ok(rutgers);
    assert.equal(rutgers.source, 'sagarin');
    assert.equal(rutgers.outcome, 'loss');
    assert.equal(rutgers.matched, true);
    assert.equal(rutgers.modelWinProbability, 0.5);
    assert.equal(rutgers.predictionTimestamp, BENCHMARK.asOf);
    assert.equal(rutgers.gameTimestamp, '2026-09-03T16:00:00.000Z');

    // Its counterpart: a fixture the favorite DID win.
    const winner = result.rows.find((row) => row.outcome === 'win');
    assert.ok(winner);
  });

  it('scores the same rows against a de-vigged close only once a market input exists', () => {
    const result = build({ records: benchmarkRecords(), outcomes: benchmarkOutcomes() });

    // Without market input the gate has nothing to compare against, and says so
    // instead of returning a number.
    const ungated = evaluateMarketRelative(result.rows, { dimensions: ['marketFavoriteBand'], minSample: 1 });
    assert.equal(ungated.status, 'insufficient_sample');
    assert.equal(ungated.sampleSize, 0);
    assert.equal(ungated.clvPct, undefined);

    // The market input is what unlocks it, joined on the same fixture key. A
    // Sagarin record carries no market scope, so the caller supplies the
    // fixture's own close rather than one labelled with a market.
    const markets = benchmarkOutcomes().map((outcome) => ({
      league: outcome.league,
      game: outcome.game,
      marketFairProbability: 0.4,
      closingOdds: 150
    }));
    const gated = build({ records: benchmarkRecords(), outcomes: benchmarkOutcomes(), markets });
    // The 17 repeated pairings collide here too, so exactly the rows the outcome
    // join could attribute are the rows with a comparison price.
    assert.equal(gated.counts.markets, BENCHMARK_EXPECTED.scored);
    assert.equal(gated.counts.inputSkipped, BENCHMARK_EXPECTED.ambiguousInputs * 2);

    const market = evaluateMarketRelative(gated.rows, { dimensions: ['marketFavoriteBand'], minSample: 1 });
    assert.equal(market.status, 'ok');
    assert.equal(market.sampleSize, BENCHMARK_EXPECTED.scored);
    assert.equal(market.marketInput, 'marketFairProbability');
    assert.equal(market.interpretation, 'context_confirmation_veto');
    // Mean(model - fair close) in points: the fixture's printed probabilities are
    // all above the 0.40 close we supplied for every game. The mean is over the
    // rows the gate actually priced - a record that never joined a settled
    // outcome has no comparison price either, so it is not in this sample.
    const gatedRows = gated.rows.filter((row) => row.marketFairProbability !== undefined);
    assert.equal(gatedRows.length, BENCHMARK_EXPECTED.scored);
    const mean = gatedRows.reduce((sum, row) => sum + row.modelWinProbability, 0) / gatedRows.length;
    assert.equal(market.clvPct, Math.round((mean * 100 - 40) * 100) / 100);
  });

  it('never prices a record against a market it does not claim', () => {
    // A Sagarin record is market-wildcard (the contract defines no market), so it
    // is served only by the fixture's own close - never by a labelled one. A
    // win probability compared against a spread's closing line would be a
    // category error, and the row must not wear the spread's label either.
    const labelled = build({
      records: benchmarkRecords(),
      outcomes: benchmarkOutcomes(),
      markets: benchmarkOutcomes().map((outcome) => ({
        league: outcome.league,
        game: outcome.game,
        market: 'Point Spread',
        marketFairProbability: 0.4
      }))
    });

    assert.equal(labelled.rows.length, BENCHMARK_EXPECTED.rows);
    assert.equal(labelled.counts.markets, BENCHMARK_EXPECTED.scored);
    assert.ok(labelled.rows.every((row) => row.marketFairProbability === undefined));
    assert.ok(labelled.rows.every((row) => row.market === null));

    // The tennis adapter's Moneyline-scoped record, by contrast, joins an
    // identically-scoped close and keeps its own label.
    const scoped = build({
      records: [{ ...contractRecord(), market: 'Moneyline' }],
      outcomes: [PITT_OUTCOME],
      markets: [{ league: 'NCAAF', game: 'Pittsburgh vs Syracuse', market: 'moneyline', marketFairProbability: 0.6 }]
    });

    assert.equal(scoped.rows[0].marketFairProbability, 0.6);
    assert.equal(scoped.rows[0].market, 'Moneyline');
  });
});

// ---------------------------------------------------------------------------
// 2. The explicit declines: a source with no published probability.
// ---------------------------------------------------------------------------

describe('ratings evaluation bridge: sources with no win probability are declined, not silently skipped', () => {
  it('declares probability support for every source in the contract', () => {
    assert.ok(Object.keys(PROBABILITY_SUPPORT).length >= SOURCES.length);
    for (const source of SOURCES) {
      const support = probabilitySupport(source);
      assert.equal(typeof support.reason, 'string');
      assert.ok(support.reason.length > 0, `${source} needs a stated reason`);
      assert.ok(
        support.kind === null || PROBABILITY_KINDS.includes(support.kind),
        `${source} kind must be a contract probability kind`
      );
      assert.equal(support.available, support.kind !== null);
    }
    // An unknown source cannot borrow a reason.
    const unknown = probabilitySupport('espn');
    assert.equal(unknown.available, false);
    assert.match(unknown.reason, /not a source in the ratings contract/);
  });

  it('declines massey with the rating-vs-probability reason, not an empty score block', () => {
    const records = massey.normalizeMassey({
      raw: readFixture(`massey-ncaaf-${CAPTURE_DATE}.csv`),
      league: 'NCAAF',
      fetchedAt: FETCHED_AT
    }).records;
    assert.ok(records.length > 0, 'the captured NCAAF export must carry team rows');
    assert.ok(records.every((record) => record.modelWinProbability === null));

    const result = build({
      records,
      outcomes: records.map((record) => ({
        league: 'NCAAF',
        game: `${record.teamA} vs ${record.teamB}`,
        winner: record.teamA,
        gameTimestamp: '2026-09-12T16:00:00.000Z'
      }))
    });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => [entry.source, entry.reason, entry.count]),
      [['massey', 'probability_unavailable', records.length]]
    );

    const support = result.sources.massey.probability;
    assert.equal(support.available, false);
    assert.equal(support.kind, null);
    assert.match(support.reason, /never a win probability/);
    assert.match(support.reason, /no documented rating-to-probability conversion/);

    // The trap this guards: the evaluator's own output OMITS a source with no
    // rows, so on its own it would read as a clean result. The bridge names why.
    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(scored.sources, 'massey'), false);
  });

  it('declines sasser for the same class of reason, from its captured page', () => {
    const records = sasser.normalizeSasser({
      raw: readFixture('sasser-cfb-2026-w3.html'),
      league: 'NCAAF',
      fetchedAt: FETCHED_AT
    }).records;
    assert.ok(records.length > 0, 'the captured Sasser page must carry game rows');
    assert.ok(records.every((record) => record.modelWinProbability === null));

    const result = build({ records });
    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => [entry.source, entry.reason, entry.count]),
      [['sasser', 'probability_unavailable', records.length]]
    );
    assert.equal(result.sources.sasser.probability.available, false);
    assert.match(result.sources.sasser.probability.reason, /projected scores/);
  });
});

// ---------------------------------------------------------------------------
// 3. tennis_elo: the one DERIVED probability, adapter -> bridge -> evaluator.
// ---------------------------------------------------------------------------

describe('ratings evaluation bridge: the derived (tennis Elo) path', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-bridge-elo-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // The same hand-checkable ATP fixture the tennis adapter's own suite uses:
  // Djokovic 2125 / Alcaraz 2065 on hard after the engine's surface blend.
  function tennisSnapshot() {
    const { importMatchData } = require('../lib/tennis-elo-data');
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'snap-'));
    const csv = path.join(dir, 'matches.csv');
    fs.writeFileSync(
      csv,
      [
        'date,tour,surface,winner,loser,status',
        '2026-01-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed',
        '2026-01-02,ATP,clay,Novak Djokovic,Carlos Alcaraz,completed'
      ].join('\n'),
      'utf8'
    );
    const surfaces = (hard, hardMatches, clay, clayMatches) => ({
      hard: { rating: hard, matches: hardMatches },
      clay: { rating: clay, matches: clayMatches },
      grass: { rating: 2000, matches: 0 }
    });
    return importMatchData({
      inputPath: csv,
      license: 'CC BY-NC-SA 4.0 (user-verified)',
      asOf: '2026-09-13',
      importedAt: '2026-09-14T00:00:00Z',
      modelVersion: 'tennis-elo-1.1.0',
      sourceUrl: 'https://example.invalid/tennis_atp.csv',
      write: false,
      buildRatingsImpl: () => ({
        players: {
          ATP: {
            'Novak Djokovic': {
              name: 'Novak Djokovic',
              overall: 2100,
              surfaces: surfaces(2150, 20, 2080, 10),
              totalMatches: 33
            },
            'Carlos Alcaraz': {
              name: 'Carlos Alcaraz',
              overall: 2050,
              surfaces: surfaces(2080, 12, 2000, 4),
              totalMatches: 18
            }
          }
        },
        constants: { k: 32, surfaceWeight: 0.5, minSurfaceMatches: 5 },
        matchCount: 2
      })
    });
  }

  it('labels the engine expectation as derived and scores it end to end', () => {
    const tennisElo = require('../lib/ratings-sources/tennis-elo');
    const envelope = tennisElo.lookupMatch({
      snapshot: tennisSnapshot(),
      tour: 'atp',
      playerA: 'Novak Djokovic',
      playerB: 'Carlos Alcaraz',
      surface: 'hard',
      market: 'Moneyline',
      asOf: '2026-09-20'
    });

    assert.equal(envelope.records.length, 1);
    const record = envelope.records[0];
    assert.equal(record.ratingA, 2125);
    assert.equal(record.ratingB, 2065);
    // The engine's own expectation over the ratings on the record.
    assert.equal(record.modelWinProbability, 1 / (1 + Math.pow(10, (2065 - 2125) / 400)));
    assert.equal(record.modelWinProbabilityKind, 'derived');

    const result = build({
      records: [envelope],
      outcomes: [
        {
          league: 'TENNIS',
          game: 'Carlos Alcaraz vs Novak Djokovic',
          winner: 'Novak Djokovic',
          gameTimestamp: '2026-09-21T15:00:00.000Z'
        }
      ],
      markets: [
        { league: 'TENNIS', game: 'Novak Djokovic vs Carlos Alcaraz', market: 'Moneyline', marketFairProbability: 0.5 }
      ]
    });

    assert.equal(result.counts.rows, 1);
    assert.equal(result.sources.tennis_elo.probability.kind, 'derived');
    assert.equal(result.rows[0].outcome, 'win');
    assert.equal(result.rows[0].modelWinProbabilityKind, 'derived');
    assert.equal(result.rows[0].marketFairProbability, 0.5);
    assert.equal(result.rows[0].market, 'Moneyline');

    const scored = evaluateRatingSources(result.rows, { dimensions: ['modelWinProbabilityKind'], minSample: 1 });
    assert.equal(scored.sources.tennis_elo.coverage.sampleSize, 1);
    assert.ok(scored.sources.tennis_elo.scores.modelWinProbability.brier.samples === 1);
    assert.equal(scored.sources.tennis_elo.segments.DERIVED.wins, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed cases. Each one is a way a record can look scoreable and not be.
// ---------------------------------------------------------------------------

describe('ratings evaluation bridge: fails closed', () => {
  it('drops an unattributed probability instead of scoring a number nobody can attribute', () => {
    // Hand-built because the contract refuses this shape; the bridge must too,
    // so the guard cannot depend on the validator having run.
    const record = { ...contractRecord(), modelWinProbabilityKind: null };
    const result = build({ records: [record], outcomes: [PITT_OUTCOME] });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => [entry.source, entry.reason, entry.count]),
      [['sagarin', 'probability_unattributed', 1]]
    );
  });

  it('drops a team-scoped rating (no fixture to score) rather than inventing one', () => {
    const record = contractRecord({ teamB: 'Pittsburgh' });
    const result = build({ records: [record], outcomes: [PITT_OUTCOME] });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => entry.reason),
      ['team_scoped_record']
    );
  });

  it('drops a record whose sides do not resolve, and says which failure it was', () => {
    const record = contractRecord({ teamA: 'Nowhere State', teamB: 'Nowhere Tech' });
    const result = build({ records: [record], outcomes: [PITT_OUTCOME] });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => [entry.reason, entry.count]),
      [['identity_unresolved', 1]]
    );
  });

  it('keeps an outcome-less record as the evaluator’s unmatched bucket, never a loss', () => {
    const result = build({
      records: [
        contractRecord(),
        contractRecord({ teamA: 'Georgia Tech', teamB: 'Colorado', modelWinProbability: 0.6 })
      ]
    });

    assert.equal(result.counts.rows, 2);
    assert.equal(result.counts.joined, 0);
    assert.equal(result.counts.unmatched, 2);
    assert.deepEqual(result.skipped, []);
    assert.ok(result.rows.every((row) => row.matched === false && row.outcome === null));

    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(scored.sources.sagarin.coverage.unmatched, 2);
    assert.equal(scored.sources.sagarin.coverage.sampleSize, 0);
    assert.deepEqual(scored.sources.sagarin.scores, {});
  });

  it('drops an outcome naming a side that is not in the fixture', () => {
    const result = build({
      records: [contractRecord()],
      outcomes: [{ league: 'NCAAF', game: 'Pittsburgh vs Syracuse', winner: 'Ohio State' }]
    });

    assert.equal(result.counts.rows, 0);
    assert.deepEqual(
      result.skipped.map((entry) => entry.reason),
      ['winner_not_in_matchup']
    );
  });

  it('scores a draw as a loss for a win-probability source', () => {
    const result = build({
      records: [contractRecord()],
      outcomes: [{ league: 'NCAAF', game: 'Pittsburgh vs Syracuse', winner: 'draw' }]
    });

    assert.equal(result.rows[0].outcome, 'loss');
    assert.equal(result.rows[0].matched, true);
  });

  it('reports a malformed outcome or market input instead of dropping it silently', () => {
    const result = build({
      records: [contractRecord()],
      outcomes: [
        PITT_OUTCOME,
        { league: 'NCAAF', winner: 'Pittsburgh' }, // no game label
        { league: 'NCAAF', game: 'Nowhere A vs Nowhere B', winner: 'Nowhere A' } // unresolvable
      ],
      markets: [
        { league: 'NCAAF' }, // no game label
        { league: 'NCAAF', game: 'Nowhere A vs Nowhere B' }, // unresolvable
        { league: 'NCAAF', game: 'Pittsburgh vs Syracuse', marketFairProbability: 0.5 }
      ]
    });

    assert.equal(result.counts.rows, 1);
    assert.equal(result.counts.outcomes, 1);
    assert.equal(result.counts.markets, 1);
    assert.equal(result.counts.inputSkipped, 4);
    assert.deepEqual(
      result.skipped.map((entry) => [entry.source, entry.reason, entry.count]),
      [
        [null, 'market_identity_unresolved', 1],
        [null, 'market_without_game', 1],
        [null, 'outcome_identity_unresolved', 1],
        [null, 'outcome_without_game', 1]
      ]
    );
    // Every exclusion is counted exactly once, and the counts add up.
    assert.equal(
      result.counts.inputSkipped,
      result.skipped.reduce((sum, entry) => sum + entry.count, 0)
    );
    assert.equal(result.rows[0].marketFairProbability, 0.5);
  });

  it('withholds the market comparison when two closes claim one fixture, keeping the prediction evaluable', () => {
    // The record carries a market scope (tennis Elo does), so the specific key is
    // consulted and its collision is what withholds the price. The model
    // probability is still scored - only the comparison is refused.
    const record = { ...contractRecord(), market: 'Moneyline' };
    const result = build({
      records: [record],
      outcomes: [PITT_OUTCOME],
      markets: [
        { league: 'NCAAF', game: 'Pittsburgh vs Syracuse', market: 'Moneyline', marketFairProbability: 0.5 },
        { league: 'NCAAF', game: 'Syracuse vs Pittsburgh', market: 'Moneyline', marketFairProbability: 0.6 }
      ]
    });

    assert.equal(result.counts.rows, 1);
    assert.equal(result.counts.joined, 1);
    assert.equal(result.counts.markets, 0);
    assert.equal(result.rows[0].marketFairProbability, undefined);
    assert.equal(result.rows[0].market, 'Moneyline');
    assert.deepEqual(
      result.skipped.map((entry) => [entry.reason, entry.count]),
      [['ambiguous_market_for_fixture', 1]]
    );
    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(scored.sources.sagarin.coverage.sampleSize, 1);
  });

  it('distinguishes a source that never publishes a probability from a record that lost one', () => {
    // Same missing number, two different diagnoses: Massey is declined by
    // decision, while a Sagarin row with no `WIN%` is a record that should have
    // carried one and did not.
    const declined = build({
      records: [
        {
          ...contractRecord({
            source: 'massey',
            method: 'overall',
            teamA: 'Indiana',
            teamB: 'Indiana',
            modelWinProbability: null,
            modelWinProbabilityKind: null
          })
        }
      ]
    });
    assert.deepEqual(
      declined.skipped.map((entry) => [entry.source, entry.reason]),
      [['massey', 'probability_unavailable']]
    );

    const lost = build({
      records: [contractRecord({ modelWinProbability: null, modelWinProbabilityKind: null })],
      outcomes: [PITT_OUTCOME]
    });
    assert.deepEqual(
      lost.skipped.map((entry) => [entry.source, entry.reason]),
      [['sagarin', 'record_missing_probability']]
    );
    assert.notEqual(declined.skipped[0].reason, lost.skipped[0].reason);
  });

  it('leaves a row with no source date for the evaluator to reject as missing provenance', () => {
    const result = build({
      records: [contractRecord({ asOf: null })],
      outcomes: [PITT_OUTCOME]
    });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].matched, true);
    assert.equal(result.rows[0].predictionTimestamp, null);

    // No invented timestamp: the evaluator's own rule classifies it, and no
    // denominator picks it up.
    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(scored.sources.sagarin.coverage.unresolved, 1);
    assert.equal(scored.sources.sagarin.coverage.sampleSize, 0);
    assert.deepEqual(scored.sources.sagarin.scores, {});
  });

  it('returns an explicit empty result for no input at all', () => {
    const result = build();

    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.counts, {
      records: 0,
      rows: 0,
      joined: 0,
      unmatched: 0,
      recordsSkipped: 0,
      inputSkipped: 0,
      outcomes: 0,
      markets: 0
    });
    for (const source of SOURCES) {
      assert.equal(result.sources[source].records, 0);
      assert.equal(result.sources[source].rows, 0);
    }
    assert.equal(result.sources.massey.probability.available, false);
    assert.equal(result.sources.sagarin.probability.available, true);
  });

  it('accepts the same record input vocabulary the shadow overlay accepts', () => {
    const record = contractRecord();
    const asList = build({ records: [record], outcomes: [PITT_OUTCOME] });
    const asEnvelope = build({
      records: [{ source: 'sagarin', coverage: 'full', records: [record] }],
      outcomes: [PITT_OUTCOME]
    });
    const asMap = build({ records: { sagarin: [record] }, outcomes: [PITT_OUTCOME] });

    assert.equal(asList.counts.rows, 1);
    assert.deepEqual(asEnvelope.rows, asList.rows);
    assert.deepEqual(asMap.rows, asList.rows);
  });
});

// ---------------------------------------------------------------------------
// 5. The recency rule is the layer's, not a second one invented here.
// ---------------------------------------------------------------------------

describe('ratings evaluation bridge: the layer’s recency rule does the date work', () => {
  it('leaves a record outside the attach window unusable, through the evaluator', () => {
    // The source's asOf sits months behind the game, which is the off-season
    // snapshot case the overlay also withholds. The bridge passes the dates
    // through; the evaluator applies ATTACH_MAX_AGE_DAYS and refuses.
    const result = build({
      records: [contractRecord({ asOf: '2026-06-13' })],
      outcomes: [{ ...PITT_OUTCOME, gameTimestamp: '2026-10-25T16:00:00.000Z' }]
    });
    assert.equal(result.counts.joined, 1);

    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(scored.sources.sagarin.coverage.sampleSize, 0);
    assert.equal(scored.sources.sagarin.coverage.unresolved, 1);
    assert.deepEqual(scored.sources.sagarin.scores, {});
  });

  it('refuses a record whose asOf is AFTER the game it would predict', () => {
    const result = build({
      records: [contractRecord({ asOf: '2026-09-20' })],
      outcomes: [PITT_OUTCOME]
    });

    const scored = evaluateRatingSources(result.rows, { minSample: 1 });
    assert.equal(scored.sources.sagarin.coverage.sampleSize, 0);
    assert.equal(scored.sources.sagarin.coverage.unresolved, 1);
  });
});
