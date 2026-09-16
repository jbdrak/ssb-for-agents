# Tennis Elo snapshot data (manual refresh)

This directory documents the **manual, local, license-aware** tennis-elo snapshot
pipeline. There is no downloader, no bundled third-party data, and no network
access: the snapshot is built from a CSV **you** supply, and the JSON snapshot
is written where **you** point it — by default outside the repo, under the local
state dir (`SSB_RATINGS_DIR`, default `~/.ssb-for-agents/`).

- Importer: [`../tennis-elo-data.js`](../tennis-elo-data.js) (`importMatchData`)
- Engine: [`../tennis-elo.js`](../tennis-elo.js) (pure chronological surface-aware Elo)
- CLI: [`../../scripts/refresh-tennis-elo.js`](../../scripts/refresh-tennis-elo.js)
- Runtime lookup: `loadSnapshot()` / `resolvePlayer()` in `../tennis-elo-data.js`

**No startup refresh.** The MCP server never downloads, imports, or rebuilds Elo
data at startup or on any timer. Refreshing is a manual command you run when you
have a new source file.

---

## Quick start

These are **commands, not shipped data** — every placeholder (`<...>`) must be
replaced with your own values:

```bash
node scripts/refresh-tennis-elo.js \
  --input ~/data/tennis-matches.csv \
  --license "CC BY-NC-SA 4.0 (user-verified)" \
  --as-of 2026-08-13 \
  --imported-at 2026-08-14T12:00:00Z \
  --model-version tennis-elo@1.1.0
```

Dry-run first (parses, builds, validates, writes nothing):

```bash
node scripts/refresh-tennis-elo.js \
  --input ~/data/tennis-matches.csv \
  --license "CC BY-NC-SA 4.0 (user-verified)" \
  --as-of 2026-08-13 \
  --imported-at 2026-08-14T12:00:00Z \
  --model-version tennis-elo@1.1.0 --dry-run
```

## Two-step build from raw archives (Sackmann + current-year source)

The refresh CLI consumes the flat importer schema
(`date,tour,surface,winner,loser,status`). If your source is Jeff Sackmann's
`tennis_atp` archive (or a compatible per-year source), use
[`../../scripts/transform-sackmann-elo.js`](../../scripts/transform-sackmann-elo.js)
to produce that schema from the raw per-year files, then refresh:

1. Drop raw per-year ATP files into a data dir named `atp_main_<year>.csv` (main
   tour) and `atp_qual_<year>.csv` (challengers + qualifiers), then transform:

   ```bash
   ELO_DATA_DIR=~/data/tennis-elo node scripts/transform-sackmann-elo.js
   ```

   Writes `combined_atp.csv` (importer schema) into the same data dir. The
   transform canonicalizes case-variant name collisions (e.g. `de Minaur` vs
   `De Minaur` from mixed sources) — required, the importer rejects duplicated
   normalized names otherwise.

2. Refresh:

   ```bash
   node scripts/refresh-tennis-elo.js \
     --input ~/data/tennis-elo/combined_atp.csv \
     --license "CC BY-NC-SA 4.0 (Sackmann tennis_atp; user-verified)" \
     --as-of 2026-08-14 \
     --imported-at 2026-08-14T12:00:00Z \
     --model-version tennis-elo@1.1.0
   ```

---

## CSV schema (exact)

A header row is mandatory. Column names are matched case-insensitively; extra
columns are allowed and ignored. Quoting is RFC-4180-ish: fields containing
commas must be quoted (`"Williams, Serena"`), `""` escapes a literal quote, and
CRLF / LF / CR line endings and a UTF-8 BOM are all accepted.

