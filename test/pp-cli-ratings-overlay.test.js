'use strict';

// External-ratings shadow overlay wiring (follow-up to Task 10 / card 10).
//
// The overlay (lib/ssb-ratings-overlay.js) was inert: `applyRatingsOverlay`
// had no production caller, so `play.ratings` was never populated on a real
// scan and the `ratings: value('ratings')` line in lib/record-candidates.js
// could never fire. These tests pin the opt-in wiring and prove BOTH
// directions:
//
//   - OFF (the default): a normal scan is byte-identical and pays nothing —
//     proven behaviourally by leaving a VALID snapshot on disk and asserting
//     no row gains `ratings` (i.e. the store was never read).
//   - ON: only `ratings` is added; every ranking/tier/verdict/edge/score
//     field is unchanged, and the ledger feature snapshot carries `ratings`
//     only for the ON run.
//
// Everything is hermetic: a stub quick_screen handler, a temp PP_RATINGS_DIR
// and a temp PP_RECORD_LEDGER, so nothing touches the user's home directory.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');
const { saveSnapshot } = require('../lib/ssb-ratings-snapshot');

const clone = (value) => JSON.parse(JSON.stringify(value));

const HASH = 'a'.repeat(64);
const FETCHED_AT = '2026-09-15T10:00:00.000Z';
const SOURCE_URL = 'http://sagarin.com/sports/cfsend.htm';

const RANKING_FIELDS = [
  'kaiCall',
  'displayTier',
  'confidenceTier',
  'finalVerdict',
  'consensusEdge',
  'screenScore',
  'riskScore'
];

