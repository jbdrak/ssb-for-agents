'use strict';

/**
 * Build metadata for a ranked-screen response.
 *
 * @param {object} options - Ranked-screen metadata inputs
 * @returns {object} Response metadata
 */
function buildResultMeta({
  targetBook,
  sharpBooks,
  lookbackHoursUsed,
  debug,
  freshness,
  warnings,
  compact,
  fields,
  args,
  ranked,
  compactFields,
  preHistoryShortlistMeta,
  unresolvedRows,
  preHistoryRecoveryMeta,
  preHydrationAltPruned,
  historyTimedOut,
  sourceRowCount
}) {
  const rankedRows = Array.isArray(ranked) ? ranked : [];
  const targetBookQuoteCount = rankedRows.filter(
    (row) => row?.targetBookOdds !== null && row?.targetBookOdds !== undefined
  ).length;
  const coverageGaps = ranked.coverageGaps || [];
  // Bounded-sample disclosure. The ranked row set is capped (per-pair scan
  // limit / pre-history row budget), so when the upstream feed returns more
  // source rows than we ranked, the surfaced candidate set is a SAMPLE of the
  // board, not the whole board. The upstream row count moves run to run, which
  // is why two identical `scan` invocations can return different plays. Report
  // the shortfall so a consumer can tell "no plays" from "capped sample" and
  // raise the cap deliberately (--scan-limit) instead of trusting one run.
  const sourceRowTotal = Number.isFinite(Number(sourceRowCount)) ? Number(sourceRowCount) : null;
  const unrankedRowCount =
    sourceRowTotal !== null && sourceRowTotal > rankedRows.length ? sourceRowTotal - rankedRows.length : 0;
  return {
    focusBook: targetBook || null,
    historySportsbooksRequested: sharpBooks,
    lookbackHoursUsed,
    debugEnabled: debug,
    freshnessFallbackUsed: freshness.freshnessFallbackUsed,
    timestampSources: freshness.timestampSources,
    degradedDataWarningCount: warnings.length,
    compact,
    fields: fields || (compact ? compactFields : null),
    markets_queried: args.markets ? args.markets : args.market ? [args.market] : ['Moneyline'],
    coverageGaps,
    focusBookMissingRowCount: ranked.focusBookMissingRows?.length || 0,
    targetBookCoverage: {
      targetBook: targetBook || null,
      sourceRowCount: sourceRowTotal,
      rankedRowCount: rankedRows.length,
      unrankedRowCount,
      boundedSample: unrankedRowCount > 0,
      targetBookQuoteCount,
      missingQuoteCount: coverageGaps.length
    },
    droppedAltLineCount: (ranked.droppedAltLineCount || 0) + (preHydrationAltPruned || 0),
    ...(preHydrationAltPruned ? { preHydrationAltPruned } : {}),
    ...(historyTimedOut ? { historyPartial: true } : {}),
    ...(preHistoryShortlistMeta ? { preHistoryShortlist: preHistoryShortlistMeta } : {}),
    ...(unresolvedRows?.length ? { unresolvedRows } : {}),
    ...(preHistoryRecoveryMeta ? { preHistoryRecovery: preHistoryRecoveryMeta } : {})
  };
}

module.exports = { buildResultMeta };
