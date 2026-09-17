#!/usr/bin/env python3
"""flashscore-results.py — scrape FINISHED tennis matches (with winner) from Flashscore.

Walks backwards day by day from the real local today and emits one JSON object per
day: { date, matches: [{tour, surface, tournament, category, home, away, homeSlug,
awaySlug, setsHome, setsAway, scoreText, winnerSide, ret}] }.

Score/winner sourcing (verified against the live DOM 2026-09-17):
  - `event__score--home` / `event__score--away` carry SETS WON.
  - the winner's participant div carries the extra class `fontExtraBold`.
  - the row's `a.eventRowLink[href]` slug is `lastname-firstname` and is the only
    place a forename appears, so it is captured for identity reconciliation.
  - `event__stage--block` carries "Finished" / "Retired" / "Walkover" / "Awarded".

Usage:
  python3 scripts/flashscore-results.py --days 3 --out /tmp/fs-results.json
  python3 scripts/flashscore-results.py --days 106 --out ~/data/tennis-elo/flashscore-results.json

Timezone: browser locale is set to America/Chicago, matching the existing
schedule scraper, so day boundaries line up with the rest of the pipeline.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("America/Chicago")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(
        json.dumps({"error": "playwright not installed. Run: pip3 install playwright && playwright install chromium"})
    )
    sys.exit(1)

EXTRACT_JS = r"""() => {
    const containers = Array.from(document.querySelectorAll('.sportName.tennis'));
    if (!containers.length) return { error: 'no container found' };
    const CATEGORY_RE = /(ATP\s*-\s*SINGLES|WTA\s*-\s*SINGLES|ATP\s*-\s*DOUBLES|WTA\s*-\s*DOUBLES|CHALLENGER\s+MEN\s*-\s*SINGLES|CHALLENGER\s+WOMEN\s*-\s*SINGLES|CHALLENGER\s+MEN\s*-\s*DOUBLES|CHALLENGER\s+WOMEN\s*-\s*DOUBLES|ITF\s+MEN\s*-\s*SINGLES|ITF\s+WOMEN\s*-\s*SINGLES|ITF\s+MEN\s*-\s*DOUBLES|ITF\s+WOMEN\s*-\s*DOUBLES)/i;
    const out = [];
    for (const container of containers) {
        let tournament = '', category = '', surface = '', headerText = '';
        for (const el of Array.from(container.children)) {
            const cls = typeof el.className === 'string' ? el.className : '';
            if (cls.includes('headerLeague')) {
                const text = el.textContent.trim();
                headerText = text;
                const m = text.match(CATEGORY_RE);
                category = m ? m[1] : '';
                const catIdx = text.indexOf(category);
                if (catIdx > 0) {
                    tournament = text.substring(0, catIdx).trim().replace(/,\s*(hard|clay|grass|carpet)\s*$/i, '').trim();
                } else {
                    tournament = text.substring(0, 60);
                }
                const sm = text.match(/,\s*(hard|clay|grass|carpet)\b/i);
                surface = sm ? sm[1].toLowerCase() : '';
            } else if (cls.includes('event__match')) {
                const isScheduled = cls.includes('scheduled') || cls.includes('notstarted');
                const isLive = cls.includes('live');
                if (isScheduled || isLive) continue;
                const q = (sel) => { const n = el.querySelector(sel); return n ? (n.textContent || '').trim() : ''; };
                const homeEl = el.querySelector('[class*="event__participant--home"]');
                const awayEl = el.querySelector('[class*="event__participant--away"]');
                if (!homeEl || !awayEl) continue;
                const link = el.querySelector('a.eventRowLink');
                const href = link ? (link.getAttribute('href') || '') : '';
                // Flashscore's URL is /match/tennis/<slug>/<slug>/ and the two slugs do
                // NOT reliably follow the displayed home/away order, so keep them in href
                // order and let the reconciler attach each slug to the participant whose
                // displayed surname it matches.
                const parts = href.split('/').filter(Boolean);
                const tIdx = parts.indexOf('tennis');
                const slugs = tIdx >= 0 ? parts.slice(tIdx + 1).slice(0, 2) : [];
                out.push({
                    stage: q('.event__stage--block'),
                    tournament,
                    category,
                    surface,
                    headerText,
                    home: homeEl.textContent.trim(),
                    away: awayEl.textContent.trim(),
                    homeWinner: /fontExtraBold/.test(homeEl.className),
                    awayWinner: /fontExtraBold/.test(awayEl.className),
                    setsHome: q('.event__score--home'),
                    setsAway: q('.event__score--away'),
                    slugs
                });
            }
        }
    }
    return { matches: out };
}"""


def read_date_strip(page):
    try:
        return page.evaluate(
            """() => {
            const re = new RegExp('[0-9]{2}/[0-9]{2}');
            const els = Array.from(document.querySelectorAll('*')).filter(e => {
                const t = (e.textContent || '').trim();
                return re.test(t) && t.length < 15 && e.childElementCount === 0;
            });
            return els.length ? els[0].textContent.trim() : null;
        }"""
        )
    except Exception:
        return None


def click_prev(page):
    return page.evaluate(
        """() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('aria-label') === 'Previous day'); if (b) { b.click(); return true; } return false; }"""
    )


def stop_click(page):
    # Flashscore opens an interstitial on repeated same-tab navigation; dismiss if present.
    try:
        page.evaluate(
            """() => { const b = document.querySelector('[class*="stop-scrolling"], [class*="continue-button"], button[class*="continue"]'); if (b) b.click(); }"""
        )
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3, help="how many days back from today (inclusive of today)")
    ap.add_argument("--out", default="/tmp/fs-results.json")
    ap.add_argument("--center", default=None, help="ISO date to start from instead of the real today")
    ap.add_argument("--settle-ms", type=int, default=2500)
    args = ap.parse_args()

    today = datetime.now(LOCAL_TZ).date()
    start = datetime.strptime(args.center, "%Y-%m-%d").date() if args.center else today
    # offset from the REAL today, because Flashscore always loads the real today
    back = (today - start).days + args.days - 1

    days = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(locale="en-US", timezone_id="America/Chicago")
        page = ctx.new_page()
        page.goto("https://www.flashscore.com/tennis/", wait_until="networkidle", timeout=60000)
        page.wait_for_selector('[class*="event__match"]', timeout=30000)

        for i in range(back + 1):
            stop_click(page)
            label = read_date_strip(page)
            try:
                res = page.evaluate(EXTRACT_JS)
            except Exception as exc:
                res = {"error": str(exc)}
            days.append({"strip": label, "offset": i, "result": res})
            # Write after every day: a long backfill must not lose 100 days of
            # work because the last page render failed.
            with open(args.out, "w") as fh:
                json.dump({"scrapedAt": datetime.now(LOCAL_TZ).isoformat(), "days": days}, fh)
            if i < back:
                if not click_prev(page):
                    days.append({"error": "no Previous day button"})
                    break
                page.wait_for_timeout(args.settle_ms)
                try:
                    page.wait_for_selector('[class*="event__match"]', timeout=20000)
                except Exception:
                    pass

        browser.close()

    with open(args.out, "w") as fh:
        json.dump({"scrapedAt": datetime.now(LOCAL_TZ).isoformat(), "days": days}, fh)

    total = sum(len(d.get("result", {}).get("matches", []) or []) for d in days)
    print(
        json.dumps(
            {
                "ok": True,
                "days": len(days),
                "matches": total,
                "out": args.out,
                "firstStrip": days[0].get("strip") if days else None,
                "lastStrip": days[-1].get("strip") if days else None,
            }
        )
    )


if __name__ == "__main__":
    main()
