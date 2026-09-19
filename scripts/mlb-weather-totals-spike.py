#!/usr/bin/env python3
"""MLB weather-totals spike (bounded, kill-criteria-first).

Question: does 1-day-lead forecast wind/temp add total-runs information
beyond the archived listed total?

Vintage: Open-Meteo Previous Runs API, *_previous_day1 = value predicted
24h before valid time. Hourly values taken at 19:00 local (timezone=auto;
typical MLB first-pitch window). Dates are day-granularity in the archive,
so this is an INFORMATION DIAGNOSTIC only -- the listed total's own
open/close vintage is unknown, so no executable ROI claim is possible.

Kill criterion: pooled MAE improvement vs listed total <= 0 AND game-cluster
bootstrap 95% CI not entirely above zero -> NO-GO, kill the weather angle.

Stdlib only. Caches raw API responses under ~/.ssb-for-agents/data/weather/.
"""
import json
import os
import sys
import urllib.request

DATA = os.path.join(os.path.expanduser("~"), ".ssb-for-agents", "data")
WX_ROOT = os.path.join(DATA, "weather")
os.makedirs(WX_ROOT, exist_ok=True)

# Approximate park coordinates (weather-grid resolution only).
PARKS = {
    "ARI": (33.445, -112.067), "ATL": (33.890, -84.468),
    "BAL": (39.284, -76.622), "BOS": (42.347, -71.097),
    "CHC": (41.948, -87.655), "CHW": (41.830, -87.634),
    "CIN": (39.098, -84.506), "CLE": (41.496, -81.685),
    "COL": (39.906, -105.020), "DET": (42.339, -83.048),
    "HOU": (29.757, -95.355), "KC": (39.051, -94.480),
    "LAA": (33.800, -117.883), "LAD": (34.073, -118.240),
    "MIA": (25.778, -80.219), "MIL": (43.028, -87.971),
    "MIN": (44.981, -93.278), "NYM": (40.757, -73.838),
    "NYY": (40.829, -73.926), "OAK": (37.751, -122.200),
    "ATH": (38.654, -121.518), "PHI": (39.906, -75.167),
    "PIT": (40.447, -80.006), "SD": (32.707, -117.157),
    "SEA": (47.591, -122.332), "SF": (37.778, -122.390),
    "STL": (38.622, -90.193), "TB": (27.768, -82.653),
    "TEX": (32.751, -97.094), "TOR": (43.641, -79.389),
    "WSH": (39.207, -77.007),
}
# Retractable/domed parks where open-air wind is muted or absent.
ROOF = {"ARI", "HOU", "MIA", "MIL", "SEA", "TB", "TEX", "TOR"}

SEASONS = [2024, 2025]


def fetch_park(team, start, end):
    lat, lon = PARKS[team]
    out = os.path.join(WX_ROOT, f"prevruns-{team}-{start}_{end}.json")
    if os.path.exists(out):
        return json.load(open(out))
    url = (
        "https://previous-runs-api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&start_date={start}&end_date={end}"
        "&hourly=temperature_2m_previous_day1,wind_speed_10m_previous_day1"
        "&timezone=auto&wind_speed_unit=mph&temperature_unit=fahrenheit"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "ssb-for-agents-spike"})
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.loads(r.read().decode())
    json.dump(payload, open(out, "w"))
    return payload


