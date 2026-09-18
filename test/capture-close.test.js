'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { captureClose, quotesFromFile, parseArgs } = require('../scripts/capture-close');

const NOW = new Date('2026-09-17T20:00:00.000Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();

function candidate(overrides = {}) {
  return {
    candidateId: 'c1',
    gameId: null,
    league: 'NCAAF',
    game: 'Purdue vs UCLA',
    market: 'Total Points',
    selection: 'Under 52.5',
    odds: '49.0%',
    start: at(10),
    featureSnapshot: {},
    ...overrides
  };
}

function writeLedger(candidates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-close-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({ version: 2, scans: [], candidates, bets: [], settlements: [] }, null, 2)
  );
  return ledgerPath;
}

const readLedger = (ledgerPath) => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

describe('capture-close: argument parsing', () => {
  it('accepts space-separated values, not only --key=value', () => {
    const flags = parseArgs(['node', 'script', '--ledger', '/tmp/l.json', '--window', '30', '--book', 'NoVigApp']);
    assert.equal(flags.ledger, '/tmp/l.json');
    assert.equal(flags.window, '30');
    assert.equal(flags.book, 'NoVigApp');
  });

  it('still accepts --key=value', () => {
    assert.equal(parseArgs(['node', 's', '--ledger=/tmp/l.json']).ledger, '/tmp/l.json');
  });

  it('treats a flag followed by another flag as boolean', () => {
    const flags = parseArgs(['node', 's', '--audit', '--json']);
    assert.equal(flags.audit, true);
    assert.equal(flags.json, true);
  });

  it('treats a trailing flag as boolean and ignores positionals', () => {
    const flags = parseArgs(['node', 's', 'extra', '--live']);
    assert.equal(flags.live, true);
    assert.equal(flags.extra, undefined);
  });
});

describe('capture-close: quotes file', () => {
  it('accepts an array, a { prices } wrapper, and a candidateId map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
    const asArray = path.join(dir, 'a.json');
    fs.writeFileSync(asArray, JSON.stringify([{ candidateId: 'c1', odds: -110 }]));
    assert.equal(quotesFromFile(asArray).quotes.length, 1);

    const wrapped = path.join(dir, 'b.json');
    fs.writeFileSync(wrapped, JSON.stringify({ prices: [{ candidateId: 'c1', odds: -110 }] }));
    assert.equal(quotesFromFile(wrapped).quotes.length, 1);

    const mapped = path.join(dir, 'c.json');
    fs.writeFileSync(mapped, JSON.stringify({ c1: { odds: -110 } }));
    assert.equal(quotesFromFile(mapped).quotes[0].candidateId, 'c1');
  });

  it('reports an unreadable or malformed file instead of throwing', () => {
    assert.equal(quotesFromFile('/nonexistent/quotes.json').ok, false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-bad-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    assert.equal(quotesFromFile(bad).ok, false);
    const scalar = path.join(dir, 'scalar.json');
    fs.writeFileSync(scalar, '42');
    assert.equal(quotesFromFile(scalar).ok, false);
  });

  it('returns an empty set for no file, without erroring', () => {
    assert.deepEqual(quotesFromFile(''), { ok: true, quotes: [] });
  });
});

