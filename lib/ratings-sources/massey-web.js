'use strict';

// Massey export transport for the external-ratings benchmark layer.
//
// Why this module exists: masseyratings.com's ratings host sits behind a bot
// wall that answers plain HTTP (including `node fetch`, with or without a real
// Chrome User-Agent) with HTTP 403 `<title>Just a moment...</title>`. The
// repo's existing `got-scraping` client - already a production dependency and
// already the head of the auth fallback chain - passes that wall, so it is the
// transport, and `createMasseyFetch()` adapts it to the standard `fetch` shape
// the ratings adapters inject.
//
// Passing the wall is not enough, though: the ratings page is a JavaScript
// shell that populates its table from a same-host JSON endpoint, and both the
// endpoint token and the numbers inside the response are obfuscated by the
// page's own script. A plain HTTP fetch of the page therefore returns no rows,
// and the endpoint answers HTTP 500 without the page-issued token. This module
// reproduces the two steps the page itself performs, in the same order:
//
//   1. read `stamp.obfu` / `stamp.jsonURL` out of the page HTML;
//   2. `decodeExportUrl(jsonURL)` - the page's own `decstr` (base64url decode,
//      then subtract an LCG keystream) - yields the relative export URL;
//   3. GET that URL for the ratings JSON (`CI` = columns, `DI` = rows);
//   4. `decodeMasseyRows()` removes the per-cell obfuscation using the seed the
//      page itself derives, `parseInt(obfu.slice(32), 10)`: a `gfac` 1 column
//      holds a rank (subtract the keystream), a `gfac` 2 column holds the value
//      (divide by keystream + 1), and an untitled `gfac` 2 column carries the
//      value belonging to the titled column before it.
//
// Verified live 2026-09-15 against the rendered page: the decoded values agree
// with the DOM table for all 2208 numeric cells of the FBS ratings table.
//
// This is a reverse-engineered VENDOR CONTRACT, not a documented API. It is
// pinned to the current `inc/stamp.js` build (`stamp.obfu` carries the version)
// and will break when Massey changes that script. Every step therefore fails
// closed with a reason naming the step that broke, and nothing partial is
// returned: a missing token, an unusable seed, an empty payload, or a decoded
// table with no `Team` column throws rather than yielding wrong ratings.
//
// No third-party payload is committed: this module only performs the transfer,
// and callers persist derived records via `lib/ssb-ratings-snapshot.js`.

const B64URL_OFFSET = 0x7e5;
const KEY_MULTIPLIER = 0x1fb9;
const KEY_INCREMENT = 0x4d2;
const KEY_MODULUS = 0x400;
const KEY_BYTE_MODULUS = 0x100;
const OBFU_SEED_OFFSET = 0x20;

// The page's own inline config, e.g. `stamp.obfu = "5e60...f941";`.
const PAGE_TOKEN_PATTERNS = Object.freeze({
  obfu: /stamp\.obfu\s*=\s*"([^"]+)"/,
  jsonURL: /stamp\.jsonURL\s*=\s*"([^"]+)"/
});

const ACCEPT = 'text/html,application/json,text/csv;q=0.9,*/*;q=0.8';

function resolveFetchedAt(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  if (typeof now === 'string' && Number.isFinite(Date.parse(now))) return new Date(Date.parse(now)).toISOString();
  return new Date().toISOString();
}

/** Run one text request through the injected transport, failing closed. */
async function requestText(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: ACCEPT } });
  if (!res || res.ok === false) {
    const status = res && res.status ? res.status : 'unknown';
    throw new Error(`massey: HTTP ${status} from ${url}`);
  }
  if (typeof res.text !== 'function') {
    throw new Error('massey: transport response has no text() body');
  }
  return String(await res.text());
}

/**
 * The page's own `decstr`: base64url-decode, then subtract an LCG keystream.
 * Pure, so the URL decode is exercised without any network.
 *
 * @param {string} encoded
 * @param {number} [key]
 * @returns {string}
 */
function decodeExportUrl(encoded, key = B64URL_OFFSET) {
  const base64 = String(encoded).replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=');
  const binary = Buffer.from(base64, 'base64').toString('binary');
  const bytes = [];
  let state = key;
  for (let i = 0; i < binary.length; i++) {
    state = (KEY_MULTIPLIER * state + KEY_INCREMENT) % KEY_BYTE_MODULUS;
    bytes.push((binary.charCodeAt(i) - state + KEY_BYTE_MODULUS) % KEY_BYTE_MODULUS);
  }
  return Buffer.from(bytes).toString('binary');
}

