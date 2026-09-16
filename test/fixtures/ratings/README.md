# Ratings source fixtures

Captured third-party payloads that pin the external-ratings adapters to a
vendor's **real bytes**. A synthetic row array shaped the way the parser expects
proves nothing: it stays green while the live parser is dead. Each file here is
either a verbatim capture of a public page or, where noted, a derived
reconstruction of a documented benchmark.

Nothing here is a bundled dataset. These are test inputs for a parser, and the
runtime snapshots still land under `SSB_RATINGS_DIR`
(default `~/.ssb-for-agents/ratings/`, with the pre-rename `PP_RATINGS_DIR` kept
as a deprecated fallback), never in the repo.

## Sagarin - captured live pages

Fetched **2026-09-16** over plain HTTP from `http://sagarin.com/sports/<page>`
with a browser user-agent. Byte-faithful bodies (CRLF preserved); no trimming of
the row content. HTML fixtures are excluded from Prettier via
`test/fixtures/**/*.html` so the captured bytes are never reformatted.

| File                            | Page          | sha256 (first 12) | Page's own `asOf` | Numbered rows | Prediction-block rows |
| ------------------------------- | ------------- | ----------------- | ----------------- | ------------- | --------------------- |
| `sagarin-ncaaf-2026-09-16.html` | `cfsend.htm`  | `7473160f4647`    | 2026-09-12        | 972           | 119                   |
| `sagarin-nfl-2026-09-16.html`   | `nflsend.htm` | `ad548bd0d29c`    | 2026-09-14        | 136           | 16                    |
| `sagarin-nba-2026-09-16.html`   | `nbasend.htm` | `7d8bb82ef28d`    | 2026-06-13        | 84            | 2                     |
| `sagarin-ncaab-2026-09-16.html` | `cbsend.htm`  | `7e211c248232`    | 2023-04-03        | 66            | 0                     |
| `sagarin-nhl-2026-09-16.html`   | `nhlsend.htm` | `dd2b1796c3d2`    | 2026-06-14        | 79            | 1                     |
| `sagarin-mls-2026-09-16.html`   | `soccer.htm`  | `96730d73cf7e`    | 2024-12-07        | 64            | 0                     |

"Numbered rows" counts every line on the page that starts with a row index -
across the ratings table, the per-division repeats, the prediction block and the
EIGENVECTOR table. It is a **diagnostic**, never a record-count target: NBA's
page shows 84 numbered rows for a 30-team league because each team is printed
again in its division sub-table. The adapter's `pageCandidateRows` /
`blockCandidateRows` / `teamCandidateRows` fields expose that split. (On NCAAB
the diagnostic counts fewer lines than the table holds, because its team rows are
`<font>`-wrapped and so do not start with their index - another reason it is a
diagnostic and never a target.)

Two conditions in this set are genuine and must not be "fixed":

- **NBA / NHL** are finals pages - their prediction blocks hold only the
  last series' matchup (2 and 1 rows).
- **NCAAB / MLS** are frozen final-ratings pages with **no** prediction rows at
  all. Their headings are years old (2023-04-03 / 2024-12-07), which is why the
  refresh summary prints `age=<n>d` and `stale=true`.

Both of the page's sections are normalized (decision 2026-09-16, see
`docs/research/external-ratings-sources-2026-09.md`, "Sagarin per-team RATINGS
table: decision and landed behaviour"), so **every** capture yields records -
the four conditions above included, from their per-team RATINGS tables. What the
adapter emits per capture today:

| League | Prediction-block records | RATINGS-table records | Total | Unresolved teams |
| ------ | ------------------------ | --------------------- | ----- | ---------------- |
| NCAAF  | 119                      | 266                   | 385   | 1                |
| NFL    | 16                       | 32                    | 48    | 0                |
| NBA    | 2                        | 30                    | 32    | 0                |
| NHL    | 1                        | 32                    | 33    | 0                |
| NCAAB  | 0                        | 363                   | 363   | 2                |
| MLS    | 0                        | 29                    | 29    | 0                |

Each program is printed twice on every page (the ranked table, then the
per-division/conference repeats); the adapter keeps the first occurrence, so the
"RATINGS-table records" column is half the printed row count. "Unresolved teams"
are programs with no ESPN-published identity to key them to - the correct
fail-closed outcome, not a parse failure. The three remaining are Sagarin's
`UTRGV` (ESPN publishes no football team for UT Rio Grande Valley), `Hartford`
(left D1) and `St. Francis-NY` (the Brooklyn program, athletics discontinued);
every other printing, including Sagarin's FCS football spellings, resolves.

## Massey / Sasser

- `sasser-cfb-2026-w3.html` - captured `https://davidsasser.com/cfb` RSC flight
  stream (the model data is server-rendered; there is no HTML table).
- The `massey-*.csv` files are captured through the adapter's own transport
  (`lib/ratings-sources/massey-web.js`), which is what makes them usable here at
  all: the ratings host 403s plain HTTP, so a bare fetch of the page returns no
  rows. Each is the transport's documented CSV re-emission of the live payload
  (not a verbatim vendor body), i.e. the exact bytes `normalizeMassey` reads in
  production. Fetched **2026-09-16** via `got-scraping`.

| File                          | League | Page's own heading                                      | sha256 (first 12) | Records emitted |
| ----------------------------- | ------ | ------------------------------------------------------- | ----------------- | --------------- |
| `massey-nba-2026-09-16.csv`   | NBA    | `Massey NBA Using games thru Preseason`                 | `f025bb893d94`    | 0               |
| `massey-nhl-2026-09-16.csv`   | NHL    | `Massey NHL Using games thru Preseason`                 | `b396edea8864`    | 0               |
| `massey-ncaab-2026-09-16.csv` | NCAAB  | `Massey NCAAB : NCAA D1 Using games thru Preseason`     | `3f5e05f589f8`    | 0               |
| `massey-ncaaf-2026-09-16.csv` | NCAAF  | `Massey NCAAF : FBS Using games thru Sun, Sep 13, 2026` | `4cb9ae64f46d`    | 138             |

Three of the four are **out of season**, and that is the point of keeping them:
their headings say `Using games thru Preseason` instead of a date, so they carry
no `asOf` at all. The NBA/NHL/NCAAB tables parse perfectly well (30/32/365 team
rows) yet must report `coverage: 'unavailable'` with a preseason reason and
**zero** records, because an undated ratings table can never be snapshotted and
must never be read as current. `massey-ncaaf-2026-09-16.csv` is the dated
positive control: it still yields `coverage: 'full'` with 138 records.

## Derived benchmark

- `sagarin-ncaaf-2026-w2.json` - **synthetic but representative**. Re-encodes the
  verified counts from `docs/research/sagarin-ncaaf-benchmark-2026-09-06.md`
  (which was checked against ESPN's dated scoreboard feeds) so the adapter and
  the shared evaluation module are pinned to real arithmetic. It is a regression
  fixture, not a model estimate; the doc's caveats bind.
