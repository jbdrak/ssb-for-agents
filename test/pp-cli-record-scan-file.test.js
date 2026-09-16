'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');

// `pp record-scan <file>` records a scan that was captured to disk.
// The inline --record-scan flag can only fire while the scan is in flight, so
// a background scan, an earlier scan, or a saved --json payload could never
// reach the ledger. That left the ledger with zero candidates, which is why
// its "By tier" / "By movement" breakdowns read "unknown".

function scanPayload() {
  return {
    results: [
      {
        league: 'NCAAF',
        market: 'Point Spread',
        plays: [
          {
            gameId: 'g1',
            game: 'Hawaii @ New Mexico State',
            selection: 'Hawaii -9.5',
            odds: 110,
            tier: 'TIER 2',
            verdict: 'CONSIDER'
          }
        ]
      }
    ]
  };
}

function withTempLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-record-scan-file-'));
  const previous = process.env.PP_RECORD_LEDGER;
  process.env.PP_RECORD_LEDGER = path.join(dir, 'ledger.json');
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RECORD_LEDGER;
    else process.env.PP_RECORD_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
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

describe('pp-cli record-scan (captured file)', () => {
  it('records the scan and its candidates from a saved scan JSON', async (t) => {
    const dir = withTempLedger(t);
    const file = path.join(dir, 'scan.json');
    fs.writeFileSync(file, JSON.stringify(scanPayload(), null, 2));

    const capture = captureConsole();
    let result;
    try {
      result = await cli.cmdRecordScan(['record-scan', file], {});
    } finally {
      capture.restore();
    }

    assert.equal(result.ok, true);
    assert.ok(result.scanId, 'scan id is returned');
    assert.equal(result.candidates, 1);
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 0);

    const ledger = JSON.parse(fs.readFileSync(process.env.PP_RECORD_LEDGER, 'utf8'));
    assert.equal((ledger.candidates || []).length, 1);
    assert.equal((ledger.scans || []).length, 1);
  });

  it('is idempotent — re-recording the same file adds nothing', async (t) => {
    const dir = withTempLedger(t);
    const file = path.join(dir, 'scan.json');
    fs.writeFileSync(file, JSON.stringify(scanPayload()));

    const first = captureConsole();
    try {
      await cli.cmdRecordScan(['record-scan', file], {});
    } finally {
      first.restore();
    }

    const second = captureConsole();
    let result;
    try {
      result = await cli.cmdRecordScan(['record-scan', file], {});
    } finally {
      second.restore();
    }

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.added, 0);
    assert.equal(result.duplicates, 1);
    const ledger = JSON.parse(fs.readFileSync(process.env.PP_RECORD_LEDGER, 'utf8'));
    assert.equal((ledger.candidates || []).length, 1);
  });

  it('accepts a bare results array and honours --book', async (t) => {
    const dir = withTempLedger(t);
    const file = path.join(dir, 'scan.json');
    fs.writeFileSync(file, JSON.stringify(scanPayload().results));

    const capture = captureConsole();
    let result;
    try {
      result = await cli.cmdRecordScan(['record-scan', file], { book: 'Fliff' });
    } finally {
      capture.restore();
    }

    assert.equal(result.ok, true);
    const ledger = JSON.parse(fs.readFileSync(process.env.PP_RECORD_LEDGER, 'utf8'));
    assert.equal(ledger.scans[0].book, 'Fliff');
  });

  it('rejects a missing file, malformed JSON, and an empty scan', async (t) => {
    const dir = withTempLedger(t);

    await assert.rejects(
      () => cli.cmdRecordScan(['record-scan', path.join(dir, 'nope.json')], {}),
      /cannot read scan JSON/
    );

    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    await assert.rejects(() => cli.cmdRecordScan(['record-scan', bad], {}), /cannot read scan JSON/);

    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ results: [] }));
    await assert.rejects(() => cli.cmdRecordScan(['record-scan', empty], {}), /no results\[\] blocks/);

    await assert.rejects(() => cli.cmdRecordScan(['record-scan'], {}), /no scan file/);
  });

  it('prints machine-readable output only when asked', async (t) => {
    const dir = withTempLedger(t);
    const file = path.join(dir, 'scan.json');
    fs.writeFileSync(file, JSON.stringify(scanPayload()));

    const quiet = captureConsole();
    try {
      await cli.cmdRecordScan(['record-scan', file], {});
    } finally {
      quiet.restore();
    }
    assert.equal(quiet.logs.length, 0, 'no stdout chatter without -j');

    const loud = captureConsole();
    try {
      await cli.cmdRecordScan(['record-scan', file], { j: true });
    } finally {
      loud.restore();
    }
    assert.equal(loud.logs.length, 1);
    assert.equal(JSON.parse(loud.logs[0]).ok, true);
  });
});