/**
 * The obfuscation seed the page derives from its own `stamp.obfu` constant.
 *
 * @param {unknown} obfu
 * @returns {number}
 */
function decodeSeed(obfu) {
  const text = String(obfu === null || obfu === undefined ? '' : obfu);
  const seed = parseInt(text.slice(OBFU_SEED_OFFSET), 10);
  if (!Number.isInteger(seed)) {
    throw new Error('massey: export obfuscation changed (cannot derive the decode seed from stamp.obfu)');
  }
  return seed;
}

/** `stamp.obfu` / `stamp.jsonURL` out of the page HTML, or nulls. */
function readPageTokens(html) {
  const text = String(html || '');
  return {
    obfu: (PAGE_TOKEN_PATTERNS.obfu.exec(text) || [])[1] || null,
    jsonURL: (PAGE_TOKEN_PATTERNS.jsonURL.exec(text) || [])[1] || null
  };
}

/**
 * The page's obfuscated export URL resolved to an absolute, same-host URL.
 *
 * @param {string} jsonURL
 * @param {string} pageUrl
 * @returns {string}
 */
function resolveExportUrl(jsonURL, pageUrl) {
  const relative = decodeExportUrl(jsonURL);
  if (!relative.startsWith('/')) {
    throw new Error('massey: decoded export URL is not a path on the ratings host');
  }
  return new URL(relative, pageUrl).href;
}

/**
 * Remove the per-cell obfuscation from a ratings payload.
 *
 * Pure and total: a malformed row is skipped and a cell that is not a finite
 * number is left exactly as received. The caller decides what an empty result
 * means (`masseyExportCsv` treats it as a hard failure).
 *
 * @param {Record<string, any>} payload
 * @param {unknown} obfu
 * @returns {Array<any> | null}
 */
function decodeMasseyRows(payload, obfu) {
  const columns = Array.isArray(payload && payload.CI) ? payload.CI : [];
  const source = Array.isArray(payload && payload.DI) ? payload.DI : [];
  if (columns.length === 0 || source.length === 0) return null;

  let key = decodeSeed(obfu);
  const rows = source.map((row) => (Array.isArray(row) ? row.slice() : row));
  for (let c = 0; c < columns.length; c++) {
    const type = columns[c] && columns[c].gfac;
    if (!type) continue;
    for (let r = 0; r < rows.length; r++) {
      key = (KEY_MULTIPLIER * key + KEY_INCREMENT) % KEY_MODULUS;
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const wrapped = Array.isArray(row[c]);
      const value = wrapped ? row[c][0] : row[c];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      // Only rank (1) and value (2) columns obfuscate numbers; anything else is
      // left as received rather than guessed at.
      const decoded = type === 1 ? value - key : type === 2 ? value / (key + 1) : value;
      if (wrapped) row[c][0] = decoded;
      else row[c] = decoded;
    }
  }
  return rows;
}

/** The scalar a cell displays: an array cell shows its first element. */
function cellScalar(value) {
  if (Array.isArray(value)) return value.length > 0 ? cellScalar(value[0]) : '';
  return value === null || value === undefined ? '' : value;
}

/** One cell as text, using the column's own declared decimals when it has any. */
function formatCell(value, decimals) {
  const scalar = cellScalar(value);
  if (scalar === '') return '';
  if (typeof scalar !== 'number') return String(scalar);
  if (!Number.isFinite(scalar)) return '';
  if (Number.isInteger(decimals) && decimals >= 0) return scalar.toFixed(decimals);
  return Number.isInteger(scalar) ? String(scalar) : String(Number(scalar.toFixed(6)));
}

/**
 * Map the payload's columns onto the adapter's documented CSV shape: a titled
 * column carries the stat, and an untitled follow-on value column belonging to
 * it is folded in, so a ranked cell reads `1 9.10` and a plain value reads
 * `2.14`. Untitled columns with no titled predecessor - Massey's conference
 * cell - are dropped.
 *
 * @param {Array<Record<string, any>>} columns
 * @returns {Array<{ header: string, index: number, attach: number[] }>}
 */
