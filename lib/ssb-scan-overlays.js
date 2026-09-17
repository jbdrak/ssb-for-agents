'use strict';

/**
 * Scan response overlays that add data to a finished `pp scan` response.
 *
 * Both are pure enrichment: they only attach fields to existing rows and can
 * never change a ranking, tier, verdict, edge, or score. Each one fails closed
 * (a failed read degrades to a no-op) so enrichment can never break scan output.
 *
 * Extracted from bin/pp-cli.js, which sits at the project's max-lines ceiling.
 */

const { enrichScanPolyWallets } = require('./ssb-poly-wallets');
const { listSnapshots, loadSnapshot } = require('./ssb-ratings-snapshot');
const { applyRatingsOverlay } = require('./ssb-ratings-overlay');
const { attachTennisElo } = require('./ssb-tennis-elo-overlay');

// ── Polymarket wallet overlay (opt-in, --wallets [N]) ────────────
/**
 * Attach live Polymarket wallet stances to scan rows.
 * @param {Object} res - scan response ({ data: { results } } or { results })
 * @param {Object} [flags]
 * @returns {Promise<void>}
 */
async function applyScanWalletOverlay(res, flags = {}) {
  if ((flags.wallets || flags['wallets']) && !(flags['no-wallets'] || flags.noWallets)) {
    try {
      const results = res.data?.results || res.results || [];
      const wantCount = flags.wallets === true ? undefined : Number(flags.wallets);
      await enrichScanPolyWallets(results, { limit: Number.isFinite(wantCount) && wantCount > 0 ? wantCount : 20 });
      const health = res.data?.scanHealth || res.scanHealth || null;
      if (health && (health.truncated || health.incomplete)) {
        console.error(
          'note: scan truncated — Polymarket wallet overlay may miss some matchups (run `pp wallets` for the wallet-first view).'
        );
      }
    } catch {
      // Enrichment must never break scan output.
    }
  }
}

// ── external-ratings shadow overlay (default ON) ─────────────────
// External-ratings benchmark records are a SHADOW label: they attach
// to final candidate rows as `row.ratings` for later evaluation and never feed
// the ranker, tiers, verdicts, or edge. ON by default so every scan carries the
// context; the store read is cheap and any failure degrades to a silent no-op.
// Disable with --no-ratings-overlay (or SSB_RATINGS_OVERLAY=false).

/**
 * True when the caller asked for the external-ratings shadow overlay.
 * @param {Object} [flags]
 * @returns {boolean}
 */
function ratingsOverlayEnabled(flags = {}) {
  if (flags['no-ratings-overlay'] || flags.noRatingsOverlay) return false;
  if (flags['ratings-overlay'] || flags.ratingsOverlay) return true;
  // Default ON. Only the exact string 'false' turns it off via the env, so a
  // set-but-typo'd value cannot silently change what a scan emits.
  return process.env.SSB_RATINGS_OVERLAY !== 'false';
}

/**
 * Read every record in the external-ratings snapshot store
 * (lib/ssb-ratings-snapshot.js). Fails closed per file: an unreadable,
 * invalid, or stale snapshot contributes nothing rather than throwing.
 *
 * This aggregate load deliberately supplies no point-in-time cutoff: it runs
 * once for the whole slate, not per row, so it has no event to compare against
 * and the store's `stale` flag stays inert here. Recency is enforced where the
 * event IS known - per row, at the join, in `applyRatingsOverlay`
 * (lib/ssb-ratings-overlay.js) against each row's own event start. Do not arm a
 * cutoff here instead: one slate-wide date cannot say whether a snapshot
 * describes any particular game.
 *
 * @returns {Array<Record<string, any>>}
 */
function loadRatingsRecords() {
  const listed = listSnapshots();
  if (!listed.ok) return [];
  const records = [];
  for (const summary of listed.snapshots) {
    if (!summary.valid) continue;
    const loaded = loadSnapshot(summary.source, summary.league, summary.season);
    if (!loaded.ok || loaded.stale || !loaded.snapshot) continue;
    for (const record of loaded.snapshot.records) records.push(record);
  }
  return records;
}

/**
 * Attach external-ratings benchmark records to the final scan rows in place.
 * Pure enrichment: it only ADDS `row.ratings` and can never change a ranking,
 * tier, verdict, edge, or score. Default ON - when disabled with
 * --no-ratings-overlay it returns before touching the snapshot store, so a
 * disabled scan pays nothing. A read failure degrades to a silent no-op;
 * enrichment must never break scan output.
 *
 * Tennis Elo is attached second and separately: it is a per-matchup lookup source
 * with no entry in the snapshot store, so `applyRatingsOverlay` can only ever
 * write `tennis_elo: null` for it (see lib/ssb-tennis-elo-overlay.js). The order
 * matters - the aggregate pass skips any row that already carries `row.ratings`,
 * so it has to run first.
 *
 * @param {Object} res - scan response ({ data: { results } } or { results })
 * @param {Object} [flags]
 * @returns {Promise<{applied: boolean, records: number}>}
 */
async function applyScanRatingsOverlay(res, flags = {}) {
  if (!ratingsOverlayEnabled(flags)) return { applied: false, records: 0 };
  try {
    const results = res?.data?.results || res?.results || [];
    const records = loadRatingsRecords();
    applyRatingsOverlay(results, { ratings: records });
    try {
      attachTennisElo(results);
    } catch {
      // The tennis half is best-effort: it must never empty the aggregate pass.
    }
    return { applied: true, records: records.length };
  } catch {
    return { applied: false, records: 0 };
  }
}

module.exports = {
  applyScanWalletOverlay,
  ratingsOverlayEnabled,
  loadRatingsRecords,
  applyScanRatingsOverlay
};
