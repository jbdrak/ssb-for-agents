#!/usr/bin/env node
'use strict';

/**
 * Repair settlement rows that shadow a bet's own decided outcome.
 *
 * `settle-record` writes a `pending` row (reasonCode `no_event_match`) for any bet
 * it cannot match. Migrated bets carry their real result ON the bet with an
 * unresolvable start (`eventDate: 'unknown'`), so those rows can never become a
 * real settlement — they are pure bookkeeping that made a decided 13W/12L record
 * read as 0W/0L until the read path was fixed.
 *
 * The read fix makes such rows INERT, so running this is optional tidiness rather
 * than a correctness requirement. It is therefore DRY-RUN BY DEFAULT: nothing is
 * written unless `--apply` is passed, and `--apply` takes a timestamped backup of
 * the ledger first.
 *
 * Usage:
 *   node scripts/repair-shadow-settlements.js            # dry run (default)
 *   node scripts/repair-shadow-settlements.js --apply     # write, with a backup
 *   node scripts/repair-shadow-settlements.js --json      # machine-readable
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadLedger, saveLedger, defaultLedgerPath } = require('../lib/record-ledger');

const SHADOWING_STATUS = 'pending';
const SHADOWING_REASON = 'no_event_match';
const DECIDED = ['win', 'loss', 'push'];

/**
 * A settlement row is shadowing when it is pending AND unmatched AND its bet
 * already carries a decided outcome of its own. Every condition is required:
 * a pending row for an UNDECIDED bet is legitimate bookkeeping and is kept.
 *
 * @param {Object} settlement
 * @param {Map<string, Object>} betById
 * @returns {boolean}
 */
function isShadowing(settlement, betById) {
  if (!settlement || settlement.status !== SHADOWING_STATUS) return false;
  if (settlement.reasonCode !== SHADOWING_REASON) return false;
  const bet = betById.get(settlement.betId);
  if (!bet) return false;
  return DECIDED.includes(String(bet.status || '').toLowerCase());
}

/**
 * Split a ledger's settlement rows into those to remove and those to keep.
 *
 * @param {Object} ledger
 * @returns {{ shadowing: Array<Object>, kept: Array<Object> }}
 */
function findShadowingSettlements(ledger) {
  const settlements = Array.isArray(ledger && ledger.settlements) ? ledger.settlements : [];
  const bets = Array.isArray(ledger && ledger.bets) ? ledger.bets : [];
  const betById = new Map();
  for (const bet of bets) if (bet && bet.id != null) betById.set(bet.id, bet);
  const shadowing = [];
  const kept = [];
  for (const settlement of settlements) {
    if (isShadowing(settlement, betById)) shadowing.push(settlement);
    else kept.push(settlement);
  }
  return { shadowing, kept };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    apply: args.includes('--apply'),
    json: args.includes('--json'),
    ledger: valueAfter(args, '--ledger')
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function main() {
  const flags = parseArgs(process.argv);
  const ledgerPath = flags.ledger || defaultLedgerPath();
  const loaded = loadLedger({ path: ledgerPath });
  if (!loaded.ok) {
    console.error(`repair-shadow-settlements: could not read ${ledgerPath}: ${loaded.error}`);
    process.exit(1);
  }

  const ledger = loaded.ledger;
  const { shadowing, kept } = findShadowingSettlements(ledger);
  const report = {
    ledgerPath,
    apply: flags.apply,
    shadowing: shadowing.length,
    kept: kept.length,
    removedBetIds: shadowing.map((s) => s.betId)
  };

  if (!flags.apply) {
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`repair-shadow-settlements (DRY RUN) — ${ledgerPath}`);
      console.log(`  settlement rows: ${shadowing.length + kept.length}`);
      console.log(`  would remove:    ${shadowing.length} (pending + no_event_match over an already-decided bet)`);
      console.log(`  would keep:      ${kept.length}`);
      console.log('  pass --apply to write (a timestamped backup is taken first)');
    }
    return;
  }

  if (!shadowing.length) {
    console.log('repair-shadow-settlements: nothing to remove; ledger unchanged');
    return;
  }

  const backupPath = `${ledgerPath}.bak-${stamp()}`;
  fs.copyFileSync(ledgerPath, backupPath);

  ledger.settlements = kept;
  const saved = saveLedger(ledger, { path: ledgerPath });
  if (!saved.ok) {
    console.error(`repair-shadow-settlements: write failed, original intact at ${backupPath}: ${saved.error}`);
    process.exit(1);
  }

  if (flags.json) console.log(JSON.stringify({ ...report, backupPath }, null, 2));
  else {
    console.log(`repair-shadow-settlements — removed ${shadowing.length} shadowing row(s)`);
    console.log(`  kept:   ${kept.length}`);
    console.log(`  backup: ${backupPath}`);
  }
}

if (require.main === module) main();

module.exports = { findShadowingSettlements, isShadowing, parseArgs, main };