// Two NCAAF games that SHARE the team "Ohio State" — the same shape the
// overlay test uses to prove the composite join key does not bleed one
// game's prediction onto another.
function scanResults() {
  return [
    {
      league: 'NCAAF',
      market: 'Moneyline',
      plays: [
        {
          gameId: 'g1',
          game: 'Michigan vs Ohio State',
          league: 'NCAAF',
          market: 'Moneyline',
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
          gameId: 'g2',
          game: 'Ohio State vs Penn State',
          league: 'NCAAF',
          market: 'Moneyline',
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
      ]
    }
  ];
}

function sagarinRecord(teamA, teamB, predictedMargin) {
  return {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-13',
    fetchedAt: FETCHED_AT,
    sourceUrl: SOURCE_URL,
    sourceHash: HASH,
    teamA,
    teamB,
    neutral: false,
    predictedScoreA: 31,
    predictedScoreB: 24,
    predictedTotal: 55,
    predictedMargin,
    coverage: 'full',
    matchStatus: 'unmatched'
  };
}

function sagarinSnapshot() {
  return {
    source: 'sagarin',
    league: 'NCAAF',
    season: 2026,
    method: 'overall',
    sourceUrl: SOURCE_URL,
    asOf: '2026-09-13',
    fetchedAt: FETCHED_AT,
    sourceHash: HASH,
    records: [sagarinRecord('Michigan', 'Ohio State', -7.5), sagarinRecord('Ohio State', 'Penn State', 3.5)]
  };
}

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

// Point PP_RATINGS_DIR / PP_RECORD_LEDGER at a throwaway dir. `withSnapshot`
// writes a REAL, valid snapshot through the production store so an OFF run
// that wrongly read the dir would visibly gain `ratings`.
function withTempEnv(t, { withSnapshot = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ratings-overlay-'));
  const ratingsDir = path.join(dir, 'ratings');
  const ledgerPath = path.join(dir, 'ledger.json');
  const previous = {
    PP_RATINGS_DIR: process.env.PP_RATINGS_DIR,
    PP_RECORD_LEDGER: process.env.PP_RECORD_LEDGER,
    SSB_RATINGS_OVERLAY: process.env.SSB_RATINGS_OVERLAY
  };
  process.env.PP_RATINGS_DIR = ratingsDir;
  process.env.PP_RECORD_LEDGER = ledgerPath;
  delete process.env.SSB_RATINGS_OVERLAY;

  if (withSnapshot) {
    const saved = saveSnapshot(sagarinSnapshot());
    assert.equal(saved.ok, true, 'fixture snapshot must save');
  }

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ratingsDir, ledgerPath };
}

function makeHandler(results) {
  let calls = 0;
  return {
    handler: {
      async quick_screen() {
        calls += 1;
        return { data: { results: clone(results) } };
      }
    },
    calls: () => calls
  };
}

async function runScan(results, flags) {
  const { handler, calls } = makeHandler(results);
  const capture = captureConsole();
  try {
    await cli.cmdScan(handler, ['scan', 'NCAAF'], { json: true, ...flags }, {});
  } finally {
    capture.restore();
  }
  return { calls: calls(), logs: capture.logs, errors: capture.errors, output: JSON.parse(capture.logs[0]) };
}

function stripRatings(results) {
  return results.map((block) => ({
    ...block,
    plays: block.plays.map((play) => {
      const copy = { ...play };
      delete copy.ratings;
      return copy;
    })
  }));
}

describe('ratingsOverlayEnabled', () => {
  it('is OFF by default: no flag and no env var', (t) => {
    const previous = process.env.SSB_RATINGS_OVERLAY;
    delete process.env.SSB_RATINGS_OVERLAY;
    t.after(() => {
      if (previous === undefined) delete process.env.SSB_RATINGS_OVERLAY;
      else process.env.SSB_RATINGS_OVERLAY = previous;
    });
    assert.equal(cli.ratingsOverlayEnabled({}), false);
  });

  it('turns on via --ratings-overlay or SSB_RATINGS_OVERLAY=true, and --no-ratings-overlay wins', (t) => {
    const previous = process.env.SSB_RATINGS_OVERLAY;
    t.after(() => {
      if (previous === undefined) delete process.env.SSB_RATINGS_OVERLAY;
      else process.env.SSB_RATINGS_OVERLAY = previous;
    });

    assert.equal(cli.ratingsOverlayEnabled({ 'ratings-overlay': true }), true);

    process.env.SSB_RATINGS_OVERLAY = 'true';
    assert.equal(cli.ratingsOverlayEnabled({}), true);
    assert.equal(cli.ratingsOverlayEnabled({ 'no-ratings-overlay': true }), false);

    // Only the exact string 'true' counts — no truthy loose matching.
    process.env.SSB_RATINGS_OVERLAY = '1';
    assert.equal(cli.ratingsOverlayEnabled({}), false);
  });
});

describe('pp scan --ratings-overlay wiring', () => {
  it('OFF is byte-identical across two runs and never reads the snapshot store', async (t) => {
    withTempEnv(t, { withSnapshot: true });

    const first = await runScan(scanResults(), {});
    const second = await runScan(scanResults(), {});

    // Two-run baseline: the overlay code path is present but disabled.
    assert.deepEqual(second.output, first.output, 'OFF runs are identical');
    assert.deepEqual(first.output, scanResults(), 'OFF output is the untouched scan payload');

    // A valid snapshot exists on disk. If the disabled path had read it, these
    // rows would carry `ratings`. They must not.
    for (const block of first.output) {
      for (const play of block.plays) {
        assert.equal(Object.prototype.hasOwnProperty.call(play, 'ratings'), false, 'OFF adds no ratings');
      }
    }
  });

  it('ON adds only `ratings`; every ranking/tier/verdict/edge/score field is unchanged', async (t) => {
    withTempEnv(t, { withSnapshot: true });

    const off = await runScan(scanResults(), {});
    const on = await runScan(scanResults(), { 'ratings-overlay': true });

    assert.equal(on.output.length, off.output.length);
    for (let i = 0; i < off.output.length; i++) {
      const offPlays = off.output[i].plays;
      const onPlays = on.output[i].plays;
      assert.equal(onPlays.length, offPlays.length);
      for (let j = 0; j < offPlays.length; j++) {
        for (const field of RANKING_FIELDS) {
          assert.equal(onPlays[j][field], offPlays[j][field], `${field} changed on play ${i}/${j}`);
        }
        assert.ok(onPlays[j].ratings, 'ON attaches a ratings object');
        assert.notEqual(onPlays[j].ratings.sagarin, null, 'matched sagarin record attaches');
      }
    }

    // Strongest form: strip `ratings` and the ON run is byte-identical to OFF.
    assert.deepEqual(stripRatings(on.output), off.output);
  });

  it('ON resolves the intended game and none other (composite join, no bleed)', async (t) => {
    withTempEnv(t, { withSnapshot: true });
    const { output } = await runScan(scanResults(), { 'ratings-overlay': true });
    const [g1, g2] = output[0].plays;

    assert.equal(g1.ratings.sagarin.game, g1.game);
    assert.equal(g1.ratings.sagarin.records[0].predictedMargin, -7.5);
    assert.equal(g2.ratings.sagarin.records[0].predictedMargin, 3.5);
  });

  it('fails closed with no snapshot store present: attaches nothing, never throws', async (t) => {
    // withSnapshot:false leaves PP_RATINGS_DIR pointing at a directory that was
    // never created — the ON path must degrade to a silent no-op.
    withTempEnv(t, { withSnapshot: false });
    const { output, logs } = await runScan(scanResults(), { 'ratings-overlay': true });

    assert.equal(logs.length, 1, 'scan still produced its JSON output');
    for (const block of output) {
      for (const play of block.plays) {
        assert.equal(play.ratings.sagarin, null);
      }
    }
  });

  it('renders the human (non-JSON) path with ratings attached without throwing', async (t) => {
    withTempEnv(t, { withSnapshot: true });
    const { handler } = makeHandler(scanResults());
    const capture = captureConsole();
    try {
      await cli.cmdScan(handler, ['scan', 'NCAAF'], { 'ratings-overlay': true }, {});
    } finally {
      capture.restore();
    }
    assert.ok(capture.logs.join('\n').length > 0, 'human renderer produced output');
    assert.ok(
      capture.logs.some((line) => line.includes('Michigan')),
      'the scanned play is rendered'
    );
  });
});

describe('ledger survival through the scan path', () => {
  it('records `ratings` in the candidate feature snapshot only on the ON run', async (t) => {
    const env = withTempEnv(t, { withSnapshot: true });

    // OFF run first — proves the whitelist line is dead without the overlay.
    await runScan(scanResults(), { 'record-scan': true });
    const offLedger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.ok(offLedger.candidates.length > 0, 'OFF run recorded candidates');
    for (const candidate of offLedger.candidates) {
      assert.equal(candidate.featureSnapshot.ratings, null, 'OFF: readings stays null');
    }

    // Fresh ledger + ON run — the whitelist line must now carry the payload.
    fs.rmSync(env.ledgerPath, { force: true });
    await runScan(scanResults(), { 'record-scan': true, 'ratings-overlay': true });
    const onLedger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.ok(onLedger.candidates.length > 0, 'ON run recorded candidates');

    const first = onLedger.candidates.find((c) => c.game === 'Michigan vs Ohio State');
    assert.ok(first, 'the Michigan vs Ohio State candidate is in the ledger');
    assert.ok(first.featureSnapshot.ratings, 'feature snapshot carries ratings');
    assert.equal(first.featureSnapshot.ratings.sagarin.records[0].predictedMargin, -7.5);
    assert.equal(first.featureSnapshot.ratings.sagarin.game, 'Michigan vs Ohio State');
  });
});

describe('applyScanRatingsOverlay direct contract', () => {
  it('is a no-op returning {applied:false} when disabled', async (t) => {
    withTempEnv(t, { withSnapshot: true });
    const res = { data: { results: clone(scanResults()) } };
    const result = await cli.applyScanRatingsOverlay(res, {});
    assert.deepEqual(result, { applied: false, records: 0 });
    assert.equal('ratings' in res.data.results[0].plays[0], false);
  });

  it('works on a bare { results } envelope as well as { data: { results } }', async (t) => {
    withTempEnv(t, { withSnapshot: true });
    const res = { results: clone(scanResults()) };
    const result = await cli.applyScanRatingsOverlay(res, { 'ratings-overlay': true });
    assert.equal(result.applied, true);
    assert.equal(result.records, 2);
    assert.equal(res.results[0].plays[0].ratings.sagarin.records[0].predictedMargin, -7.5);
  });
});
