#!/bin/bash
# Rebuild the local tennis-Elo snapshot end to end.
#
#   transform #1 (archives)          ->  combined_archives.csv
#   ingest (TennisData season CSV)   ->  recent_results.csv
#   transform #2 (archives + recent) ->  combined_all.csv
#   refresh pass 1                   ->  snapshot (no aliases)
#   alias map from that snapshot     ->  tennis-elo-aliases.json
#   refresh pass 2 (--aliases)       ->  snapshot (final)
#
# Why two transforms: the ingest's duplicate check must run against the
# ARCHIVES-ONLY file. Deduping against the merged file makes every previously
# ingested recent row look like an archive duplicate and silently drops it on the
# next rebuild.
#
# Why two refresh passes: the alias generator derives each surname from the BUILT
# ratings, so an alias can never point at a player the importer does not know (the
# importer throws on an unknown target). Pass 1 is what the generator reads.
#
# The season CSVs are NOT downloaded here - that step needs a solved Cloudflare
# Turnstile token, which only a real browser session provides. Refresh them with
# the ego-browser flow documented in scripts/ingest-tennisdata-season.js, then run
# this script. Missing CSVs are a hard error, not a silent no-op.
#
# Point-in-time: AS_OF defaults to YESTERDAY, so a snapshot never contains a result
# from the day it is used to price.
#
# Usage:
#   bash scripts/refresh-tennis-elo-snapshot.sh
#   AS_OF=2026-09-16 bash scripts/refresh-tennis-elo-snapshot.sh

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

DATA_DIR="${ELO_DATA_DIR:-$HOME/data/tennis-elo}"
AS_OF="${AS_OF:-$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)}"
IMPORTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATE_DIR="${SSB_RATINGS_DIR:-$HOME/.ssb-for-agents}"
SNAPSHOT="${SSB_TENNIS_ELO_SNAPSHOT:-$STATE_DIR/tennis-elo-snapshot.json}"
ALIASES="${SSB_TENNIS_ELO_ALIASES:-$STATE_DIR/tennis-elo-aliases.json}"
SURFACE_MAP="${SSB_TENNIS_SURFACE_MAP:-$STATE_DIR/tennis-surface-map.json}"
LICENSE="CC BY-NC-SA 4.0 (Jeff Sackmann archives via Aneeshers mirror; TennisData.app season CSV + Flashscore results; user-verified)"
SOURCE_URL="https://tennisdata.app/downloads/"

# The headless incremental (scripts/refresh-tennis-elo-incremental.sh) drops its
# deduped output here. It is optional: without it the season CSV is the only recent
# source. The transform concatenates both and never re-canonicalizes either.
ELO_RECENT_FS_FILE="$DATA_DIR/recent_results_fs.csv"
if [ -f "$ELO_RECENT_FS_FILE" ]; then
  export ELO_RECENT_FS="$ELO_RECENT_FS_FILE"
  echo "[elo] incremental overlay: $ELO_RECENT_FS_FILE"
fi

echo "[elo] as-of=$AS_OF data=$DATA_DIR"

SEASON_INPUTS=()
for f in "$DATA_DIR"/td-wta-*.csv "$DATA_DIR"/td-atp-*.csv; do
  [ -e "$f" ] || continue
  SEASON_INPUTS+=(--input "$f")
done
if [ ${#SEASON_INPUTS[@]} -eq 0 ]; then
  echo "[elo] ERROR: no td-{wta,atp}-*.csv season files in $DATA_DIR" >&2
  echo "[elo] Refresh them from https://tennisdata.app/downloads/ via the ego-browser flow first." >&2
  exit 1
fi

refresh_snapshot() {
  node scripts/refresh-tennis-elo.js \
    --input "$DATA_DIR/combined_all.csv" \
    --license "$LICENSE" \
    --source-url "$SOURCE_URL" \
    --as-of "$AS_OF" \
    --imported-at "$IMPORTED_AT" \
    --model-version tennis-elo@1.1.0 \
    "$@" \
    --output "$SNAPSHOT"
}

echo "[elo] 1/6 transform (archives only)"
node scripts/transform-sackmann-elo.js > '/dev/null'

echo "[elo] 2/6 ingest season CSV (${#SEASON_INPUTS[@]} arg(s))"
node scripts/ingest-tennisdata-season.js \
  "${SEASON_INPUTS[@]}" \
  --archive "$DATA_DIR/combined_archives.csv" \
  --out "$DATA_DIR/recent_results.csv" \
  --surface-map "$SURFACE_MAP" \
  --as-of "$AS_OF"

# Headless incremental. Runs AFTER the season ingest so the Flashscore rows are
# deduped against the freshest baseline (every run regenerates recent_results.csv
# from the season CSV), and BEFORE the transform so ELO_RECENT_FS is picked up.
# Set ELO_WITH_FLASHSCORE=1 (or use scripts/refresh-tennis-elo-incremental.sh).
if [ "${ELO_WITH_FLASHSCORE:-0}" = "1" ]; then
  FS_DAYS="${ELO_FS_DAYS:-8}"
  FS_CAPTURE="$DATA_DIR/flashscore-capture.json"
  echo "[elo] 2b/6 capture Flashscore results (${FS_DAYS}d, headless)"
  python3 scripts/flashscore-results.py --days "$FS_DAYS" --out "$FS_CAPTURE"
  echo "[elo] 2c/6 merge Flashscore results -> $ELO_RECENT_FS_FILE"
  node scripts/merge-tennis-results.js \
    --results "$FS_CAPTURE" \
    --archive "$DATA_DIR/combined_archives.csv" \
    --existing "$DATA_DIR/recent_results.csv" \
    --out "$ELO_RECENT_FS_FILE" \
    --surface-map "$SURFACE_MAP" \
    --as-of "$AS_OF"
  # Export here too: on the very first incremental run the file did not exist at the
  # top of this script, so the transform would otherwise ignore it for one run.
  export ELO_RECENT_FS="$ELO_RECENT_FS_FILE"
fi

echo "[elo] 3/6 transform (archives + recent)"
node scripts/transform-sackmann-elo.js

echo "[elo] 4/6 refresh pass 1 (no aliases)"
refresh_snapshot

echo "[elo] 5/6 alias map"
node scripts/build-tennis-elo-alias-map.js --snapshot "$SNAPSHOT" --out "$ALIASES"

echo "[elo] 6/6 refresh pass 2 (with aliases)"
refresh_snapshot --aliases "$ALIASES"

echo "[elo] done: $SNAPSHOT (asOf $AS_OF)"