describe('capture-close: pass behaviour', () => {
  it('requires a quote source and refuses the live path without acknowledgement', async () => {
    const ledgerPath = writeLedger([candidate()]);
    await assert.rejects(() => captureClose({ ledgerPath, now: () => NOW }), /manual-only/);
  });

  it('captures a due candidate and writes it to the ledger', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      getPrices: async (targets) =>
        new Map(targets.map((t) => [t.candidate.candidateId, { odds: -110, book: 'NoVigApp' }]))
    });
    assert.equal(result.ok, true);
    assert.equal(result.targets, 1);
    assert.equal(result.captured, 1);
    assert.equal(result.wrote, true);

    const row = readLedger(ledgerPath).candidates[0];
    assert.equal(row.closeOdds, -110);
    assert.equal(row.closeIsPrice, true);
    assert.equal(row.closeBook, 'NoVigApp');
    assert.equal(row.closeCapturedAt, NOW.toISOString());
    assert.equal(row.closeKind, 'pregame');
  });

  it('records a NoVig percent quote as an implied probability rather than a price', async () => {
    const ledgerPath = writeLedger([candidate()]);
    await captureClose({
      ledgerPath,
      now: () => NOW,
      getPrices: async (targets) => new Map(targets.map((t) => [t.candidate.candidateId, { odds: '51.2%' }]))
    });
    const row = readLedger(ledgerPath).candidates[0];
    assert.equal(row.closeOdds, null);
    assert.equal(row.closeImpliedProbability, 0.512);
    assert.equal(row.closeIsPrice, false);
  });

  it('is idempotent: a second pass finds nothing due', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const getPrices = async (targets) => new Map(targets.map((t) => [t.candidate.candidateId, { odds: -110 }]));
    await captureClose({ ledgerPath, now: () => NOW, getPrices });
    const second = await captureClose({ ledgerPath, now: () => NOW, getPrices });
    assert.equal(second.targets, 0);
    assert.equal(second.wrote, false);
    assert.equal(second.excluded.already_captured, 1);
    assert.equal(readLedger(ledgerPath).candidates.length, 1);
  });

  it('reports a target the provider could not price, and writes nothing for it', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({ ledgerPath, now: () => NOW, getPrices: async () => new Map() });
    assert.equal(result.captured, 0);
    assert.equal(result.unresolved, 1);
    assert.equal(result.unresolvedDetail[0].reason, 'no_quote');
    assert.equal(result.wrote, false);
    assert.equal(readLedger(ledgerPath).candidates[0].closeOdds, undefined);
  });

  it('carries the provider\u2019s own failure reason through to the report', async () => {
    // Without this an unresolved row is just absent, which is how a live
    // capture returned "unresolved 5" with no way to tell why.
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      getPrices: async (targets, ctx) => {
        for (const target of targets) ctx.recordFailure(target.candidate.candidateId, 'gameId is required');
        return new Map();
      }
    });
    assert.equal(result.unresolved, 1);
    assert.equal(result.unresolvedDetail[0].reason, 'gameId is required');
  });

  it('rejects an unparseable quote without inventing a close', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      getPrices: async (targets) => new Map(targets.map((t) => [t.candidate.candidateId, { odds: 'pending' }]))
    });
    assert.equal(result.captured, 0);
    assert.equal(result.rejected, 1);
    assert.equal(result.rejectedDetail[0].reason, 'close_not_a_price');
  });

  it('does not write on a dry run', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      dryRun: true,
      getPrices: async (targets) => new Map(targets.map((t) => [t.candidate.candidateId, { odds: -110 }]))
    });
    assert.equal(result.captured, 1);
    assert.equal(result.dryRun, true);
    assert.equal(result.wrote, false);
    assert.equal(readLedger(ledgerPath).candidates[0].closeOdds, undefined);
  });

  it('audits without capturing or writing', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({ ledgerPath, now: () => NOW, auditOnly: true });
    assert.equal(result.auditOnly, true);
    assert.equal(result.wrote, false);
    assert.equal(result.audit.candidates, 1);
    assert.equal(result.audit.priceFormats.implied_pct, 1);
    assert.equal(result.audit.issues.missing_game_id, 1);
  });

  it('surfaces a supplied quotes file through the `quotes` provider', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-use-'));
    const quotesPath = path.join(dir, 'q.json');
    fs.writeFileSync(quotesPath, JSON.stringify([{ candidateId: 'c1', odds: -108, book: 'NoVigApp' }]));
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      quotes: () => quotesFromFile(quotesPath)
    });
    assert.equal(result.captured, 1);
    assert.equal(readLedger(ledgerPath).candidates[0].closeOdds, -108);
  });

  it('surfaces a malformed quotes file as a clean error', async () => {
    const ledgerPath = writeLedger([candidate()]);
    const result = await captureClose({
      ledgerPath,
      now: () => NOW,
      quotes: () => ({ ok: false, error: 'nope', quotes: [] })
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'nope');
  });

  it('reports a missing ledger cleanly', async () => {
    const result = await captureClose({
      ledgerPath: '/nonexistent/dir/ledger.json',
      now: () => NOW,
      fs: {
        readFileSync: () => {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        },
        mkdirSync: () => {},
        writeFileSync: () => {}
      }
    });
    // loadLedger treats ENOENT as a fresh (empty) ledger, so this is a clean no-op run.
    assert.equal(result.ok, true);
    assert.equal(result.targets, 0);
  });
});

describe('capture-close: quiet mode for a frequent schedule', () => {
  const { execFileSync } = require('node:child_process');
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'capture-close.js');

  function runCli(extraArgs) {
    // A candidate starting in 5 hours: nothing is due, so the run short-circuits
    // before it needs any quote source. No network, no ledger writes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify(
        {
          version: 2,
          scans: [],
          candidates: [candidate({ start: new Date(Date.now() + 5 * 3600 * 1000).toISOString() })],
          bets: [],
          settlements: []
        },
        null,
        2
      )
    );
    try {
      return execFileSync('node', [SCRIPT, '--ledger', ledgerPath, ...extraArgs], { encoding: 'utf8' });
    } catch (error) {
      return String(error.stdout || '') + String(error.stderr || '');
    }
  }

  it('says nothing when it captured nothing', () => {
    assert.equal(runCli(['--quiet']).trim(), '');
  });

  it('still reports when quiet is not set', () => {
    assert.match(runCli([]), /closes: 0 captured/);
  });
});
