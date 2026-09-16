'use strict';

// Env-var resolution for names the PP_ -> SSB_ rename left behind.
//
// The repo convention is `SSB_*`. A handful of variables predate the rename and
// keep their `PP_*` spelling as a compatibility alias (`PP_RECORD_LEDGER`,
// `PP_SCAN_TIMING`, `PP_HISTORY_DEADLINE_MS`, ...), while anything introduced
// after the rename must be `SSB_*` — one feature reading two namespaces, or a
// new variable minted in the retired one, is the defect this helper exists to
// prevent.
//
// A consumer of a renamed variable must therefore read BOTH names: canonical
// first, deprecated second. Reading only the new name would silently move a
// user's local state (say, snapshots written into a different directory) on the
// first run after an upgrade, which is exactly the kind of silent change that
// wastes a debug session.
//
// When both are set the canonical name wins, and the loser is reported under
// SSB_DEBUG=true instead of being discarded silently.

function debugEnabled() {
  return process.env.SSB_DEBUG === 'true';
}

/**
 * @typedef {Object} EnvVarResolution
 * @property {string|null} value    Raw value of the winning variable; null when neither is set.
 * @property {string|null} source   Name of the variable that supplied `value`.
 * @property {string|null} shadowed Deprecated variable that was set but lost to the canonical one.
 */

/**
 * Resolve a possibly-renamed environment variable.
 *
 * A blank/whitespace-only value counts as unset (the callers' existing "fall
 * back to the default" behaviour), and the winning value is returned untrimmed
 * so each caller's path handling stays exactly as it was.
 *
 * @param {string} canonical        Current name (`SSB_...`); preferred when both are set.
 * @param {string} [deprecated]     Pre-rename alias (`PP_...`); read only as a fallback.
 * @param {NodeJS.ProcessEnv} [env] Environment to read (injected for tests).
 * @returns {EnvVarResolution}
 */
function resolveEnvVar(canonical, deprecated, env = process.env) {
  const present = (name) => {
    const raw = name ? env[name] : undefined;
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  };

  const canonicalValue = present(canonical);
  const deprecatedValue = present(deprecated);

  if (canonicalValue !== null) {
    const shadowed = deprecatedValue !== null ? deprecated : null;
    if (shadowed && debugEnabled()) {
      console.error(`[env] ${canonical} wins over deprecated ${shadowed}`);
    }
    return { value: canonicalValue, source: canonical, shadowed };
  }

  if (deprecatedValue !== null) {
    return { value: deprecatedValue, source: deprecated, shadowed: null };
  }

  return { value: null, source: null, shadowed: null };
}

module.exports = { resolveEnvVar };
