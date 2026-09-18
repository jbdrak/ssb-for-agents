#!/usr/bin/env node
'use strict';

/**
 * Local-only record review and P&L (Task 6).
 *
 * Reads the tracker ledger (PP_RECORD_LEDGER, default
 * ~/.ssb-for-agents/tracker/ledger.json) and reports a strict
 * America/Chicago date-filtered review of official bets, raw candidates,
 * and settlements. Pure local review: no network code, no SSB
 * calls, and the ledger is NEVER written by this script.
 *
 * Official bets are ledger.bets only. Candidates whose status is LEAN,
 * PASS, unreviewed, or invalid never enter the official W-L-P-V record or
 * the official ROI; raw candidate counts are reported separately.
 *
 * Modes (default `review`):
 *   review  — stats plus one line per official bet in scope (default)
 *   stats   — overall W-L-P-V record, American-odds P&L with stake-weighted
 *             ROI, splits by league/market/tier/movement/decisionSource,
 *             candidate counts, unresolved/delayed/retirement counts, and
 *             settlement source URLs.
 *   pending — unresolved/delayed/retirement bets with settlement evidence.
 *
 * P&L precedence for a settled bet (win/loss/push/void): the linked
 * settlement's pnlUnits, then the bet's own recorded plUnits (migrated
 * legacy P&L), then a local American-odds computation from
 * oddsAtDecision/odds and status. Push/void/pending/retirement contribute 0
 * P&L; a legacy 'cashout' is treated as pending (never W/L/P/V) rather than
 * guessed into a settled bucket.
 *
 * Usage:
 *   node scripts/review-record.js [review|stats|pending] [--stats|--pending]
 *                                 [--date YYYY-MM-DD] [--json]
 *
 * --date filters by the America/Chicago calendar day of the bet's scheduled
 * start (bet.start / bet.scheduledStart / bet.eventDate — migrated bets
 * carry eventDate — / candidateSnapshot.start). Bets without a usable
 * scheduled start are excluded from strict date views and counted in
 * `excludedUnknownDate` — never guessed onto a date.
 *
 * Exit codes: 0 success (including no-data), 2 usage errors, 1 ledger errors.
 */

const fs = require('node:fs');

const ledgerApi = require('../lib/record-ledger');
const settleCli = require('./settle-record');

const MODES = ['stats', 'review', 'pending'];
const SETTLED = ['win', 'loss', 'push', 'void'];

