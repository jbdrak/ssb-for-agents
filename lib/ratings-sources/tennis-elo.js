'use strict';

// tennis-elo source adapter for the external-ratings benchmark layer.
//
// Unlike the Massey/Sagarin/Sasser adapters, tennis Elo has no remote payload to
// parse: the ratings are built locally from a user-supplied match CSV
// (`lib/tennis-elo-data.js` -> `lib/tennis-elo.js`) and stored as a JSON
// snapshot outside the repo. So this adapter normalizes a LOADED SNAPSHOT into
// the shared contract instead of parsing a fetch response — no network, no
// bundled data, and every test path stays hermetic.
//
// It is a first-class source in the SAME layer: `SOURCE = 'tennis_elo'` is in
// the contract's `SOURCES`, its league is the canonical `TENNIS`, and its
// records flow through the one overlay and the one evaluation module. The
// removed pre-refactor Elo overlay ran a parallel pipeline; this is the port
// into the shared one.
//
// Design rules, all inherited from the layer and deliberate:
//
//   1. Moneyline only. Elo rates a head-to-head winner; it cannot price a total
//      or a handicap. A non-Moneyline market returns `unavailable` with a
//      reason and reads NOTHING from the snapshot, rather than emitting a
//      rating a consumer could read as a totals opinion. The emitted record is
//      market-scoped (`market: 'Moneyline'`) so the overlay never attaches it
//      to a totals row.
//   2. A reason is a claim that must be literally true. "player not in
//      snapshot", "snapshot not valid for this prediction date", and "surface
//      unknown" are three different `reasonKind`s with three different strings —
//      never collapsed into one plausible-looking excuse.
//   3. Point-in-time discipline is mandatory. The caller supplies the prediction
//      date (`asOf`); a snapshot whose manifest `asOf` is not strictly before it
//      is refused. An optional caller freshness floor (`snapshotNotBefore`)
//      additionally refuses a snapshot older than a date the caller will accept.
//   4. The surface-aware rating is the engine's own blend rule: `overall` plus
//      `surfaceWeight * (surfaceRating - overall)`, applied to BOTH players only
//      when BOTH have at least `minSurfaceMatches` completed matches on that
//      surface; otherwise `overall` alone. Constants come from the snapshot's
//      `engine.constants`, falling back to the engine defaults.
//   5. A single player is not an event. A lookup whose two sides resolve to the
//      same player is refused (`same_player`), so no `teamA === teamB` record is
//      ever emitted for an individual rating (the team-list lesson).
//   6. It carries a win probability, because the engine already produces one and
//      the evaluation half needs it: `modelWinProbability` is
//      `expectedScore(ratingA, ratingB)` over the same surface-aware ratings on
//      the record, labelled `modelWinProbabilityKind: 'derived'`. It is the
//      local engine's own conversion, not a vendor-published number, and the
//      label is what keeps that readable (see `buildRecord`).

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');
const { isBefore } = require('../ssb-ratings-recency');
const { resolvePlayer } = require('../tennis-elo-data');
const {
  DEFAULT_MIN_SURFACE_MATCHES,
  DEFAULT_SURFACE_WEIGHT,
  expectedScore,
  normalizeSurface
} = require('../tennis-elo');
const { getSupportedLeagues } = require('../league-presets');

const SOURCE = 'tennis_elo';
const METHOD = 'surface_elo';
const LEAGUE = 'TENNIS';
const ML_MARKET = 'Moneyline';

// The repo's canonical league registry: a real league this adapter does not
// cover (a scope gap) reports as one, and only a code outside the registry is a
// caller typo. Sourced from the ranking registry so a new league cannot drift
// into the "unrecognized" bucket.
const RECOGNIZED_LEAGUES = new Set(getSupportedLeagues());

// Accepted spellings of the one market Elo models, normalized below.
const ML_MARKET_KEYS = Object.freeze(new Set(['moneyline', 'ml']));

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** tennis Elo's canonical league codes (TENNIS only). */
function supportedLeagues() {
  return contractSupportedLeagues(SOURCE);
}

/**
 * Why a league has no tennis Elo ratings, or `null` when it does.
 *
 * Kept distinct from an unrecognized code on purpose (the massey/sasser
 * standard): a real canonical league this adapter does not cover is a scope
 * gap, not a typo.
 *
 * @param {unknown} league
 * @returns {string | null}
 */
function unsupportedReason(league) {
  if (typeof league !== 'string' || league.trim() === '') {
    return `${SOURCE} requires a canonical league code`;
  }
  const code = league.trim().toUpperCase();
  if (code === LEAGUE) return null;
  if (RECOGNIZED_LEAGUES.has(code)) return `${code} is not covered by the ${SOURCE} benchmark adapter`;
  return `${code} is not a recognized league code`;
}

