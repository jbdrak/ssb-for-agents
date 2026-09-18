#!/usr/bin/env node
'use strict';

/**
 * Capture the CLOSING price for recorded scan candidates.
 *
 * Why this exists: the ledger records `odds` at DECISION time. Closing line
 * value is a comparison against the CLOSE, and nothing in this repo has ever
 * captured one — `bin/pp-cli.js` says so directly ("No producer writes these
 * yet"). Every card that printed "CLV +5.92%" was quoting an open-to-current
 * move, not a close-relative number. Without a close there is no way to tell a
 * decision price that beat the market from one that simply arrived after the
 * market had already moved.
 *
 * What it does, per run:
 *   1. Loads the ledger.
 *   2. Selects candidates due for a close (start within `--window` minutes, or
 *      within `--late` minutes of having started) via lib/record-close.
 *   3. Resolves a current quote per candidate through an injectable provider.
 *   4. Stamps the close onto the ledger row IN PLACE and saves once.
 *
 * Boundaries, deliberate:
 *   - It never invents a price. A quote that arrives as an implied-probability
 *     display string (`'49.0%'`, which is what a NoVig-family book returns on
 *     the structured `odds` field today) is stored as an implied probability,
 *     flagged `closeIsPrice: false`, and left as `closeOdds: null`.
 *   - It never recomputes a `candidateId`. That id is the decision-time
 *     identity `pp record-card` joins on; rehashing after adding a close would
 *     orphan every bet linked to the row.
 *   - Bounded single pass. No loop, no watcher, no background polling.
 *
 * Providers:
 *   - `--prices <file>`  JSON map/array of quotes, `[{ candidateId, odds,
 *     fairProbability?, book? }]`. Deterministic, no network. This is the path
 *     the tests exercise.
 *   - default (live)     `handlers.validate_play` per due candidate, which is
 *     the same call `pp validate` makes. Requires `--live` as an explicit
 *     acknowledgment, and the due set is small by construction.
 *
 * Usage:
 *   node scripts/capture-close.js --audit
 *   node scripts/capture-close.js --prices /tmp/closes.json
 *   node scripts/capture-close.js --live --window 30
 *   node scripts/capture-close.js --live --quiet     # silent unless it captured
 */

const { loadLedger, saveLedger, defaultLedgerPath } = require('../lib/record-ledger');
const { selectCloseTargets, applyClose, summarizeCloses } = require('../lib/record-close');
const { auditLedger } = require('../lib/record-quality');

/**
 * Read a supplied quote file.
 *
 * Accepts either `{ candidateId: quote }`, `{ prices: [...] }` or a bare array
 * of quotes. Mirrors the existing `--markets <file>` precedent rather than
 * inventing a second shape convention.
 *
 * @param {unknown} file
 * @returns {{ok: boolean, error?: string, quotes: Array<Object>}}
 */
function quotesFromFile(file) {
  const fs = require('node:fs');
  if (typeof file !== 'string' || file.trim() === '') return { ok: true, quotes: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, error: `unable to read prices file ${file}: ${error && error.message}`, quotes: [] };
  }
  const normalize = (candidateId, quote) => (quote && typeof quote === 'object' ? { candidateId, ...quote } : null);
  if (Array.isArray(parsed)) {
    return { ok: true, quotes: parsed.filter((q) => q && q.candidateId) };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.prices)) {
    return { ok: true, quotes: parsed.prices.filter((q) => q && q.candidateId) };
  }
  if (parsed && typeof parsed === 'object') {
    const quotes = Object.entries(parsed)
      .map(([id, quote]) => normalize(id, quote))
      .filter(Boolean);
    return { ok: true, quotes };
  }
  return {
    ok: false,
    error: `prices file ${file} must be an array, { prices: [...] }, or { candidateId: quote }`,
    quotes: []
  };
}

/**
 * Default LIVE provider: one `validate_play` call per due candidate.
 *
 * Sequential on purpose. The due set is small (candidates inside the capture
 * window), and the repo's standing rule is that live SSB traffic is bounded and
 * never fanned out in parallel.
 *
 * @param {Array<Object>} targets
 * @param {Object} ctx - { book }
 * @returns {Promise<Map<string, Object>>} candidateId -> quote
 */
