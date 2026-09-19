#!/usr/bin/env python3
"""Walk-forward MLB Statcast feature builder (Task 5). Stdlib only.

Reads cached Savant CSV chunks (see mlb-statcast-collect.py) and emits one
feature row per game-team, where every value is derived from PRIOR games only:
all of a calendar day's games are snapshotted before any of that day's pitches
enter rolling state (same bucketing discipline as lib/cfb-pbp-features.js).

MVP feature families (all walk-forward):
- Team rolling batting: xwOBA, K%, BB% (last 20 games)
- Team rolling pitching (xwOBA allowed, last 20 games)
- Starter rolling: K%, BB%, xwOBA allowed, whiff% (last 8 appearances)
- Bullpen workload: non-starter pitches thrown in prior 1/3/7 calendar days
- Park fixed effect: home team abbreviation; days rest is NOT included (no
  schedule-join beyond game dates in this MVP)

Explicitly excluded (no pregame vintage available): confirmed lineups,
forecast weather, season aggregates, current-roster state.

Usage:
    python3 scripts/mlb-statcast-features.py --cache-dir ~/.ssb-for-agents/data/statcast
"""

import argparse
import csv
import datetime as dt
import glob
import json
import os
import sys

REQUIRED_COLUMNS = frozenset(
    [
        "game_date",
        "game_pk",
        "pitcher",
        "batter",
        "events",
        "description",
        "home_team",
        "away_team",
        "inning_topbot",
        "launch_speed",
        "launch_angle",
        "estimated_woba_using_speedangle",
    ]
)

WALKS = frozenset(["walk"])
STRIKEOUTS = frozenset(["strikeout"])
WHIFFS = frozenset(["swinging_strike", "swinging_strike_blocked"])


def finite_float(raw):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN
        return None
    return value


def validate_schema(fieldnames):
    missing = sorted(REQUIRED_COLUMNS - set(fieldnames or []))
    if missing:
        raise ValueError(f"savant CSV missing columns: {missing}")
    return True


def pitching_team_of(row):
    # Top of inning: away bats, home pitches. Bottom: home bats, away pitches.
    return row["home_team"] if (row.get("inning_topbot") or "").strip().lower().startswith("top") else row["away_team"]


def batting_team_of(row):
    return row["away_team"] if (row.get("inning_topbot") or "").strip().lower().startswith("top") else row["home_team"]