| Column    | Required | Format / values                                                                                                                                                       |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`    | yes      | `YYYY-MM-DD`. Must be on or before `--as-of` — a row dated after the cutoff is rejected as future-leaking.                                                            |
| `tour`    | yes      | `ATP` or `WTA` (case-insensitive). Any other tour is skipped by the engine with a coverage counter.                                                                   |
| `surface` | yes      | `hard` \| `clay` \| `grass` plus common variants (`hard court`, `clay-court`, `hardcourt`, `indoor`, `red clay`, …). Unknown surfaces update the overall rating only. |
| `winner`  | yes      | Exact player name. Must differ from `loser` (same-player rows are rejected).                                                                                          |
| `loser`   | yes      | Exact player name.                                                                                                                                                    |
| `status`  | yes      | Explicit completion status (see below). A blank/missing status is **skipped**, never assumed completed.                                                               |

### Status values

Only these count as a completed, normal match and update ratings:

`completed`, `finished`, `final`, `ended`

Everything else is **skipped** with an explicit coverage counter (never guessed,
never treated as a result):

- Retirements: `retired`, `ret` — skipped by the engine's default config
  (included only if `allowRetirement` is enabled, which the CLI does not expose)
- Non-results: `walkover`, `wo`, `walk-over`, `default`, `abandoned`,
  `cancelled`, `canceled`, `postponed`, `suspended`, `unknown`, `pending`,
  `scheduled`, `live`, `in-progress`, `interrupted`
- Missing/blank: skipped with a `missing_status` counter

`rowCount` (all parsed rows) therefore differs from `matchCount` (rows the
engine actually processed) whenever rows are skipped.

---

## Provenance and license gate

The snapshot is only as trustworthy as the file you feed it, so the importer is
deliberately bureaucratic:

- `--license` is **required** and recorded verbatim in the manifest. There is no
  "no license" path.
- `--source-url` is **required for any snapshot the ratings layer will consume**,
  and recorded in the manifest. `lib/ratings-sources/tennis-elo.js` refuses a
  manifest without provenance (`missing_provenance`), so a snapshot built
  without it can never yield a single rating; the CLI therefore refuses such a
  build at BUILD time and names the missing field, instead of leaving you to
  discover it later as an `unavailable` row at scan time. Pass `--engine-only`
  to deliberately build a snapshot for the pure Elo engine that the ratings
  layer refuses.
- The exact input bytes are SHA-256-hashed into the manifest as `sourceHash`, so
  a snapshot can be audited against the source file you actually imported.
- `--as-of` and `--imported-at` are supplied by the caller — the importer never
  reads the clock, so timestamps can't silently drift or backdate.
- `--model-version` is required so predictions can be traced to the exact
  algorithm + constants that produced the ratings.
- The snapshot is written atomically (temp file + rename), and parent
  directories are created as needed.
- `--dry-run` passes `write: false` to the importer: it parses, builds, and
  validates without creating a file (not even a temporary one).

Keep the source CSV and its license text alongside the snapshot when you archive
it — the manifest records where it came from, not the data itself.

### Jeff Sackmann / Tennis Abstract data — do NOT redistribute or bundle

If your CSV comes from Jeff Sackmann's match archives (`tennis_atp`,
`tennis_wta`, or Tennis Abstract), that data is licensed **CC BY-NC-SA 4.0** —
non-commercial, attribution required, share-alike. In practice for this project:

- **Do not** commit, bundle, or publish the source CSVs or derived snapshots in
  this repository or the npm package. That is why the default snapshot path is
  `~/.ssb-for-agents/` (outside the repo, and `.ssb-for-agents/` is gitignored)
  and why a repo-local `tennis-elo-snapshot.json` is gitignored too.
- The snapshot you build locally for personal research is fine, but it inherits
  the license — record the attribution and license text (e.g. via `--license`
  and `--source-url`) so the chain of provenance survives.

No bundled third-party data ships with this package, by design.

---

## Snapshot schema

The output JSON has this shape (versioned via `schemaVersion`):

```jsonc
{
  "schemaVersion": 1,
  "modelVersion": "tennis-elo@1.1.0",
  "manifest": {
    "schemaVersion": 1,
    "generator": "ssb-for-agents/lib/tennis-elo-data.js",
    "sourcePath": "/absolute/path/to/input.csv",
    "sourceUrl": "https://…" | null,
    "license": "CC BY-NC-SA 4.0 (user-verified)",
    "asOf": "2026-08-13",
    "importedAt": "2026-08-14T12:00:00Z",
    "modelVersion": "tennis-elo@1.1.0",
    "sourceHash": "<hex digest of the exact input CSV bytes>",
    "rowCount": 123456,     // parsed CSV rows
    "matchCount": 98765,    // rows actually processed by the engine
    "playerCount": 3456
  },
  "players": {
    "ATP": { "<NORMALIZED NAME>": { "name": "…", "overall": 1500, "hard": …, "clay": …, "grass": …, "matches": … } },
    "WTA": { … }
  },
  "aliasIndex": { "ATP": { "<ALIAS>": ["<NORMALIZED NAME>"] }, "WTA": {} },
  "engine": { "constants": { "k": 32, "seed": 1500, … } }
}
```

Player keys and alias keys are `normalizeName()`d (NFKD, diacritics stripped,
whitespace collapsed, uppercased — punctuation such as `,` is preserved, so
`"Djokovic, Novak"` keys as `DJOKOVIC, NOVAK`).

---

## Local snapshot path, the env var, and point-in-time discipline

Runtime lookup (`loadSnapshot()`) resolves the snapshot in this order:

1. an explicit path override passed to `loadSnapshot()`
2. `$SSB_TENNIS_ELO_SNAPSHOT` — the **local snapshot env var**
3. `$SSB_RATINGS_DIR/tennis-elo-snapshot.json`, else
   `~/.ssb-for-agents/tennis-elo-snapshot.json` (default)

The pre-rename `$PP_TENNIS_ELO_SNAPSHOT` / `$PP_RATINGS_DIR` spellings are still
read as a **deprecated fallback**, so an existing shell profile keeps writing and
reading the same file; the `SSB_` names win when both are set.

The refresh CLI's `--output` default follows the same rule. Point both at the
same file and the runtime sees exactly what you last refreshed:

```bash
export SSB_TENNIS_ELO_SNAPSHOT="$HOME/.ssb-for-agents/tennis-elo-snapshot.json"
node scripts/refresh-tennis-elo.js --input ~/data/tennis-matches.csv --license "…" --source-url "…" --as-of … --imported-at … --model-version …
```

A missing or corrupt snapshot degrades to an explicit `{ available: false }`
result at lookup time — it never throws and never fabricates ratings.

**Point-in-time discipline.** Pass `loadSnapshot({ asOf })` with the prediction
or match date: a snapshot whose manifest `asOf` is not **strictly before** that
date is refused with `reason: 'after_cutoff'`. A model may never consume data
newer than the moment it is predicting, so a snapshot dated the same day as the
match is refused too.

---

## CLI reference

```
node scripts/refresh-tennis-elo.js --input <csv> --license <text>
    --as-of <ISO> --imported-at <ISO> --model-version <version>
    --source-url <url> [options]