function buildColumnPlan(columns) {
  const plan = [];
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i] || {};
    const title = typeof column.title === 'string' && column.title.trim() !== '' ? column.title.trim() : '';
    if (title === '') {
      const previous = plan.length > 0 ? plan[plan.length - 1] : null;
      if (column.gfac === 2 && previous) previous.attach.push(i);
      continue;
    }
    plan.push({ header: title, index: i, attach: [] });
  }
  if (!plan.some((entry) => entry.header.toLowerCase() === 'team')) {
    throw new Error('massey: export payload has no Team column (the vendor layout changed)');
  }
  return plan;
}

function formatRow(plan, columns, row) {
  return plan.map((entry) => {
    const cells = [formatCell(row[entry.index], (columns[entry.index] || {}).decimals)];
    for (const index of entry.attach) cells.push(formatCell(row[index], (columns[index] || {}).decimals));
    return cells.filter((cell) => cell !== '').join(' ');
  });
}

/** RFC4180-quote a CSV cell (only when it actually needs it). */
function quoteCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Turn a Massey ratings payload into the CSV shape `normalizeMassey` reads.
 *
 * @param {Record<string, any>} payload
 * @param {{ obfu: unknown, league?: string }} options
 * @returns {{ raw: string, rowCount: number }}
 */
function masseyExportCsv(payload, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const columns = Array.isArray(payload && payload.CI) ? payload.CI : [];
  const rows = decodeMasseyRows(payload, opts.obfu);
  if (!rows) {
    throw new Error('massey: export payload carried no CI/DI ratings table');
  }

  const plan = buildColumnPlan(columns);
  const body = rows.filter((row) => /\S/.test(formatRow(plan, columns, row)[0]));
  if (body.length === 0) {
    throw new Error('massey: export payload decoded to no ratings rows');
  }

  const subname = typeof payload.subname === 'string' ? payload.subname : '';
  const maxdate = payload.rating && typeof payload.rating.maxdate === 'string' ? payload.rating.maxdate : '';
  const title = `Massey ${opts.league || ''}${subname} Using games thru ${maxdate}`.trim();
  const lines = [title, plan.map((entry) => quoteCell(entry.header)).join(',')];
  for (const row of body) {
    lines.push(formatRow(plan, columns, row).map(quoteCell).join(','));
  }
  return { raw: lines.join('\n') + '\n', rowCount: body.length };
}

/** Parse a fetched body as a Massey ratings payload, or `null` when it is not one. */
function parsePayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return parsed && Array.isArray(parsed.DI) && Array.isArray(parsed.CI) ? parsed : null;
}

async function fetchPageTokens(fetchImpl, pageUrl) {
  const tokens = readPageTokens(await requestText(fetchImpl, pageUrl));
  if (!tokens.obfu || !tokens.jsonURL) {
    throw new Error('massey: ratings page carried no export token (stamp.obfu / stamp.jsonURL)');
  }
  return tokens;
}

/**
 * Fetch one Massey table payload (the decoded `{ CI, DI, ... }` JSON) plus the
 * page-issued seed, without interpreting the table.
 *
 * Every Massey page - the per-sport ratings table and the per-sport games
 * board - is served through the same `stamp.obfu` / `stamp.jsonURL` chain, so
 * the transfer is shared and only the column plan differs. Callers that know
 * which table they asked for do their own decoding: `fetchMasseyExport` builds
 * the ratings CSV, and the games adapter reads the games columns directly.
 *
 * @param {{ pageUrl: string, fetchImpl: Function, now?: Date | string, exportUrl?: string, obfu?: string }} options
 * @returns {Promise<{ payload: Record<string, any>, obfu: string, sourceUrl: string, exportUrl: string, fetchedAt: string }>}
 */
async function fetchMasseyPayload(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { fetchImpl, pageUrl, now } = opts;
  if (typeof fetchImpl !== 'function') {
    throw new Error('massey: fetchMasseyPayload requires an injected fetchImpl (dependency-injected fetch)');
  }
  if (typeof pageUrl !== 'string' || pageUrl.trim() === '') {
    throw new Error('massey: fetchMasseyPayload requires the league pageUrl');
  }
  const fetchedAt = resolveFetchedAt(now);
  const explicit = typeof opts.exportUrl === 'string' ? opts.exportUrl.trim() : '';

  if (explicit !== '') {
    const body = await requestText(fetchImpl, explicit);
    const payload = parsePayload(body);
    if (!payload) {
      throw new Error(`massey: explicit export URL did not return a Massey payload (${explicit})`);
    }
    const obfu = opts.obfu || (await fetchPageTokens(fetchImpl, pageUrl)).obfu;
    return { payload, obfu, sourceUrl: pageUrl, exportUrl: explicit, fetchedAt };
  }

  const tokens = await fetchPageTokens(fetchImpl, pageUrl);
  const exportUrl = resolveExportUrl(tokens.jsonURL, pageUrl);
  const payload = parsePayload(await requestText(fetchImpl, exportUrl));
  if (!payload) {
    throw new Error(`massey: export endpoint did not return a ratings payload (${exportUrl})`);
  }
  return { payload, obfu: tokens.obfu, sourceUrl: pageUrl, exportUrl, fetchedAt };
}

