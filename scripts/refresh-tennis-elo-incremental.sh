#!/usr/bin/env bash
# refresh-tennis-elo-incremental.sh — keep the tennis-Elo recent results current
# WITHOUT a browser.
#
# Why this exists: the primary recent source (TennisData season CSV) is walled behind
# Cloudflare. A plain HTTP GET of the downloads page returns 403 and the browser
# challenge does not clear headless, so that source can only be refreshed by hand.
# Nothing was keeping the snapshot fresh, and the scan silently drops rating records
# older than 14 days, so the whole layer went dark on a timer with no warning.
#
# This script feeds Flashscore instead: a headless Playwright capture of the last N
# days (Flashscore's day-arrow walk is hard-capped at 8 days back), merged into the
# importer's schema through the SAME identity resolver the season ingest uses.
#
# Run it daily. Consecutive daily runs overlap by 7 days and the merge dedupes
# against the archive plus the season rows (same pair within +-1 day, because the two
# sources disagree about the date of about 5% of matches), so nothing double-counts
# and coverage stays contiguous.
#
# Prerequisites: python3 with playwright + chromium installed
# (pip3 install playwright && playwright install chromium).
#
# Usage:
#   bash scripts/refresh-tennis-elo-incremental.sh
#   ELO_FS_DAYS=10 AS_OF=2026-09-16 bash scripts/refresh-tennis-elo-incremental.sh

set -euo pipefail
cd "$(dirname "$0")/.."

if ! python3 -c 'import playwright' 2>/dev/null; then
  echo "[elo-incr] ERROR: playwright is not installed for python3." >&2
  echo "[elo-incr]   pip3 install playwright && playwright install chromium" >&2
  exit 1
fi

export ELO_WITH_FLASHSCORE=1
exec bash scripts/refresh-tennis-elo-snapshot.sh