function parseArgs(argv) {
  const args = (Array.isArray(argv) ? argv : []).slice(2);
  const options = { mode: 'review', date: null, json: false };
  const positional = [];
  const setMode = (candidate, label) => {
    if (options.mode !== 'review' && options.mode !== candidate) {
      return { ...options, parseError: `conflicting modes: '${options.mode}' vs ${label}` };
    }
    options.mode = candidate;
    return options;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--stats' || arg === '--pending') {
      const conflicted = setMode(arg.slice(2), arg);
      if (conflicted.parseError) return conflicted;
    } else if (arg === '--date') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return { ...options, parseError: 'missing value for --date' };
      options.date = value;
      i += 1;
    } else if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else if (arg.startsWith('--')) {
      return { ...options, parseError: `unknown argument: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    return { ...options, parseError: 'too many positional arguments (expected at most one mode)' };
  }
  if (positional.length === 1) {
    if (!MODES.includes(positional[0])) {
      return { ...options, parseError: `unknown mode '${positional[0]}' (expected ${MODES.join(', ')})` };
    }
    const conflicted = setMode(positional[0], `'${positional[0]}'`);
    if (conflicted.parseError) return conflicted;
  }
  return options;
}

/**
 * American-odds profit for a winning bet: stake * odds/100 for positive
 * prices, stake * 100/|odds| for negative prices. Returns null when the
 * price or stake is unusable (never guessed).
 */
function americanPnl(odds, stake) {
  const price = Number(odds);
  const units = Number(stake);
  if (!Number.isFinite(price) || !Number.isFinite(units) || price === 0 || units <= 0) return null;
  return price > 0 ? units * (price / 100) : units * (100 / -price);
}

/**
 * P&L in units for one bet given its resolved status. Precedence: the linked
 * settlement's pnlUnits, then the bet's own recorded plUnits (migrated
 * legacy P&L), then a local American-odds computation. Only settled
 * statuses (win/loss/push/void) carry P&L; push/void default to 0.
 */
function betPnlUnits(bet, status, settlement) {
  if (!SETTLED.includes(status)) return 0;
  const recorded =
    settlement && typeof settlement.pnlUnits === 'number' && Number.isFinite(settlement.pnlUnits)
      ? settlement.pnlUnits
      : typeof bet.plUnits === 'number' && Number.isFinite(bet.plUnits)
        ? bet.plUnits
        : null;
  if (recorded != null) return recorded;
  if (status === 'loss') return -(Number(bet.stake) || 0);
  if (status === 'win') {
    const odds = bet.oddsAtDecision != null ? bet.oddsAtDecision : bet.odds;
    const pnl = americanPnl(odds, bet.stake);
    return pnl == null ? 0 : pnl;
  }
  return 0;
}

/**
 * Resolve a bet's review status. A DECIDED linked settlement wins over the bet
 * row's own status. A non-decided settlement does NOT: `settle-record` writes a
 * `pending` row for every bet it cannot match, while `migrate-tracker` stores the
 * real outcome ON the bet. Letting `pending` win therefore erases a decided
 * legacy record and reports 0W/0L. Precedence is decided settlement, else the
 * bet's own status, else pending.
 */
function resolveStatus(bet, settlement) {
  if (settlement && settlement.status) {
    const s = String(settlement.status).toLowerCase();
    if (SETTLED.includes(s) || s === 'retirement') return s;
  }
  const b = String(bet.status || 'pending').toLowerCase();
  return SETTLED.includes(b) || b === 'retirement' || b === 'unresolved' ? b : 'pending';
}

/** A settlement whose actual start landed on a different Chicago day than scheduled. */
function isDelayed(settlement) {
  if (!settlement || !settlement.scheduledStart || !settlement.actualStart) return false;
  const scheduled = settleCli.chicagoDay(settlement.scheduledStart);
  const actual = settleCli.chicagoDay(settlement.actualStart);
  return Boolean(scheduled && actual && scheduled !== actual);
}

function settlementFor(ledger, bet) {
  const key = bet && (bet.id || bet.betId || bet.pickId);
  if (!key || !Array.isArray(ledger.settlements)) return null;
  return ledger.settlements.find((s) => s && (s.betId === key || s.id === key)) || null;
}

function snapshotOf(bet) {
  return bet && bet.candidateSnapshot && typeof bet.candidateSnapshot === 'object' ? bet.candidateSnapshot : null;
}

/**
 * Scheduled-start resolver for review, extending settle-record's betStart
 * with the migrated `eventDate` field (Task 7 migrated bets carry eventDate,
 * sometimes the literal 'unknown' when the legacy tracker had no date).
 * Returns null for missing or 'unknown' values so strict date views never
 * guess a date.
 */
function reviewBetStart(bet) {
  const base = settleCli.betStart(bet);
  if (base) return base;
  const eventDate = bet && bet.eventDate;
  if (typeof eventDate !== 'string' || eventDate.trim() === '' || eventDate.toLowerCase() === 'unknown') return null;
  return eventDate.trim();
}

/** Summarize resolved review rows into W-L-P-V, bucket, and P&L counts. */
function summarize(rows) {
  const counts = { wins: 0, losses: 0, pushes: 0, voids: 0, pending: 0, unresolved: 0, retirement: 0, delayed: 0 };
  const pendingReasons = {};
  let totalUnits = 0;
  let stakedUnits = 0;
  for (const row of rows) {
    if (row.status === 'win') counts.wins += 1;
    else if (row.status === 'loss') counts.losses += 1;
    else if (row.status === 'push') counts.pushes += 1;
    else if (row.status === 'void') counts.voids += 1;
    else if (row.status === 'unresolved') counts.unresolved += 1;
    else if (row.status === 'retirement') counts.retirement += 1;
    else {
      counts.pending += 1;
      const code = row.settlement && row.settlement.reasonCode;
      if (code) pendingReasons[code] = (pendingReasons[code] || 0) + 1;
    }
    if (row.delayed) counts.delayed += 1;
    if (SETTLED.includes(row.status)) {
      totalUnits += row.pnlUnits;
      stakedUnits += row.stake;
    }
  }
  return {
    total: rows.length,
    settled: counts.wins + counts.losses + counts.pushes + counts.voids,
    wins: counts.wins,
    losses: counts.losses,
    pushes: counts.pushes,
    voids: counts.voids,
    pending: counts.pending,
    unresolved: counts.unresolved,
    retirement: counts.retirement,
    delayed: counts.delayed,
    pendingReasons,
    pnl: {
      totalUnits,
      stakedUnits,
      roiPct: stakedUnits > 0 ? (totalUnits / stakedUnits) * 100 : null
    }
  };
}

function splitRows(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field] || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...summarize(group) }))
    .sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
}

function summarizeCandidates(candidates) {
  const statuses = { unreviewed: 0, lean: 0, pass: 0, promoted: 0, invalid: 0 };
  for (const c of candidates) {
    const s = String(c.status || 'unreviewed').toLowerCase();
    statuses[s] = (statuses[s] || 0) + 1;
  }
  return { total: candidates.length, ...statuses };
}

/** Settlement summary for the bets currently in scope (by linked bet id). */
function settlementSummary(ledger, rows) {
  const linked = new Map();
  for (const row of rows) {
    const key = row.bet && (row.bet.id || row.bet.betId);
    if (key && row.settlement) linked.set(key, row.settlement);
  }
  const sourceUrls = [...new Set([...linked.values()].map((s) => s.sourceUrl).filter(Boolean))];
  return { total: Array.isArray(ledger.settlements) ? ledger.settlements.length : 0, linked: linked.size, sourceUrls };
}

/**
 * Pure review builder: no I/O, no mutation. `ledger` is treated as
 * read-only. Returns the full review document (see module header).
 */
function buildReview(ledger, opts = {}) {
  const mode = opts.mode || 'review';
  const date = opts.date || null;
  const bets = Array.isArray(ledger.bets) ? ledger.bets.filter(Boolean) : [];
  const candidates = Array.isArray(ledger.candidates) ? ledger.candidates.filter(Boolean) : [];

  let scoped = bets;
  let excludedUnknownDate = 0;
  if (date) {
    scoped = [];
    for (const bet of bets) {
      const start = reviewBetStart(bet);
      const day = start ? settleCli.chicagoDay(start) : null;
      if (!day) {
        excludedUnknownDate += 1;
        continue;
      }
      if (day === date) scoped.push(bet);
    }
  }

  const rows = scoped.map((bet) => {
    const settlement = settlementFor(ledger, bet);
    const snapshot = snapshotOf(bet);
    return {
      bet,
      settlement,
      status: resolveStatus(bet, settlement),
      pnlUnits: betPnlUnits(bet, resolveStatus(bet, settlement), settlement),
      delayed: isDelayed(settlement),
      league: bet.league || (snapshot && snapshot.league) || 'unknown',
      market: bet.market || (snapshot && snapshot.market) || 'unknown',
      tier: bet.tier || (snapshot && snapshot.tier) || 'unknown',
      movement: bet.movement || (snapshot && snapshot.movement) || 'unknown',
      decisionSource: bet.decisionSource || 'unknown',
      start: reviewBetStart(bet),
      startCST: snapshot && snapshot.startCST ? snapshot.startCST : null,
      odds: bet.oddsAtDecision != null ? bet.oddsAtDecision : bet.odds,
      stake: Number(bet.stake) || 0
    };
  });

  const official = {
    ...summarize(rows),
    splits: {
      league: splitRows(rows, 'league'),
      market: splitRows(rows, 'market'),
      tier: splitRows(rows, 'tier'),
      movement: splitRows(rows, 'movement'),
      decisionSource: splitRows(rows, 'decisionSource')
    }
  };

  let detailRows = rows;
  if (mode === 'pending') detailRows = rows.filter((r) => !SETTLED.includes(r.status));
  const betsOut = detailRows.map((r) => ({
    id: r.bet.id || r.bet.betId || null,
    candidateId: r.bet.candidateId || null,
    game: r.bet.game || null,
    league: r.league,
    market: r.market,
    selection: r.bet.selection || null,
    odds: r.odds,
    stake: r.stake,
    status: r.status,
    delayed: r.delayed,
    start: r.start,
    startCST: r.startCST,
    tier: r.tier,
    movement: r.movement,
    decisionSource: r.decisionSource,
    pnlUnits: r.pnlUnits,
    settlement: r.settlement
      ? {
          status: r.settlement.status || null,
          sourceUrl: r.settlement.sourceUrl || null,
          actualStart: r.settlement.actualStart || null,
          scheduledStart: r.settlement.scheduledStart || null,
          reason: r.settlement.reason || null
        }
      : null
  }));

  return {
    ok: true,
    path: null,
    mode,
    date,
    generatedAt: null,
    official,
    candidates: summarizeCandidates(candidates),
    settlements: settlementSummary(ledger, rows),
    excludedUnknownDate,
    bets: mode === 'stats' ? [] : betsOut
  };
}

/**
 * Primary read-only API (Task 6 contract): build the review document for an
 * in-memory ledger without touching the filesystem. Alias of buildReview.
 */
function reviewLedger(ledger, options = {}) {
  return buildReview(ledger, options);
}

/** Load the ledger read-only and build the review. Never saves. */
function runReviewRecord(opts = {}) {
  const ledgerPath = opts.path || ledgerApi.defaultLedgerPath();
  const mode = opts.mode || 'review';
  const date = opts.date || null;
  const fail = (error, exitCode = 2) => ({ ok: false, error, exitCode, path: ledgerPath, mode, date });

  if (!MODES.includes(mode)) return fail(`unknown mode '${mode}' (expected ${MODES.join(', ')})`);
  if (date && !settleCli.isValidDate(date)) {
    return fail(`--date must be a real YYYY-MM-DD date (got '${date}')`);
  }

  const loaded = ledgerApi.loadLedger({ fs: opts.fs || fs, path: ledgerPath });
  if (!loaded.ok) return fail(loaded.error, 1);

  const review = buildReview(loaded.ledger, { mode, date });
  return {
    ...review,
    path: ledgerPath,
    generatedAt: typeof opts.now === 'function' ? opts.now() : new Date().toISOString()
  };
}

function fmtUnits(value) {
  const rounded = Math.round(value * 100) / 100;
  return (rounded > 0 ? '+' : '') + rounded.toFixed(2) + 'u';
}

function fmtPct(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  const rounded = Math.round(value * 10) / 10;
  return (rounded > 0 ? '+' : '') + rounded.toFixed(1) + '%';
}

function fmtCounts(o) {
  return `${o.wins}W / ${o.losses}L / ${o.pushes}P / ${o.voids}V`;
}

/** Human-readable review text (stdout payload for non-JSON mode). */
function formatHuman(result) {
  if (!result.ok) return '';
  const dateLabel = result.date ? ` — ${result.date} (America/Chicago)` : ' — all dates (America/Chicago)';
  const lines = [`record ${result.mode}${dateLabel}`];
  const o = result.official;

  if (o.total === 0) {
    lines.push('No official bets' + (result.date ? ` on ${result.date}` : '') + '.');
  } else {
    lines.push(`Official: ${o.total} bets — ${fmtCounts(o)}`);
    lines.push(
      `P&L: ${fmtUnits(o.pnl.totalUnits)} on ${o.pnl.stakedUnits.toFixed(2)}u staked — ROI ${fmtPct(o.pnl.roiPct)}`
    );
    lines.push(
      `Unresolved: ${o.pending} pending · ${o.unresolved} unresolved · ${o.retirement} retirement · ${o.delayed} delayed`
    );
    for (const [label, key] of [
      ['By league', 'league'],
      ['By market', 'market'],
      ['By tier', 'tier'],
      ['By movement', 'movement'],
      ['By decisionSource', 'decisionSource']
    ]) {
      const rows = o.splits[key];
      lines.push(`${label}:`);
      if (!rows.length) {
        lines.push('  (none)');
      } else {
        for (const r of rows) {
          lines.push(
            `  ${String(r.key).padEnd(22)} ${String(r.total).padStart(3)} bet(s)  ${fmtCounts(r).padEnd(14)} ` +
              `${fmtUnits(r.pnl.totalUnits).padStart(9)}  ROI ${fmtPct(r.pnl.roiPct)}`
          );
        }
      }
    }
  }

  const c = result.candidates;
  lines.push(
    `Candidates: ${c.total} total (${c.promoted} promoted, ${c.lean} lean, ${c.pass} pass, ` +
      `${c.unreviewed} unreviewed, ${c.invalid} invalid) — lean/pass never count toward the official record`
  );
  const s = result.settlements;
  lines.push(
    `Settlements: ${s.total} records, ${s.linked} linked to reviewed bets, ${s.sourceUrls.length} source URL(s)`
  );
  for (const url of s.sourceUrls) lines.push(`  ${url}`);

  if (result.mode === 'review' && result.bets.length) {
    lines.push('Bets:');
    for (const b of result.bets) {
      lines.push(
        `  ${String(b.status).padEnd(7)} ${String(b.selection || '?').padEnd(24)} ${String(b.league).padEnd(8)} ` +
          `${String(b.market).padEnd(12)} @${b.odds} ${b.stake}u ${fmtUnits(b.pnlUnits)}${b.delayed ? ' (delayed)' : ''}`
      );
    }
  }
  if (result.mode === 'pending' && result.bets.length) {
    lines.push('Pending / unresolved / retirement:');
    for (const b of result.bets) {
      lines.push(
        `  ${String(b.status).padEnd(12)} ${String(b.selection || '?').padEnd(24)} start ${b.start || 'unknown'}` +
          (b.settlement && b.settlement.sourceUrl ? `  ${b.settlement.sourceUrl}` : '')
      );
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.parseError) {
    console.error(`review-record: ${options.parseError}`);
    process.exitCode = 2;
    return { ok: false, error: options.parseError, exitCode: 2 };
  }
  const result = runReviewRecord(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (!result.ok) {
    console.error(`review-record: ${result.error}`);
  } else {
    console.log(formatHuman(result));
  }
  if (!result.ok) process.exitCode = result.exitCode || 1;
  return result;
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(`review-record failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MODES,
  SETTLED,
  parseArgs,
  americanPnl,
  reviewBetStart,
  betPnlUnits,
  resolveStatus,
  isDelayed,
  settlementFor,
  summarize,
  splitRows,
  summarizeCandidates,
  settlementSummary,
  reviewLedger,
  buildReview,
  runReviewRecord,
  formatHuman,
  fmtUnits,
  fmtPct,
  main
};
