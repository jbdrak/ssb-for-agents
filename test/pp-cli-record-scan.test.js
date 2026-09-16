'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');

// Task 3: --record-scan integration tests. These exercise cmdScan end-to-end
// with a stub quick_screen handler (no network) and a temp ledger + temp
// snapshot file, so nothing touches the user's home directory.

function makeResults() {
  return [
    {
      league: 'MLB',
      market: 'Moneyline',
      plays: [
        { gameId: 'g1', game: 'NYY @ BOS', selection: 'Yankees', odds: -120, tier: 'TIER 1', verdict: 'BET' },
        { gameId: 'g2', game: 'HOU @ TEX', selection: 'Astros', odds: +150, tier: 'TIER 2', verdict: 'CONSIDER' }
      ]
    }
  ];
}

function makeHandler(results) {
  let calls = 0;
  return {
    handler: {
      async quick_screen() {
        calls += 1;
        return { data: { results: JSON.parse(JSON.stringify(results)) } };
      }
    },
    calls: () => calls
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

function withTempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-record-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const snapshotPath = path.join(dir, 'snapshot.json');
  const ratingsDir = path.join(dir, 'ratings');
  const previousLedger = process.env.PP_RECORD_LEDGER;
  const previousSnapshot = process.env.PP_SCAN_SNAPSHOT_FILE;
  const previousRatingsDir = process.env.PP_RATINGS_DIR;
  const previousSsbRatingsDir = process.env.SSB_RATINGS_DIR;
  process.env.PP_RECORD_LEDGER = ledgerPath;
  process.env.PP_SCAN_SNAPSHOT_FILE = snapshotPath;
  // The external-ratings overlay is ON by default, so point its snapshot store
  // at the temp dir: this suite must never read the user's real ratings store.
  process.env.PP_RATINGS_DIR = ratingsDir;
  delete process.env.SSB_RATINGS_DIR;
  t.after(() => {
    if (previousLedger === undefined) delete process.env.PP_RECORD_LEDGER;
    else process.env.PP_RECORD_LEDGER = previousLedger;
    if (previousSnapshot === undefined) delete process.env.PP_SCAN_SNAPSHOT_FILE;
    else process.env.PP_SCAN_SNAPSHOT_FILE = previousSnapshot;
    if (previousRatingsDir === undefined) delete process.env.PP_RATINGS_DIR;
    else process.env.PP_RATINGS_DIR = previousRatingsDir;
    if (previousSsbRatingsDir === undefined) delete process.env.SSB_RATINGS_DIR;
    else process.env.SSB_RATINGS_DIR = previousSsbRatingsDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ledgerPath, snapshotPath };
}

async function runScan({ handlerResults, flags, positional = ['scan', 'MLB'] }) {
  const { handler, calls } = makeHandler(handlerResults);
  const capture = captureConsole();
  try {
    await cli.cmdScan(handler, positional, flags, {});
  } finally {
    capture.restore();
  }
  return { calls, logs: capture.logs, errors: capture.errors };
}

describe('pp-cli --record-scan', () => {
  it('warns and preserves scan health through the production-shaped bets response', async () => {
    const scanHealth = {
      incomplete: true,
      validationBudgetExhausted: true,
      truncated: true,
      validation: { requested: 10, selected: 0, completedCount: 0 }
    };
    const watchCandidate = {
      league: 'MLB',
      market: 'Moneyline',
      selection: 'Yankees',
      odds: -120,
      edge: 2.5,
      kaiCall: 'BET',
      finalVerdict: 'BET',
      validationBudgetExhausted: true,
      validationFailureReason: 'shared odds-history budget exhausted before validation',
      official: false
    };
    const handler = {
      async quick_screen() {
        const formatted = require('../lib/ssb-formatter').formatQuickScreenBets({
          ok: true,
          totalCandidates: 1,
          scanHealth,
          watchCandidates: [watchCandidate],
          results: [
            {
              league: 'MLB',
              market: 'Moneyline',
              candidates: []
            }
          ],
          activeSlate: [],
          emptySlate: [],
          warnings: []
        });
        return formatted;
      }
    };
    const capture = captureConsole();
    try {
      await cli.cmdScan(handler, ['scan', 'MLB'], { json: true }, {});
    } finally {
      capture.restore();
    }

    assert.equal(capture.logs.length, 1);
    const output = JSON.parse(capture.logs[0]);
    assert.equal(output.scanHealth.validationBudgetExhausted, true);
    assert.equal(output.scanHealth.incomplete, true);
    assert.match(capture.errors.join('\n'), /scan validation budget exhausted/);
    assert.match(capture.errors.join('\n'), /diagnostic only \(never official bets\)/);
  });

  it('does not touch the ledger when --record-scan is absent', async (t) => {
    const env = withTempEnv(t);
    const { calls, errors } = await runScan({ handlerResults: makeResults(), flags: {} });
    assert.equal(calls(), 1, 'quick_screen invoked exactly once (network path unchanged)');
    assert.equal(fs.existsSync(env.ledgerPath), false, 'no ledger file written');
    assert.equal(
      errors.some((e) => e.startsWith('record-scan:')),
      false,
      'no record-scan status on stderr'
    );
  });

  it('persists one scan record plus normalized candidates when --record-scan is set', async (t) => {
    const env = withTempEnv(t);
    const { errors } = await runScan({ handlerResults: makeResults(), flags: { 'record-scan': true } });
    assert.equal(fs.existsSync(env.ledgerPath), true);
    const ledger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.equal(ledger.version, 2);
    assert.equal(ledger.scans.length, 1);
    assert.equal(ledger.candidates.length, 2);
    const scan = ledger.scans[0];
    assert.equal(scan.command, 'scan');
    assert.equal(scan.source, 'pp-cli');
    assert.deepEqual(scan.leagues, ['MLB']);
    assert.equal(scan.book, 'NoVigApp');
    assert.equal(scan.playCount, 2);
    assert.ok(scan.id, 'scan record has a stable id');
    assert.ok(scan.createdAt, 'scan record has createdAt');
    for (const candidate of ledger.candidates) {
      assert.ok(candidate.candidateId, 'candidate carries candidateId');
      assert.ok(candidate.candidateId.length === 16, 'candidateId follows the 16-hex convention');
      assert.equal(candidate.league, 'MLB');
      assert.equal(candidate.market, 'Moneyline');
    }
    assert.ok(
      errors.some((e) => e.startsWith('record-scan:')),
      'recording status reported on stderr'
    );
    assert.ok(
      errors.every((e) => !e.includes('record-scan') || !e.includes('Error')),
      'no recording error reported'
    );
  });

  it('keeps stdout valid JSON when --json and --record-scan are combined', async (t) => {
    const env = withTempEnv(t);
    const results = makeResults();
    const { logs } = await runScan({
      handlerResults: results,
      // The overlay is ON by default; disable it here so this test still asserts
      // the untouched payload reaches stdout (the overlay is covered separately).
      flags: { 'record-scan': true, json: true, 'no-ratings-overlay': true }
    });
    assert.equal(logs.length, 1, 'exactly one stdout write (the JSON payload)');
    assert.deepEqual(JSON.parse(logs[0]), results, 'stdout parses back to the scan results');
    assert.equal(fs.existsSync(env.ledgerPath), true, 'recording still happened');
  });

  it('is idempotent: re-recording the same scan adds no duplicate entries', async (t) => {
    const env = withTempEnv(t);
    const results = makeResults();
    await runScan({ handlerResults: results, flags: { 'record-scan': true } });
    if (fs.existsSync(env.snapshotPath)) fs.rmSync(env.snapshotPath);
    const second = await runScan({ handlerResults: results, flags: { 'record-scan': true } });
    const ledger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.equal(ledger.scans.length, 1, 'scan recorded once');
    assert.equal(ledger.candidates.length, 2, 'candidates recorded once');
    assert.ok(
      second.errors.some((e) => e.includes('duplicate') || e.includes('unchanged')),
      'second run reports the duplicate on stderr'
    );
  });

  it('records a changed play set separately when filters and play count stay the same', async (t) => {
    const env = withTempEnv(t);
    const first = makeResults();
    const second = makeResults();
    second[0].plays[0] = { ...second[0].plays[0], selection: 'Red Sox' };
    await runScan({ handlerResults: first, flags: { 'record-scan': true } });
    await runScan({ handlerResults: second, flags: { 'record-scan': true } });
    const ledger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.equal(ledger.scans.length, 2, 'changed play identities do not collide');
    assert.notEqual(ledger.scans[0].scanFingerprint, ledger.scans[1].scanFingerprint);
  });
});