function canonicalMarket(market) {
  return typeof market === 'string'
    ? market
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    : '';
}

function isMoneyline(market) {
  return ML_MARKET_KEYS.has(canonicalMarket(market));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isDateString(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Snapshot input
// ---------------------------------------------------------------------------

function loadFailureKind(reason) {
  if (reason === 'after_cutoff') return 'snapshot_after_cutoff';
  if (reason === 'invalid' || reason === 'invalid_cutoff') return 'snapshot_invalid';
  return 'snapshot_unavailable';
}

/**
 * Accept a `loadSnapshot()` result (`{ available, reason?, snapshot?, manifest?, path? }`)
 * or a raw data-layer snapshot (`{ manifest, players, aliasIndex }`) and resolve
 * it to `{ ok, snapshot, manifest }` or an explicit failure.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, snapshot?: Record<string, any>, manifest?: Record<string, any> | null, reasonKind?: string, reason?: string }}
 */
function readSnapshotInput(input) {
  if (input === null || input === undefined) {
    return {
      ok: false,
      reasonKind: 'snapshot_unavailable',
      reason: `${SOURCE} snapshot is unavailable (none supplied)`
    };
  }
  if (typeof input !== 'object') {
    return {
      ok: false,
      reasonKind: 'snapshot_invalid',
      reason: `${SOURCE} snapshot must be a snapshot object or a loadSnapshot result`
    };
  }
  const raw = /** @type {Record<string, any>} */ (input);

  if (raw.available === false) {
    const where = typeof raw.path === 'string' ? ` at ${raw.path}` : '';
    const detail = typeof raw.error === 'string' ? ` (${raw.error})` : '';
    return {
      ok: false,
      reasonKind: loadFailureKind(raw.reason),
      reason: `${SOURCE} snapshot is unavailable${where}: ${String(raw.reason)}${detail}`,
      manifest: raw.manifest || null
    };
  }
  if (raw.available === true) {
    const snapshot = raw.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return { ok: false, reasonKind: 'snapshot_invalid', reason: `${SOURCE} loadSnapshot result carries no snapshot` };
    }
    return { ok: true, snapshot, manifest: raw.manifest || snapshot.manifest || null };
  }
  if (raw.players && typeof raw.players === 'object') {
    return { ok: true, snapshot: raw, manifest: raw.manifest || null };
  }
  return { ok: false, reasonKind: 'snapshot_invalid', reason: `${SOURCE} snapshot is missing its players map` };
}

// ---------------------------------------------------------------------------
// Rating math (the engine's own blend rule)
// ---------------------------------------------------------------------------

function constantsFor(snapshot) {
  const constants = snapshot && snapshot.engine && snapshot.engine.constants;
  const surfaceWeight =
    constants && Number.isFinite(constants.surfaceWeight) ? constants.surfaceWeight : DEFAULT_SURFACE_WEIGHT;
  const minSurfaceMatches =
    constants && Number.isInteger(constants.minSurfaceMatches)
      ? constants.minSurfaceMatches
      : DEFAULT_MIN_SURFACE_MATCHES;
  return { surfaceWeight, minSurfaceMatches };
}

function surfaceSampleOf(player, surface) {
  const entry = player && player.surfaces && player.surfaces[surface];
  return entry && Number.isInteger(entry.matches) ? entry.matches : 0;
}

function surfaceRatingOf(player, surface) {
  const entry = player && player.surfaces && player.surfaces[surface];
  return entry && Number.isFinite(entry.rating) ? entry.rating : null;
}

/**
 * Surface-aware Elo for one player. Both sides of a match share the blend
 * decision (the engine requires BOTH players to clear `minSurfaceMatches`), so
 * `blended` is computed once for the pair.
 */
function effectiveRating(player, surface, blended, constants) {
  if (!player || !Number.isFinite(player.overall)) return null;
  if (!blended) return player.overall;
  const surfaceRating = surfaceRatingOf(player, surface);
  if (surfaceRating === null) return player.overall;
  return player.overall + constants.surfaceWeight * (surfaceRating - player.overall);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function envelope(coverage, reasonKind, reason, manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  return {
    source: SOURCE,
    league: LEAGUE,
    method: METHOD,
    season: null,
    asOf: typeof m.asOf === 'string' ? m.asOf : null,
    fetchedAt: typeof m.importedAt === 'string' ? m.importedAt : null,
    sourceUrl: typeof m.sourceUrl === 'string' ? m.sourceUrl : null,
    sourceHash: typeof m.sourceHash === 'string' ? m.sourceHash : null,
    coverage,
    records: [],
    skipped: [],
    unresolvedReason: reason,
    reasonKind
  };
}

function unavailable(reasonKind, reason, manifest) {
  return envelope('unavailable', reasonKind, reason, manifest);
}

/**
 * Map a resolver failure to an honest `reasonKind` + reason. The original
 * (display) name is echoed, not the normalized key, so the message is readable.
 */
function playerFailure(resolution, name, tour, manifest) {
  const display = typeof name === 'string' && name.trim() !== '' ? name.trim() : '';
  const tourLabel = typeof tour === 'string' && tour.trim() !== '' ? tour.trim().toUpperCase() : 'unknown';
  if (resolution.reason === 'unknown_tour') {
    return unavailable('unknown_tour', `${SOURCE} tour "${String(tour)}" is not a known tour (atp, wta)`, manifest);
  }
  if (resolution.reason === 'ambiguous') {
    return unavailable(
      'ambiguous_player',
      `${SOURCE} player "${display}" is ambiguous in the ${tourLabel} snapshot`,
      manifest
    );
  }
  if (resolution.reason === 'missing_snapshot') {
    return unavailable(
      'snapshot_invalid',
      `${SOURCE} snapshot has no players map to resolve "${display}" against`,
      manifest
    );
  }
  return unavailable('unknown_player', `${SOURCE} player "${display}" is not in the ${tourLabel} snapshot`, manifest);
}

function buildRecord(context) {
  const { playerA, playerB, ratingA, ratingB, manifest } = context;
  return {
    source: SOURCE,
    method: METHOD,
    league: LEAGUE,
    season: null,
    asOf: manifest.asOf,
    fetchedAt: manifest.importedAt,
    sourceUrl: manifest.sourceUrl,
    sourceHash: manifest.sourceHash,
    eventId: null,
    teamA: playerA.name,
    teamB: playerB.name,
    neutral: null,
    ratingA,
    ratingB,
    predictedScoreA: null,
    predictedScoreB: null,
    predictedTotal: null,
    predictedMargin: null,
    homeAdvantage: null,
    marketOpen: null,
    marketCurrent: null,
    // The engine's OWN Elo expectation for the pair it just rated:
    //   expectedScore(ratingA, ratingB) = 1 / (1 + 10^((ratingB - ratingA) / 400))
    // with the same surface-aware `ratingA`/`ratingB` carried on this record, so
    // the probability is reproducible from the record alone.
    //
    // Attribution: `derived`, never `published`. No vendor publishes this
    // number - it is the local engine's conversion of its own ratings, and the
    // distinction is what stops a derived figure being read as a source's own
    // claim (see lib/ssb-ratings-contract.js -> PROBABILITY_KINDS). The formula
    // is the engine's standard expectation, used for every rating update in
    // `lib/tennis-elo.js`, and has no fitted parameters: the 400 scale and the
    // surface blend weights come from the snapshot's own `engine.constants`.
    // Direction: this is `teamA`'s (= the lookup's `playerA`) win probability.
    modelWinProbability: expectedScore(ratingA, ratingB),
    modelWinProbabilityKind: 'derived',
    coverage: 'full',
    matchStatus: 'unmatched',
    unresolvedReason: null,
    // Not a contract field: the overlay reads it to scope this record to the
    // moneyline, so a totals/handicap row can never inherit an Elo record.
    market: ML_MARKET
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Normalize one tennis moneyline lookup into a contract record.
 *
 * @param {{
 *   snapshot: unknown,          // a loadSnapshot() result or a raw snapshot
 *   tour: string,               // 'atp' | 'wta'
 *   playerA: string,
 *   playerB: string,
 *   surface: string,            // hard | clay | grass (variants accepted)
 *   market: string,             // must be a Moneyline variant
 *   asOf: string,               // the prediction/match date (point-in-time cutoff)
 *   snapshotNotBefore?: string  // optional freshness floor for the snapshot
 * }} options
 * @returns {Record<string, any>} the adapter envelope (records non-empty only on success)
 */
function lookupMatch(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { snapshot: snapshotInput, tour, playerA, playerB, surface, market, asOf, snapshotNotBefore } = opts;

  // 1. Market first: a market Elo cannot model must not read the snapshot at all.
  if (!isMoneyline(market)) {
    return unavailable(
      'unsupported_market',
      `${SOURCE} models the moneyline only; "${String(market)}" is not a supported tennis market`,
      null
    );
  }

  // 2. The prediction date is mandatory (point-in-time discipline).
  if (!isDateString(asOf)) {
    return unavailable(
      'missing_asof',
      `${SOURCE} requires the prediction date (asOf) for point-in-time discipline`,
      null
    );
  }

  // 3. Snapshot availability.
  const resolved = readSnapshotInput(snapshotInput);
  if (!resolved.ok) return unavailable(/** @type {string} */ (resolved.reasonKind), String(resolved.reason), null);
  const snapshot = /** @type {Record<string, any>} */ (resolved.snapshot);
  const manifest = resolved.manifest;
  if (!manifest || typeof manifest !== 'object') {
    return unavailable('snapshot_invalid', `${SOURCE} snapshot has no manifest, so its provenance is unknown`, null);
  }

  // 4. Provenance — the contract requires it, so a gap is named, never faked.
  //    The build side refuses this at BUILD time (scripts/refresh-tennis-elo.js),
  //    so reaching here means a hand-built or --engine-only snapshot; say what
  //    fixes it instead of leaving the reader with an unexplained refusal.
  if (!isNonEmptyString(manifest.sourceUrl)) {
    return unavailable(
      'missing_provenance',
      `${SOURCE} snapshot manifest has no sourceUrl; the ratings contract requires provenance ` +
        '(rebuild with scripts/refresh-tennis-elo.js --source-url <url>)',
      manifest
    );
  }
  if (!isNonEmptyString(manifest.sourceHash)) {
    return unavailable(
      'missing_provenance',
      `${SOURCE} snapshot manifest has no sourceHash; the ratings contract requires provenance`,
      manifest
    );
  }
  if (!isDateString(manifest.asOf)) {
    return unavailable(
      'missing_provenance',
      `${SOURCE} snapshot manifest has no asOf date, so point-in-time discipline cannot be enforced`,
      manifest
    );
  }

  // 5. Point-in-time: the snapshot must be strictly before the prediction date.
  //    Compared through the layer's one date-order primitive
  //    (lib/ssb-ratings-recency.js), so this stays the strictest form of the same
  //    rule the team-sport paths apply with a window - never a second rule.
  const predictionDate = String(asOf).slice(0, 10);
  const snapshotAsOf = String(manifest.asOf).slice(0, 10);
  if (!isBefore(snapshotAsOf, predictionDate)) {
    return unavailable(
      'snapshot_after_cutoff',
      `${SOURCE} snapshot asOf ${snapshotAsOf} is not before the prediction date ${predictionDate}`,
      manifest
    );
  }

  // 6. Optional caller freshness floor.
  if (isNonEmptyString(snapshotNotBefore)) {
    const floor = String(snapshotNotBefore).slice(0, 10);
    if (isDateString(floor) && isBefore(snapshotAsOf, floor)) {
      return unavailable(
        'snapshot_stale',
        `${SOURCE} snapshot asOf ${snapshotAsOf} is older than the caller's freshness cutoff ${floor}`,
        manifest
      );
    }
  }

  // 7. Resolve both players (exact name / explicit unique alias only).
  const resolutionA = resolvePlayer(snapshot, { tour, name: playerA });
  if (!resolutionA.available) return playerFailure(resolutionA, playerA, tour, manifest);
  const resolutionB = resolvePlayer(snapshot, { tour, name: playerB });
  if (!resolutionB.available) return playerFailure(resolutionB, playerB, tour, manifest);
  if (resolutionA.id === resolutionB.id) {
    return unavailable(
      'same_player',
      `${SOURCE} requires two distinct players; "${resolutionA.name}" resolves both sides`,
      manifest
    );
  }

  // 8. Surface is required; Elo blends it in, so an unknown label is refused.
  const surfaceKey = normalizeSurface(surface);
  if (!surfaceKey) {
    return unavailable(
      'unknown_surface',
      `${SOURCE} cannot rate an unknown surface "${String(surface)}" (known: hard, clay, grass)`,
      manifest
    );
  }

  // 9. Surface-aware ratings, using the pair's own blend decision.
  const constants = constantsFor(snapshot);
  const blended =
    surfaceSampleOf(resolutionA.player, surfaceKey) >= constants.minSurfaceMatches &&
    surfaceSampleOf(resolutionB.player, surfaceKey) >= constants.minSurfaceMatches;
  const ratingA = effectiveRating(resolutionA.player, surfaceKey, blended, constants);
  const ratingB = effectiveRating(resolutionB.player, surfaceKey, blended, constants);
  if (ratingA === null || ratingB === null) {
    return unavailable(
      'player_missing_rating',
      `${SOURCE} snapshot has no usable overall rating for "${ratingA === null ? resolutionA.name : resolutionB.name}"`,
      manifest
    );
  }

  const record = buildRecord({ playerA: resolutionA, playerB: resolutionB, ratingA, ratingB, manifest });
  const validation = validateRatingRecord(record);
  if (!validation.ok) {
    return unavailable(
      'invalid_record',
      `${SOURCE} record failed contract validation: ${validation.errors.join('; ')}`,
      manifest
    );
  }

  return { ...envelope('full', null, null, manifest), records: [record] };
}

module.exports = {
  SOURCE,
  METHOD,
  LEAGUE,
  ML_MARKET,
  supportedLeagues,
  unsupportedReason,
  lookupMatch
};
