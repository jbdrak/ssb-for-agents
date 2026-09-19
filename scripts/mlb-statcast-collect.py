#!/usr/bin/env python3
"""Bounded historical MLB Statcast collector (Task 5).

Downloads Baseball Savant pitch-level CSV in bounded date chunks plus the MLB
Stats API schedule, caching raw files outside the repo under
~/.ssb-for-agents/data/statcast/. Stdlib only.

Timestamp-safety notes:
- Savant rows carry per-pitch game_date/game_pk, so rolling features are always
  derived walk-forward from prior games only. No season aggregates are stored.
- Per-game feed pulls (realized lineups, postgame weather) are deliberately NOT
  collected: the completed-game feed exposes them retroactively, and no
  pre-first-pitch vintage archive was verified. SP identity comes from the game
  feed's probable/actual starter only where needed; rolling SP stats come from
  Savant prior-game aggregation.
- Failed responses are never cached: partial files are deleted, non-200 and
  empty bodies raise after retries.

Usage:
    python3 scripts/mlb-statcast-collect.py --start 2024-06-01 --end 2024-06-14
    python3 scripts/mlb-statcast-collect.py --start 2023-03-30 --end 2025-11-01 --chunk-days 7
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

SAVANT_URL = "https://baseballsavant.mlb.com/statcast_search/csv"
SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule"
USER_AGENT = "ssb-for-agents research collector (contact: repo jbdrak/ssb-for-agents)"
MAX_RETRIES = 4
TIMEOUT_S = 120


def data_root():
    return os.path.join(os.path.expanduser("~"), ".ssb-for-agents", "data", "statcast")


def chunk_ranges(start, end, chunk_days):
    day = start
    while day <= end:
        chunk_end = min(day + dt.timedelta(days=chunk_days - 1), end)
        yield day, chunk_end
        day = chunk_end + dt.timedelta(days=1)


def savant_params(chunk_start, chunk_end):
    return {
        "all": "true",
        "type": "details",
        "game_date_gt": (chunk_start - dt.timedelta(days=1)).isoformat(),
        "game_date_lt": (chunk_end + dt.timedelta(days=1)).isoformat(),
        "min_pitches": "0",
        "min_results": "0",
        "group_by": "name",
        "sort_col": "pitches",
        "player_type": "pitcher",
        "sort_order": "desc",
    }


def fetch(url, dest, label):
    """GET url to dest with retries. Returns bytes written. Never leaves partial files."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"  skip {label} (cached {os.path.getsize(dest)} bytes)")
        return os.path.getsize(dest)
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                if resp.status != 200:
                    raise IOError(f"HTTP {resp.status}")
                body = resp.read()
            if not body or len(body) < 100:
                raise IOError(f"suspiciously small body ({len(body) if body else 0} bytes)")
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dest)
            print(f"  saved {label} ({len(body)} bytes)")
            return len(body)
        except Exception as exc:  # noqa: BLE001 - retry loop, reported below
            last_error = exc
            print(f"  attempt {attempt}/{MAX_RETRIES} failed for {label}: {exc}")
            part = dest + ".part"
            if os.path.exists(part):
                os.remove(part)
            time.sleep(2**attempt)
    raise IOError(f"gave up on {label}: {last_error}")


def collect_savant(start, end, chunk_days, raw_csv):
    total = 0
    chunks = list(chunk_ranges(start, end, chunk_days))
    print(f"savant: {len(chunks)} chunks of up to {chunk_days}d from {start} to {end}")
    for chunk_start, chunk_end in chunks:
        name = f"savant-{chunk_start.isoformat()}_{chunk_end.isoformat()}.csv"
        dest = os.path.join(raw_csv, name)
        query = urllib.parse.urlencode(savant_params(chunk_start, chunk_end))
        total += fetch(f"{SAVANT_URL}?{query}", dest, name)
    return total


def collect_schedule(start, end, raw_json):
    seasons = sorted({d.year for d in (start, end)})
    # MLB regular seasons span one calendar year; cover each touched year fully.
    total = 0
    print(f"schedule: seasons {seasons}")
    for season in seasons:
        name = f"schedule-{season}.json"
        dest = os.path.join(raw_json, name)
        params = urllib.parse.urlencode(
            {"sportId": 1, "season": season, "startDate": f"{season}-02-01", "endDate": f"{season}-11-30"}
        )
        total += fetch(f"{SCHEDULE_URL}?{params}", dest, name)
    return total


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Collect Statcast + schedule cache")
    parser.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--end", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--chunk-days", type=int, default=7)
    parser.add_argument("--skip-savant", action="store_true")
    parser.add_argument("--skip-schedule", action="store_true")
    options = parser.parse_args(argv)
    start = dt.date.fromisoformat(options.start)
    end = dt.date.fromisoformat(options.end)
    if start > end:
        parser.error("--start must not be after --end")
    if options.chunk_days <= 0:
        parser.error("--chunk-days must be positive")
    return options, start, end


def main(argv=None):
    options, start, end = parse_args(argv or sys.argv[1:])
    root = data_root()
    raw_csv = os.path.join(root, "raw", "csv")
    raw_json = os.path.join(root, "raw", "json")
    os.makedirs(raw_csv, exist_ok=True)
    os.makedirs(raw_json, exist_ok=True)
    bytes_csv = collect_savant(start, end, options.chunk_days, raw_csv) if not options.skip_savant else 0
    bytes_json = collect_schedule(start, end, raw_json) if not options.skip_schedule else 0
    manifest = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "chunk_days": options.chunk_days,
        "bytes_csv": bytes_csv,
        "bytes_json": bytes_json,
    }
    with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"done: csv={bytes_csv} schedule={bytes_json} root={root}")
    return manifest


if __name__ == "__main__":
    main()