```

| Flag                        | Required | Meaning                                                                                                                                             |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--input <csv>`             | yes      | Path to the match CSV (schema above).                                                                                                               |
| `--license <text>`          | yes      | Source-data license, recorded verbatim in the manifest.                                                                                             |
| `--as-of <ISO>`             | yes      | Data cutoff `YYYY-MM-DD`; later rows are rejected.                                                                                                  |
| `--imported-at <ISO>`       | yes      | ISO 8601 import timestamp (e.g. `2026-08-14T12:00:00Z`).                                                                                            |
| `--model-version <version>` | yes      | Model version string (e.g. `tennis-elo@1.1.0`).                                                                                                     |
| `--output <json>`           | no       | Snapshot path (default: `$SSB_TENNIS_ELO_SNAPSHOT` or `$SSB_RATINGS_DIR/tennis-elo-snapshot.json` or `~/.ssb-for-agents/tennis-elo-snapshot.json`). |
| `--source-url <url>`        | yes\*    | Source URL, recorded in the manifest. \*Required unless `--engine-only`: the ratings layer refuses a manifest without provenance.                   |
| `--engine-only`             | no       | Build for the pure Elo engine only. Skips the `--source-url` requirement and produces a snapshot the ratings layer refuses (`missing_provenance`).  |
| `--aliases <json>`          | no       | JSON file of explicit aliases, e.g. `{ "ATP": { "Nole": "Novak Djokovic" } }`. Alias targets must exactly match a player in the built ratings.      |
| `--dry-run`                 | no       | Parse/build/validate and print the manifest summary without writing any file.                                                                       |
| `--help`                    | no       | Print usage and exit 0.                                                                                                                             |

Exit codes: `0` success (help, snapshot built, or dry-run validated); `1` usage,
input, or build error — an actionable message goes to stderr with no stack dump
(prefix `DEBUG=1` to see stacks).

On success a JSON summary is printed to stdout (nothing else): `output`,
`sourceHash`, `rows`, `matches`, `players`, `asOf`, `importedAt`, `modelVersion`,
`license`, `sourceUrl`. No secrets or player data are included.

```bash
node scripts/refresh-tennis-elo.js --help   # full usage, all examples
```
