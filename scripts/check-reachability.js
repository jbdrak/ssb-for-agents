#!/usr/bin/env node
'use strict';

/**
 * Reachability and handler-wiring guard.
 *
 * Two failure classes this catches, both of which ship silently:
 *
 * 1. UNREACHABLE PRODUCTION FILE — nothing requires it, nothing spawns it, no doc
 *    references it. It still ships in the package (package.json ships `lib/`
 *    wholesale) and still rots.
 *
 * 2. LATENT HANDLER CRASH — a `ctx.handlers.X(...)` call site whose `X` no wired
 *    handler module provides. This is the expensive one: the module can look
 *    perfectly referenced while the call site throws `TypeError: ctx.handlers.X is
 *    not a function` at runtime, on a real scan, in production. It happens when an
 *    extraction adds the require, and a later cleanup removes the require and the
 *    destructure but rewrites call sites to `ctx.handlers.X` without adding the
 *    module to the merge block. An unreferenced module is NOT the same verdict as
 *    "safe to delete" — when call sites reference a symbol only the orphan provides,
 *    the fix is rewire OR delete module + call sites together.
 *
 * A file counts as reachable if ANY of these hold:
 *   - it is a package.json script / bin / main target
 *   - it is required (directly or transitively) from such a target
 *   - its repo-relative path appears anywhere in code, README, docs, or CI
 *     (how manual/spawned tooling and documented workflows are wired)
 *
 * Usage: node scripts/check-reachability.js [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'scripts', 'bin'];
const BIN_WRAPPERS = ['bin/pp', 'bin/backtest', 'bin/ssb'];

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkJs(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function allMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...allMd(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Every specifier this file pulls in, including the dynamic forms that are easy to
 * miss: `require(PROJECT + '/lib/x')`, `require(__dirname + '/x')`, and JSDoc type
 * imports `import('./x')` — a types-only module has NO require at all, so without
 * the JSDoc form a legitimate typedef file looks unreachable.
 */
