'use strict';

const { parseGameStartMs } = require('./ssb-shared-utils');
const {
  computeMovementDisposition,
  computeMovementSummary,
  isMovementEvidenceAged
} = require('./ssb-movement-disposition');
const { getLocalTimezone } = require('./mcp-runtime-config');
const { classifySharpBookOrigin } = require('./ssb-sharp-books');
const { selectProxyOdds } = require('./screen-parser');

/**
 * Map a sharp_plays / ranker row to the quick_screen candidate output shape.
 * Single source of truth for the candidate field set used by quick_screen.
 *
 * @param {Object} row - Ranker row from sharp_plays output
 * @returns {Object} Standardized candidate object
 */
function mapCandidateRow(row = {}) {
  // Recompute movementDisposition from the row's own fields rather than
  // trusting a pre-stamped value. sharp_plays sets sharpBookMovementConfirmed
  // AFTER the ranker stamped disposition, so copying it yields a stale
  // 'insufficient' on sharp-confirmed thin-history slates. computeMovementDisposition
  // reads sharpBookMovementConfirmed and upgrades to supportive_bouncy.
  const movementDisposition = computeMovementDisposition(row);

  // Compute a human-readable movement summary string
  const movementSummary = computeMovementSummary(row, {
    movementDisposition,
    selection: row.selection || row.participant || null,
    edge: row.consensusEdge
  });

  const staleMovementWarning =
    String(movementDisposition).startsWith('adverse') &&
    (row.confidenceTier === 'TIER 1' || row.confidenceTier === 'TIER 2') &&
    (Number(row.consensusBookCount) || 0) >= 10;

  const displayTier = row.kaiCall === 'BET' ? 'BET' : row.kaiCall === 'CONSIDER' ? 'CONSIDER' : 'PASS';

  return {
    playId: row.playId || null,
    selectionKey: row.selectionKey || null,
    gameId: row.gameId || null,
    game: row.game || `${row.awayTeam || '?'} @ ${row.homeTeam || '?'}`,
    selection: row.selection || row.participant || row.pick || null,
    start: row.start || null,
    startCST: (() => {
      const ts = parseGameStartMs(row.start);
      if (ts === null) return null;
      try {
        const tz = getLocalTimezone();
        const date = new Date(ts);
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        }).format(date);
        const tzName =
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'shortGeneric'
          })
            .formatToParts(date)
            .find((p) => p.type === 'timeZoneName')?.value || tz;
        return `${fmt} ${tzName}`;
      } catch {
        return null;
      }
    })(),
    startNote:
      String(row.league || '').toLowerCase() === 'tennis' ? 'Scheduled start — tennis matches may be delayed' : null,
    odds:
      row.odds ?? row.targetBookOdds ?? row.currentOdds ?? row.bestAvailableOdds ?? row.lineHistory?.[0]?.odds ?? null,
    // Preserve the actual execution book so bundled validation can re-query the
    // same venue even when the caller supplied only a broad/missing book list.
    book: row.book ?? null,
    // Retail proxy quote metadata (DraftKings preferred, FanDuel fallback) for
    // display only. NEVER an executable Courtside-sharp price, so it must not
    // feed validation or overwrite `odds`/`book` above. Null when neither proxy
    // book posted a parseable line in the row's allBookOdds map.
    proxyOdds: selectProxyOdds(row.allBookOdds),
    edge: row.consensusEdge ?? null,
    edgeSanityFlag: row.edgeSanityFlag ?? 'ok',
    clv: row.clvProxyPct ?? null,
    // Per-book dollar liquidity for the candidate's selected side, preserved
    // from the backend /screen payload (liquidity1/liquidity2 per book, see
    // extractScreenRows / expandScreenRow). Null when the backend didn't
    // provide depth for this book/side — never fabricated.
    liquidityUsd:
      row.liquidityUsd == null ? null : Number.isFinite(Number(row.liquidityUsd)) ? Number(row.liquidityUsd) : null,
    consensusBookCount: row.consensusBookCount ?? 0,
    executionQuality: row.executionQuality ?? 'unknown',
    movementGrade: row.movementGrade ?? 'unknown',
    movementLabel: row.movementLabel ?? null,
    sharpBookMovementConfirmed: row.sharpBookMovementConfirmed || false,
    sharpBookMovementSource: row.sharpBookMovementSource || null,
    sharpBookMovementOrigin:
      row.sharpBookMovementOrigin ||
      (row.sharpBookMovementSource ? classifySharpBookOrigin(row.sharpBookMovementSource) : null),
    // Steam provenance: a move confirmed by sharp ORIGINATORS (Pinnacle/Circa/
    // BookMaker/BetOnline) is the strongest signal; followers-only steam is weaker.
    // Surfaced so the agent/UI can filter on originator-confirmed steam.
    steamMove: row.steamMove || false,
    steamBookCount: Number(row.steamBookCount || 0),
    steamOriginatorCount: Number(row.steamOriginatorCount || 0),
    riskScore: row.riskScore ?? null,
    kaiCall: row.kaiCall ?? 'PASS',
    confidenceTier: row.confidenceTier ?? 'TIER 4',
    // The live (raw) tier is the current read; `confidenceTier` is the
    // hysteresis-smoothed tier, which in a multi-pass aggregate scan can be
    // stale by several levels. Dropping this field made the scan validate
    // against the smoothed tier, so real TIER 1 plays were echoed back as
    // TIER 4 and then clamped to TIER 2 (BET + TIER 4). Carry both.
    confidenceTierLive: row.confidenceTierLive ?? row.confidenceTier ?? null,
    rationale: row.rationale || null,
    screenScore: row.screenScore ?? 0,
    freshnessSource: row.freshnessSource ?? null,
    movementDisposition,
    movementHistoryUsable: row.movementHistoryUsable ?? row.priceHistoryUsable ?? row.lineHistoryUsable ?? false,
    priceHistoryUsable: row.priceHistoryUsable === true,
    priceHistoryScope: row.priceHistoryScope ?? null,
    priceHistorySource: row.priceHistorySource ?? null,
    priceHistoryPointCount: Number.isFinite(Number(row.priceHistoryPointCount))
      ? Number(row.priceHistoryPointCount)
      : 0,
    movementEvidenceAged: isMovementEvidenceAged(row),
    movementHistoryAgeMs: row.lastPointAgeMs ?? null,
    // Provenance used to make scan -> validation comparisons meaningful.
    lineHistoryLookbackHours: row.lineHistoryLookbackHours ?? null,
    recentWindowHours: row.recentWindowHours ?? row.movementSummary?.recentWindowHours ?? null,
    historySportsbooksRequested: Array.isArray(row.historySportsbooksRequested) ? row.historySportsbooksRequested : [],
    movementSourceBook: row.movementSourceBook ?? null,
    movementMode: row.movementMode ?? null,
    movementSummary,
    staleMovementWarning,
    displayTier,
    // Conflict metadata from the screen ranker (resolveGameConflicts /
    // resolveTotalsConflicts). Without these, applyFinalVerdict cannot honor
    // the screen-level demotion and a validated BET would resurrect the loser.
    ...(row.conflictFlag || row.conflictWith || row.totalsConflictWith
      ? {
          conflictFlag: row.conflictFlag || false,
          conflictWith: row.conflictWith || null,
          totalsConflictWith: row.totalsConflictWith || null
        }
      : {}),
    // Authoritative merged verdict from validateTop (screen + validation).
    // Defaults to the screen's own call so the field is ALWAYS present even
    // when validation didn't run — consumers can read one field instead of
    // reconciling displayTier against a possibly-absent finalVerdict.
    finalVerdict: row.finalVerdict || displayTier,
    finalConfidenceTier: row.finalConfidenceTier || row.confidenceTier || 'TIER 4',
    hoursUntilStart: (() => {
      const ts = parseGameStartMs(row.start);
      if (ts === null) return null;
      return Math.round(((ts - Date.now()) / 3600000) * 10) / 10;
    })(),
    // Deep-link into the website's /screen drill-down for this exact
    // market + game + participant, so the user can click from chat into
    // the same view our data came from.
    screenUrl:
      row.gameId && row.market && row.selection
        ? `https://app.propprofessor.com/screen?market=${encodeURIComponent(row.market)}` +
          `&game=${encodeURIComponent(row.gameId)}` +
          `&league=${encodeURIComponent(row.league || '')}` +
          `&participant=${encodeURIComponent(row.selection)}`
        : null
  };
}

module.exports = { mapCandidateRow };