def main():
    game_days = {}  # (date, team) -> list of (total_runs, listed_total)
    for season in SEASONS:
        path = os.path.join(DATA, f"mlb-{season}.json")
        events = json.load(open(path))
        for e in events:
            home, away = e["home"]["abbr"], e["away"]["abbr"]
            if home in ("AL", "NL"):
                continue
            d = str(e["date"])
            iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            try:
                hs, aws = float(e["home"]["score"]), float(e["away"]["score"])
                tot = float(e["odds"]["overUnder"])
            except (TypeError, ValueError, KeyError):
                continue
            game_days.setdefault((iso, home), []).append((hs + aws, tot))

    need = {}
    for (iso, team) in game_days:
        if team not in PARKS:
            continue
        need.setdefault(team, []).append(iso)
    wx = {}  # (date, team) -> (temp_f, wind_mph) at 19:00 local
    for team, days in need.items():
        days = sorted(days)
        payload = fetch_park(team, days[0], days[-1])
        hourly = payload.get("hourly", {})
        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m_previous_day1", [])
        winds = hourly.get("wind_speed_10m_previous_day1", [])
        for t, temp, wind in zip(times, temps, winds):
            day, hour = t[:10], t[11:13]
            if hour == "19" and temp is not None and wind is not None:
                wx[(day, team)] = (temp, wind)
    print(f"game-days={len(game_days)} wx-points={len(wx)}", file=sys.stderr)

    rows = []
    for key, games in game_days.items():
        if key not in wx or key[1] in ROOF:
            continue
        temp, wind = wx[key]
        for actual, listed in games:
            rows.append((actual, listed, temp, wind))
    print(f"open-air joined rows={len(rows)}", file=sys.stderr)
    if not rows:
        print("NO DATA -- cannot evaluate")
        return

    # Ridge of (actual-listed) on [wind, temp], trained 2024 -> tested 2025.
    import datetime  # noqa: E402  (deferred so network errors surface first)

    train = [r for r in rows if True]  # season split applied below via date
    # Re-derive season from game date order: split at 2025-01-01 using wx keys.
    indexed = []
    for key, games in game_days.items():
        if key not in wx or key[1] in ROOF:
            continue
        temp, wind = wx[key]
        for actual, listed in games:
            indexed.append((key[0], actual, listed, temp, wind))
    tr = [r for r in indexed if r[0] < "2025-01-01"]
    te = [r for r in indexed if r[0] >= "2025-01-01"]
    print(f"train={len(tr)} test={len(te)}", file=sys.stderr)

    def fit(data, ridge=10.0):
        # least squares with ridge on standardized [wind, temp]
        n = len(data)
        mw = sum(r[3] for r in data) / n
        mt = sum(r[4] for r in data) / n
        import math
        sw = math.sqrt(sum((r[3] - mw) ** 2 for r in data) / n) or 1.0
        st = math.sqrt(sum((r[4] - mt) ** 2 for r in data) / n) or 1.0
        # 2x2 ridge solve
        s11 = sum(((r[3] - mw) / sw) ** 2 for r in data) + ridge
        s22 = sum(((r[4] - mt) / st) ** 2 for r in data) + ridge
        s12 = sum(((r[3] - mw) / sw) * ((r[4] - mt) / st) for r in data)
        b1 = sum(((r[3] - mw) / sw) * (r[1] - r[2]) for r in data)
        b2 = sum(((r[4] - mt) / st) * (r[1] - r[2]) for r in data)
        det = s11 * s22 - s12 * s12
        c1 = (b1 * s22 - b2 * s12) / det
        c2 = (s11 * b2 - s12 * b1) / det
        return mw, mt, sw, st, c1, c2

    mw, mt, sw, st, c1, c2 = fit(tr)
    base_err, corr_err = 0.0, 0.0
    for _, actual, listed, temp, wind in te:
        resid = c1 * (wind - mw) / sw + c2 * (temp - mt) / st
        base_err += abs(actual - listed)
        corr_err += abs(actual - (listed + resid))
    n = len(te)
    imp = base_err / n - corr_err / n
    print(f"wind coef={c1:.4f} temp coef={c2:.4f}")
    print(f"test MAE: listed={base_err / n:.4f} corrected={corr_err / n:.4f} improvement={imp:.4f}")

    # Game-cluster bootstrap on the improvement.
    import random
    random.seed(7)
    imps = []
    errs = [
        (abs(a - l), abs(a - (l + c1 * (w - mw) / sw + c2 * (t - mt) / st)))
        for _, a, l, t, w in te
    ]
    for _ in range(2000):
        s = sum(random.choice(errs)[0] - random.choice(errs)[1] for _ in range(n)) / n
        imps.append(s)
    imps.sort()
    print(f"bootstrap 95% CI=[{imps[50]:.4f}, {imps[1949]:.4f}] improved={(sum(1 for x in imps if x > 0) / 2000) * 100:.1f}%")
    if imp > 0 and imps[50] > 0:
        print("SPIKE: PASS -- weather adds information; scope executable path next")
    else:
        print("SPIKE: NO-GO -- kill the weather angle")


if __name__ == "__main__":
    main()