function requiresOf(src) {
  const specs = [];
  for (const re of [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*PROJECT\s*\+\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*__dirname\s*\+\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g
  ]) {
    for (const m of src.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/** Resolve a specifier to a real file, or null for a bare module spec. */
function resolveSpec(spec, fromDir) {
  const candidates = [];
  if (spec.startsWith('/')) {
    const base = path.normalize(path.join(ROOT, spec));
    candidates.push(base, `${base}.js`, path.join(base, 'index.js'));
  } else if (spec.startsWith('.')) {
    const base = path.normalize(path.join(fromDir, spec));
    candidates.push(base);
    if (!spec.endsWith('.js')) candidates.push(`${base}.js`, path.join(base, 'index.js'));
  } else {
    return null;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
  }
  return null;
}

/**
 * The pure comparison behind the handler guard, factored out so it can be tested
 * directly — a guard nobody can prove fires is not a guard.
 *
 * @param {Map<string, Set<string>>} callSites - symbol -> files calling it
 * @param {Set<string>} provided - keys exported by the handler modules
 * @returns {Array<{symbol: string, calledFrom: string[]}>}
 */
function unprovidedHandlers(callSites, provided) {
  return [...callSites.entries()]
    .filter(([symbol]) => !provided.has(symbol))
    .map(([symbol, where]) => ({ symbol, calledFrom: [...where].sort() }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function run() {
  const prodFiles = SCAN_DIRS.flatMap((d) => walkJs(path.join(ROOT, d)));
  for (const wrapper of BIN_WRAPPERS) {
    const p = path.join(ROOT, wrapper);
    if (fs.existsSync(p)) prodFiles.push(p);
  }

  const files = [...new Set(prodFiles.map((f) => fs.realpathSync(f)))];
  const graph = new Map();
  const text = new Map();
  for (const f of files) {
    const src = read(f);
    text.set(f, src);
    graph.set(
      f,
      new Set(
        requiresOf(src)
          .map((s) => resolveSpec(s, path.dirname(f)))
          .filter(Boolean)
      )
    );
  }

  // ---- reference corpus: code + README + docs + CI (NOT the changelog, which is
  // historical and mentions files that no longer exist) ----
  const corpus = [
    ...[...text.values()],
    read(path.join(ROOT, 'README.md')),
    // NOTE: allMd() returns PATHS — map through read(), or the corpus ends up
    // containing filenames instead of the documentation inside them, and every
    // documented manual tool looks unreferenced.
    ...allMd(path.join(ROOT, 'docs')).map(read),
    ...allMd(path.join(ROOT, 'lib')).map(read)
  ].join('\n');

  // ---- entrypoints ----
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')) || '{}');
  const entry = new Set();
  const add = (rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) entry.add(fs.realpathSync(p));
  };
  for (const value of Object.values(pkg.scripts || {})) {
    for (const m of String(value).matchAll(/([\w./-]+\.js)/g)) add(m[1]);
  }
  for (const value of Object.values(pkg.bin || {})) add(value);
  if (typeof pkg.main === 'string') add(pkg.main);
  for (const wrapper of ['bin/pp', 'bin/backtest', 'bin/ssb', 'bin/pp-cli.js']) add(wrapper);

  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  for (const f of files) {
    if (corpus.includes(rel(f))) entry.add(f);
  }

  // ---- transitive closure ----
  const seen = new Set();
  const stack = [...entry];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of graph.get(cur) || []) if (!seen.has(next)) stack.push(next);
  }

  const unreachable = files
    .filter((f) => !seen.has(f))
    .map(rel)
    .sort();

  // ---- handler wiring: every ctx.handlers.X call site must have a provider ----
  const handlerDir = path.join(ROOT, 'scripts/server/handlers');
  const provided = new Set();
  if (fs.existsSync(handlerDir)) {
    for (const f of walkJs(handlerDir)) {
      const src = read(f);
      for (const m of src.matchAll(/(?:^|\s)([a-zA-Z0-9_]+)\s*:/g)) provided.add(m[1]);
      for (const m of src.matchAll(/return\s*\{([^}]*)\}/g)) {
        for (const name of m[1].matchAll(/([a-zA-Z0-9_]+)/g)) provided.add(name[0]);
      }
    }
  }
  const callSites = new Map();
  for (const f of files) {
    // This checker's own docstring mentions `ctx.handlers.X`, so it must not count
    // itself, and the match requires a call paren — a bare mention is not a call.
    if (rel(f) === 'scripts/check-reachability.js') continue;
    for (const m of read(f).matchAll(/ctx\.handlers\.([a-zA-Z0-9_]+)\s*\(/g)) {
      if (!callSites.has(m[1])) callSites.set(m[1], new Set());
      callSites.get(m[1]).add(rel(f));
    }
  }
  const unprovided = unprovidedHandlers(callSites, provided);

  return { filesScanned: files.length, entrypoints: entry.size, unreachable, unprovided };
}

function main() {
  const result = run();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.unreachable.length || result.unprovided.length ? 1 : 0;
  }

  const problems = result.unreachable.length + result.unprovided.length;
  if (!problems) {
    console.log(
      `reachability OK — ${result.filesScanned} production file(s), ${result.entrypoints} entrypoint(s), ` +
        'no unreachable file and every ctx.handlers call site is provided'
    );
    return 0;
  }

  if (result.unreachable.length) {
    console.error(`error: ${result.unreachable.length} unreachable production file(s):`);
    for (const f of result.unreachable) console.error(`  ${f}`);
    console.error('  Wire it from an entrypoint, document its path, or delete it.');
  }
  if (result.unprovided.length) {
    console.error(`error: ${result.unprovided.length} ctx.handlers call site(s) with NO provider:`);
    for (const { symbol, calledFrom } of result.unprovided) {
      console.error(`  ctx.handlers.${symbol}  called from ${calledFrom.join(', ')}`);
    }
    console.error('  This throws TypeError at runtime. Rewire the module into the merge');
    console.error('  block, or delete the call sites together with the module.');
  }
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { run, main, requiresOf, resolveSpec, unprovidedHandlers };