async function defaultGetPrices(targets, ctx = {}) {
  const { createMcpHandlers } = require('./server/handlers');
  const { createSSBClient } = require('../lib/ssb-api');
  const { gameIdFromPlayId } = require('../lib/record-candidates');
  const handlers = createMcpHandlers({ client: createSSBClient() });
  const quotes = new Map();
  for (const target of targets) {
    const candidate = target.candidate;
    // `validate_play` REQUIRES a gameId ("gameId is required"), and a recorded
    // candidate resolves one from its playId because the scan row carries
    // playId and not gameId. Without this the whole live path silently resolved
    // nothing.
    const gameId = candidate.gameId || gameIdFromPlayId(candidate.playId);
    if (!gameId) {
      ctx.recordFailure?.(candidate.candidateId, 'no_game_id');
      continue;
    }
    try {
      const res = await handlers.validate_play({
        league: candidate.league,
        market: candidate.market,
        gameId,
        playId: candidate.playId || undefined,
        selection: candidate.selection,
        book: ctx.book || undefined
      });
      const data = (res && res.data) || res || {};
      if (res && res.ok === false) {
        // Surface the vendor's own reason rather than a generic failure.
        ctx.recordFailure?.(candidate.candidateId, (data.error && data.error.message) || 'validate_failed');
        continue;
      }
      const play = data.play || {};
      const odds = play.odds ?? play.currentOdds ?? null;
      if (odds == null) {
        ctx.recordFailure?.(candidate.candidateId, 'no_price_in_response');
        continue;
      }
      quotes.set(candidate.candidateId, {
        odds,
        fairProbability: play.marketFairProbability ?? null,
        book: play.book ?? ctx.book ?? null
      });
    } catch (error) {
      ctx.recordFailure?.(candidate.candidateId, error && error.message ? error.message : 'lookup_threw');
    }
  }
  return quotes;
}

/**
 * Run one bounded close-capture pass.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.getPrices] - async (targets, ctx) => Map<candidateId, quote>
 * @param {Function} [opts.quotes] - sync () => { ok, error?, quotes } supplied quotes
 * @param {boolean}  [opts.live] - required acknowledgement for the default live provider
 * @param {Function} [opts.now] - () => Date
 * @param {number}   [opts.windowMinutes]
 * @param {number}   [opts.lateMinutes]
 * @param {boolean}  [opts.force]
 * @param {boolean}  [opts.auditOnly]
 * @param {boolean}  [opts.dryRun]
 * @param {string}   [opts.ledgerPath]
 * @param {string}   [opts.book]
 * @param {Object}   [opts.fs] - injectable fs for tests
 * @returns {Promise<Object>}
 */