/**
 * Fetch one Massey ratings export and return it as the CSV the adapter parses.
 *
 * `exportUrl` is the operator seam: a URL that returns Massey's export CSV is
 * passed through untouched, and one that returns the export JSON is decoded
 * (the seed still comes from the ratings page unless `obfu` is supplied). With
 * no `exportUrl` the full page -> token -> export chain runs.
 *
 * @param {{ pageUrl: string, fetchImpl: Function, league?: string, now?: Date | string, exportUrl?: string, obfu?: string }} options
 * @returns {Promise<{ raw: string, sourceUrl: string, exportUrl: string, fetchedAt: string }>}
 */
async function fetchMasseyExport(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { fetchImpl, pageUrl, league, now } = opts;
  if (typeof fetchImpl !== 'function') {
    throw new Error('massey: fetchMasseyExport requires an injected fetchImpl (dependency-injected fetch)');
  }
  if (typeof pageUrl !== 'string' || pageUrl.trim() === '') {
    throw new Error('massey: fetchMasseyExport requires the league ratings pageUrl');
  }
  const fetchedAt = resolveFetchedAt(now);
  const explicit = typeof opts.exportUrl === 'string' ? opts.exportUrl.trim() : '';

  if (explicit !== '') {
    const body = await requestText(fetchImpl, explicit);
    const payload = parsePayload(body);
    if (!payload) return { raw: body, sourceUrl: pageUrl, exportUrl: explicit, fetchedAt };
    const obfu = opts.obfu || (await fetchPageTokens(fetchImpl, pageUrl)).obfu;
    return { raw: masseyExportCsv(payload, { obfu, league }).raw, sourceUrl: pageUrl, exportUrl: explicit, fetchedAt };
  }

  const tokens = await fetchPageTokens(fetchImpl, pageUrl);
  const exportUrl = resolveExportUrl(tokens.jsonURL, pageUrl);
  const payload = parsePayload(await requestText(fetchImpl, exportUrl));
  if (!payload) {
    throw new Error(`massey: export endpoint did not return a ratings payload (${exportUrl})`);
  }
  return { raw: masseyExportCsv(payload, { obfu: tokens.obfu, league }).raw, sourceUrl: pageUrl, exportUrl, fetchedAt };
}

/**
 * Adapt got-scraping to the injected `fetch` shape. Required for Massey: the
 * host 403s plain HTTP, and got-scraping is the client that passes its bot
 * wall. Cached per factory call so a refresh reuses one client.
 *
 * @returns {Function} a `(url, options) => Promise<{ ok, status, text }>` fetch
 */
function createMasseyFetch() {
  let clientPromise = null;
  const load = () => {
    if (clientPromise === null) {
      // got-scraping ships ESM only, so it is loaded lazily. The cast mirrors
      // `lib/ssb-auth.js`: the package's default/named export shape differs
      // across its own typings and the runtime build.
      clientPromise = import('got-scraping').then((loaded) => {
        const mod = /** @type {any} */ (loaded);
        return mod.gotScraping || mod.default || mod;
      });
    }
    return clientPromise;
  };
  return async function masseyFetch(url, options = {}) {
    const gotScraping = await load();
    const res = await gotScraping({
      url,
      responseType: 'text',
      timeout: { request: 20000 },
      headers: options.headers
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => res.body };
  };
}

module.exports = {
  B64URL_OFFSET,
  decodeExportUrl,
  decodeSeed,
  readPageTokens,
  resolveExportUrl,
  decodeMasseyRows,
  masseyExportCsv,
  fetchMasseyPayload,
  fetchMasseyExport,
  createMasseyFetch
};