def iter_pitches(cache_dir):
    paths = sorted(glob.glob(os.path.join(cache_dir, "raw", "csv", "savant-*.csv")))
    if not paths:
        raise IOError(f"no cached savant chunks in {cache_dir}/raw/csv")
    for file_path in paths:
        with open(file_path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            validate_schema(reader.fieldnames)
            for row in reader:
                if not row.get("game_pk") or not row.get("game_date"):
                    continue
                yield row


def summarize_game(pitches):
    """Aggregate one game's pitches into per-team batting/pitching + starter state."""
    by_team = {}
    order = []

    def team_entry(name):
        if name not in by_team:
            by_team[name] = {
                "pa": 0,
                "k": 0,
                "bb": 0,
                "xwoba_sum": 0.0,
                "xwoba_n": 0,
                "hard_hit": 0,
                "barrel": 0,
                "whiffs": 0,
                "swings": 0,
                "allowed_pa": 0,
                "allowed_k": 0,
                "allowed_bb": 0,
                "allowed_xwoba_sum": 0.0,
                "allowed_xwoba_n": 0,
                "pitchers": {},
            }
        return by_team[name]

    for row in pitches:
        bat = batting_team_of(row)
        pit = pitching_team_of(row)
        event = (row.get("events") or "").strip().lower()
        desc = (row.get("description") or "").strip().lower()
        b_entry = team_entry(bat)
        p_entry = team_entry(pit)
        pitcher = str(row.get("pitcher") or "")
        p_entry["pitchers"].setdefault(pitcher, 0)
        p_entry["pitchers"][pitcher] += 1
        if desc in WHIFFS:
            p_entry["whiffs"] += 1
        if "swing" in desc or "foul" in desc or desc in ("hit_into_play",):
            p_entry["swings"] += 1
        if not event:
            continue
        b_entry["pa"] += 1
        p_entry["allowed_pa"] += 1
        if event in STRIKEOUTS:
            b_entry["k"] += 1
            p_entry["allowed_k"] += 1
        if event in WALKS:
            b_entry["bb"] += 1
            p_entry["allowed_bb"] += 1
        xwoba = finite_float(row.get("estimated_woba_using_speedangle"))
        if xwoba is not None:
            b_entry["xwoba_sum"] += xwoba
            b_entry["xwoba_n"] += 1
            p_entry["allowed_xwoba_sum"] += xwoba
            p_entry["allowed_xwoba_n"] += 1
        velo = finite_float(row.get("launch_speed"))
        angle = finite_float(row.get("launch_angle"))
        if velo is not None and velo >= 95:
            b_entry["hard_hit"] += 1
        if velo is not None and angle is not None and velo >= 98 and 10 <= angle <= 32:
            b_entry["barrel"] += 1
        order.append(pitcher)
    starters = {}
    seen = set()
    for row in pitches:
        pit = pitching_team_of(row)
        pitcher = str(row.get("pitcher") or "")
        if (pit, pitcher) not in seen:
            seen.add((pit, pitcher))
            starters.setdefault(pit, pitcher)
    return by_team, starters


class Rolling:
    def __init__(self, max_games):
        self.max_games = max_games
        self.games = []

    def add(self, values):
        self.games.append(values)
        if len(self.games) > self.max_games:
            self.games.pop(0)

    def rate(self, numerator, denominator):
        num = sum(g.get(numerator, 0) for g in self.games)
        den = sum(g.get(denominator, 0) for g in self.games)
        return num / den if den else None

    def mean(self, total_key, count_key):
        num = sum(g.get(total_key, 0) for g in self.games)
        den = sum(g.get(count_key, 0) for g in self.games)
        return num / den if den else None


def snapshot_team(team_state, starter_state):
    bat = team_state["bat"]
    pit = team_state["pit"]
    sp = starter_state
    return {
        "teamBatXwoba20": bat.mean("xwoba_sum", "xwoba_n"),
        "teamBatKRate20": bat.rate("k", "pa"),
        "teamBatBBRate20": bat.rate("bb", "pa"),
        "teamPitXwobaAllowed20": pit.mean("allowed_xwoba_sum", "allowed_xwoba_n"),
        "starterKRate8": sp.mean("k", "pa"),
        "starterBBRate8": sp.mean("bb", "pa"),
        "starterXwobaAllowed8": sp.mean("xwoba_sum", "xwoba_n"),
        "starterWhiffRate8": sp.mean("whiffs", "swings"),
        "teamBatGames": len(bat.games),
        "starterGames": len(sp.games),
    }


def build_features(cache_dir):
    games = {}
    for row in iter_pitches(cache_dir):
        key = (row["game_date"], str(row["game_pk"]))
        games.setdefault(key, {"date": row["game_date"], "pk": str(row["game_pk"]), "pitches": []})
        games[key]["pitches"].append(row)
    ordered_keys = sorted(games.keys())
    dates = sorted({key[0] for key in ordered_keys})

    team_state = {}
    starter_state = {}
    bullpen_log = []  # (date, pitches) non-starter pitches per team per game
    features = []

    def state_for(team):
        return team_state.setdefault(team, {"bat": Rolling(20), "pit": Rolling(20)})

    for day in dates:
        day_keys = [key for key in ordered_keys if key[0] == day]
        day_summaries = []
        for key in day_keys:
            game = games[key]
            by_team, starters = summarize_game(game["pitches"])
            first = game["pitches"][0]
            day_summaries.append((game, by_team, starters, first))
            for team in by_team:
                state_for(team)
                if by_team[team]["pitchers"]:
                    starter = starters.get(team)
                    if starter:
                        starter_state.setdefault((team, starter), Rolling(8))
        for game, by_team, starters, first in day_summaries:
            home = first["home_team"]
            away = first["away_team"]
            day_date = dt.date.fromisoformat(day)
            workload = {}
            for team in by_team:
                pitches_1 = sum(p for d, t, p in bullpen_log if t == team and (day_date - d).days in (1,))
                pitches_3 = sum(p for d, t, p in bullpen_log if t == team and 1 <= (day_date - d).days <= 3)
                pitches_7 = sum(p for d, t, p in bullpen_log if t == team and 1 <= (day_date - d).days <= 7)
                workload[team] = {"bp1": pitches_1, "bp3": pitches_3, "bp7": pitches_7}
            for team, is_home in ((home, True), (away, False)):
                entry = by_team.get(team, {})
                starter = starters.get(team)
                row = {
                    "game_pk": game["pk"],
                    "game_date": day,
                    "team": team,
                    "opponent": away if is_home else home,
                    "is_home": is_home,
                    "park": home,
                    "starter": starter,
                    **snapshot_team(state_for(team), starter_state.get((team, starter), Rolling(8))),
                    "bullpenPitches1d": workload.get(team, {}).get("bp1", 0),
                    "bullpenPitches3d": workload.get(team, {}).get("bp3", 0),
                    "bullpenPitches7d": workload.get(team, {}).get("bp7", 0),
                }
                features.append(row)
        for game, by_team, starters, first in day_summaries:
            day_date = dt.date.fromisoformat(day)
            for team, entry in by_team.items():
                state = state_for(team)
                state["bat"].add(
                    {"xwoba_sum": entry["xwoba_sum"], "xwoba_n": entry["xwoba_n"], "k": entry["k"], "bb": entry["bb"], "pa": entry["pa"]}
                )
                state["pit"].add(
                    {
                        "allowed_xwoba_sum": entry["allowed_xwoba_sum"],
                        "allowed_xwoba_n": entry["allowed_xwoba_n"],
                        "k": entry["allowed_k"],
                        "bb": entry["allowed_bb"],
                        "pa": entry["allowed_pa"],
                    }
                )
                starter = starters.get(team)
                if starter:
                    sp_rolls = starter_state.setdefault((team, starter), Rolling(8))
                    sp_allowed = {
                        "k": 0,
                        "bb": 0,
                        "pa": 0,
                        "xwoba_sum": 0.0,
                        "xwoba_n": 0,
                        "whiffs": 0,
                        "swings": 0,
                    }
                    for row in game["pitches"]:
                        if str(row.get("pitcher") or "") != starter or pitching_team_of(row) != team:
                            continue
                        event = (row.get("events") or "").strip().lower()
                        desc = (row.get("description") or "").strip().lower()
                        if desc in WHIFFS:
                            sp_allowed["whiffs"] += 1
                        if "swing" in desc or "foul" in desc or desc in ("hit_into_play",):
                            sp_allowed["swings"] += 1
                        if not event:
                            continue
                        sp_allowed["pa"] += 1
                        if event in STRIKEOUTS:
                            sp_allowed["k"] += 1
                        if event in WALKS:
                            sp_allowed["bb"] += 1
                        xwoba = finite_float(row.get("estimated_woba_using_speedangle"))
                        if xwoba is not None:
                            sp_allowed["xwoba_sum"] += xwoba
                            sp_allowed["xwoba_n"] += 1
                    sp_rolls.add(sp_allowed)
                    non_starter = sum(count for pid, count in entry["pitchers"].items() if pid != starter)
                else:
                    non_starter = sum(entry["pitchers"].values())
                bullpen_log.append((day_date, team, non_starter))
    return features


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build walk-forward Statcast features")
    parser.add_argument("--cache-dir", default=os.path.join(os.path.expanduser("~"), ".ssb-for-agents", "data", "statcast"))
    parser.add_argument("--out", default=None)
    options = parser.parse_args(argv)
    features = build_features(options.cache_dir)
    out = options.out or os.path.join(options.cache_dir, "features.jsonl")
    with open(out, "w", encoding="utf-8") as handle:
        for row in features:
            handle.write(json.dumps(row) + "\n")
    print(f"wrote {len(features)} game-team rows to {out}")
    return features


if __name__ == "__main__":
    main(sys.argv[1:])
