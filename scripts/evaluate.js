#!/usr/bin/env node
'use strict';

/**
 * Evaluate the tracker ledger against settled bets and captured closes.
 *
 *   node scripts/evaluate.js                  # human report
 *   node scripts/evaluate.js --json           # full document
 *   node scripts/evaluate.js --min-sample 10  # override the trust floor
 *
 * Two questions, kept strictly apart:
 *
 *   1. **Did we win?** Hit rate with a 95% Wilson interval, stake-weighted ROI,
 *      split by tier / market / league / price bucket. Every bucket carries its
 *      sample size, and a bucket under `--min-sample` (default 30) is flagged
 *      `insufficientSample` rather than presented as a result.
 *   2. **Did we beat the close?** The leading indicator, measured over recorded
 *      CANDIDATES rather than only bets, so it uses the whole scan. It needs far
 *      fewer observations than win rate before it means anything.
 *
 * Read-only: no network, no ledger writes. An empty ledger reports "insufficient
 * sample" for everything, which is the honest answer — not a blank page and not
 * a fabricated zero.
 */

const { loadLedger, defaultLedgerPath } = require('../lib/record-ledger');
const { evaluateLedger } = require('../lib/record-metrics');

function pct(value) {
  if (value == null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function line(label, stats) {
  if (!stats) return `  ${label.padEnd(22)} (no rows)`;
  const parts = [
    `n=${String(stats.sample).padStart(3)}`,
    `${stats.wins}W/${stats.losses}L/${stats.pushes}P`,
    `hit ${stats.hitRate == null ? 'n/a' : (stats.hitRate * 100).toFixed(1) + '%'}`,
    `ROI ${pct(stats.roiPct)}`,
    `CLV ${stats.meanClvPct == null ? 'unmeasured' : pct(stats.meanClvPct)}`
  ];
  const flag = stats.insufficientSample ? '  [insufficient sample]' : '';
  return `  ${label.padEnd(22)} ${parts.join('  ')}${flag}`;
}

function section(title, groups) {
  const out = [title];
  const keys = Object.keys(groups || {});
  if (!keys.length) out.push('  (no rows)');
  for (const key of keys.sort()) out.push(line(key, groups[key]));
  return out.join('\n');
}

function formatReport(document, ledgerPath) {
  const out = [`ledger: ${ledgerPath}`, `trust floor: ${document.minSample} decided outcomes`];

  const overall = document.overall;
  out.push('');
  out.push(
    `Overall: ${overall.sample} settled bet(s) — ${overall.wins}W / ${overall.losses}L / ${overall.pushes}P` +
      (overall.hitRate == null ? '' : `, hit ${(overall.hitRate * 100).toFixed(1)}%`) +
      (overall.hitRateCi
        ? ` (95% CI ${(overall.hitRateCi.low * 100).toFixed(1)}-${(overall.hitRateCi.high * 100).toFixed(1)}%)`
        : '')
  );
  out.push(
    `P&L: ${overall.pnlUnits == null ? 'n/a' : overall.pnlUnits.toFixed(2) + 'u'} on ${overall.stakedUnits.toFixed(2)}u staked, ROI ${pct(overall.roiPct)}` +
      (overall.unpricedRows ? ` — ${overall.unpricedRows} row(s) excluded: price not a price` : '')
  );
  if (overall.insufficientSample) out.push('  [insufficient sample: do not read the hit rate above as a result]');

  out.push('');
  out.push(section('By tier:', document.byTier));
  out.push('');
  out.push(section('By market:', document.byMarket));
  out.push('');
  out.push(section('By price bucket:', document.byOddsBucket));
  out.push('');
  out.push(section('By league:', document.byLeague));

  const btc = document.beatTheClose;
  out.push('');
  out.push('Beat the close (recorded candidates, not just bets):');
  out.push(
    `  candidates ${btc.candidates} | with a captured close ${btc.sample} | no close ${btc.withoutClose}` +
      (btc.withCloseNoPrice ? ` | close but no price ${btc.withCloseNoPrice}` : '')
  );
  if (btc.neverClosable) {
    out.push(
      `    of the no-close rows: ${btc.notYetClosed} still closable, ` +
        `${btc.neverClosable} NEVER closable (no resolvable fixture — recorded before playId was stored)`
    );
  }
  if (btc.sample === 0) {
    out.push('  no closes captured yet — run: npm run capture:close -- --live');
  } else {
    out.push(
      `  beat the close ${btc.beat}/${btc.sample} (${((btc.rate || 0) * 100).toFixed(1)}%)` +
        (btc.rateCi ? ` 95% CI ${(btc.rateCi.low * 100).toFixed(1)}-${(btc.rateCi.high * 100).toFixed(1)}%` : '') +
        ` | mean CLV ${pct(btc.meanClvPct)}` +
        (btc.insufficientSample ? '  [insufficient sample]' : '')
    );
    for (const key of Object.keys(btc.byTier).sort()) {
      const group = btc.byTier[key];
      out.push(
        `    ${key.padEnd(20)} ${group.beat}/${group.sample} beat (${((group.rate || 0) * 100).toFixed(1)}%) mean CLV ${pct(group.meanClvPct)}`
      );
    }
  }
  return out.join('\n');
}

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

function main() {
  const flags = parseArgs(process.argv);
  const ledgerPath =
    typeof flags.ledger === 'string' ? flags.ledger : process.env.PP_RECORD_LEDGER || defaultLedgerPath();
  const loaded = loadLedger({ path: ledgerPath });
  if (!loaded.ok) {
    console.error(`evaluate: ${loaded.error}`);
    process.exit(1);
  }
  const minSample = flags['min-sample'] != null ? Number(flags['min-sample']) : undefined;
  const document = evaluateLedger(loaded.ledger, {
    minSample: Number.isInteger(minSample) && minSample > 0 ? minSample : undefined
  });

  if (flags.json) console.log(JSON.stringify({ ledgerPath, ...document }, null, 2));
  else console.log(formatReport(document, ledgerPath));
  return document;
}

if (require.main === module) {
  main();
}

module.exports = { formatReport, main };