async function captureClose(opts = {}) {
  const fs = opts.fs || require('node:fs');
  const now = typeof opts.now === 'function' ? opts.now() : new Date();
  const nowMs = now.getTime();
  const ledgerPath = opts.ledgerPath || process.env.PP_RECORD_LEDGER || defaultLedgerPath();

  const ledgerOpts = { fs, path: ledgerPath };
  const loaded = loadLedger(ledgerOpts);
  if (!loaded.ok) return { ok: false, error: loaded.error, ledgerPath };
  const ledger = loaded.ledger;

  const audit = auditLedger(ledger);
  const before = summarizeCloses(ledger);

  if (opts.auditOnly) {
    return { ok: true, auditOnly: true, ledgerPath, audit, closes: before, wrote: false };
  }

  const selection = selectCloseTargets(ledger, {
    nowMs,
    windowMinutes: opts.windowMinutes,
    lateMinutes: opts.lateMinutes,
    force: opts.force
  });

  if (!selection.targets.length) {
    return {
      ok: true,
      ledgerPath,
      audit,
      closes: before,
      targets: 0,
      captured: 0,
      unresolved: 0,
      rejected: 0,
      excluded: selection.excluded,
      wrote: false
    };
  }

  // Resolve quotes. Either an injected provider, a supplied quote set, or the
  // live default (which needs an explicit --live acknowledgment). A provider
  // records WHY a lookup failed so an unresolved row is diagnosable rather than
  // just absent.
  const providerFailures = new Map();
  const providerCtx = {
    book: opts.book,
    recordFailure: (candidateId, reason) => providerFailures.set(candidateId, reason)
  };
  let quotes;
  if (typeof opts.getPrices === 'function') {
    quotes = await opts.getPrices(selection.targets, providerCtx);
  } else if (typeof opts.quotes === 'function') {
    const supplied = opts.quotes();
    if (!supplied.ok) return { ok: false, error: supplied.error, ledgerPath };
    quotes = new Map(supplied.quotes.map((quote) => [quote.candidateId, quote]));
  } else if (opts.live) {
    quotes = await defaultGetPrices(selection.targets, providerCtx);
  } else {
    throw new Error(
      'manual-only: no quote source supplied — pass --prices <file> or --live to acknowledge live SSB endpoints'
    );
  }

  const capturedAt = now.toISOString();
  let captured = 0;
  const unresolved = [];
  const rejected = [];
  for (const target of selection.targets) {
    const quote = quotes.get(target.candidate.candidateId);
    if (!quote) {
      unresolved.push({
        candidateId: target.candidate.candidateId,
        game: target.candidate.game,
        reason: providerFailures.get(target.candidate.candidateId) || 'no_quote'
      });
      continue;
    }
    const applied = applyClose(target, quote, { capturedAt });
    if (applied.ok) captured += 1;
    else
      rejected.push({ candidateId: target.candidate.candidateId, game: target.candidate.game, reason: applied.reason });
  }

  let wrote = false;
  if (!opts.dryRun && captured > 0) {
    const saved = saveLedger(ledger, ledgerOpts);
    if (!saved.ok) return { ok: false, error: saved.error, ledgerPath };
    wrote = true;
  }

  return {
    ok: true,
    ledgerPath,
    audit,
    closes: summarizeCloses(ledger),
    targets: selection.targets.length,
    captured,
    unresolved: unresolved.length,
    rejected: rejected.length,
    excluded: selection.excluded,
    unresolvedDetail: unresolved,
    rejectedDetail: rejected,
    dryRun: Boolean(opts.dryRun),
    wrote
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.split(/=(.+)/);
    const key = k.replace(/^--/, '');
    if (v !== undefined) {
      flags[key] = v;
      continue;
    }
    // Support `--key value` as well as `--key=value`. A flag whose next token
    // starts with `--` (or is absent) is a boolean, so `--audit --json` cannot
    // swallow `--json` as the value of `--audit`.
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function formatReport(result) {
  const lines = [];
  if (!result.ok) return `capture-close failed: ${result.error}`;
  const a = result.audit;
  lines.push(`ledger: ${result.ledgerPath}`);
  lines.push(
    `records: ${a.scans} scans, ${a.candidates} candidates, ${a.bets} bets, ${a.settlements} settlements (${a.settledBets} settled)`
  );
  lines.push(`prices: ${a.pricedCandidates}/${a.candidates} priced; formats ${JSON.stringify(a.priceFormats)}`);
  lines.push(
    `record gaps: ` +
      Object.entries(a.issues)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
  );
  lines.push(
    `closes: ${result.closes.captured} captured (${result.closes.asPrice} as price, ${result.closes.asImpliedProbability} as implied probability); ${result.closes.withClv} with close-relative CLV`
  );
  if (result.auditOnly) return lines.join('\n');
  lines.push(
    `due: ${result.targets} | captured ${result.captured} | unresolved ${result.unresolved} | rejected ${result.rejected}`
  );
  lines.push(`excluded: ${JSON.stringify(result.excluded)}`);
  if (result.dryRun) lines.push('dry run: ledger not written');
  return lines.join('\n');
}

async function main() {
  const flags = parseArgs(process.argv);
  const result = await captureClose({
    live: flags.live !== undefined,
    quotes: flags.prices ? () => quotesFromFile(flags.prices) : undefined,
    windowMinutes: flags.window ? Number(flags.window) : undefined,
    lateMinutes: flags.late ? Number(flags.late) : undefined,
    force: flags.force !== undefined,
    auditOnly: flags.audit !== undefined,
    dryRun: flags['dry-run'] !== undefined,
    book: typeof flags.book === 'string' ? flags.book : undefined,
    ledgerPath: typeof flags.ledger === 'string' ? flags.ledger : undefined
  });

  // Quiet mode: print nothing when there is nothing to report. An invocation that
  // announces "0 captured" every time is noise the reader learns to ignore, which
  // is how a real alert gets missed. Failures still speak.
  if (flags.quiet !== undefined && result.ok && !result.captured) {
    if (flags.json) console.log(JSON.stringify({ quiet: true, captured: 0, targets: result.targets || 0 }));
    return result;
  }

  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  if (!result.ok) process.exit(1);
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`capture-close failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { captureClose, quotesFromFile, defaultGetPrices, formatReport, parseArgs };
