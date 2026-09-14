# Configuration

Environment variables and book configuration for the SSB MCP.

## Environment Variables

| Variable                         | Default                       | Description                                                                                                                                                                     |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_FILE`                      | `~/.ssb-for-agents/auth.json` | Path to the auth file (cookies + tokens)                                                                                                                                        |
| `SSB_MCP_NDJSON`                 | (required)                    | Set to `'true'` to enable NDJSON framing (required for stdio MCP)                                                                                                               |
| `SSB_CACHE_TTL_MS`               | `60000`                       | Response cache TTL in milliseconds                                                                                                                                              |
| `SSB_CACHE_MAX`                  | `50`                          | Max cache entries (LRU eviction)                                                                                                                                                |
| `LOCAL_TIMEZONE`                 | `America/Chicago`             | Display timezone for CLI output                                                                                                                                                 |
| `SSB_DEBUG`                      | (unset)                       | Set to any value to enable debug logging to stderr                                                                                                                              |
| `SSB_MCP_MODE`                   | `lite`                        | Tool surface mode. `lite` (default) exposes the 15 essentials for agent-friendly workflows. `full` exposes all 31 tools for power users.                                        |
| `NITTER_BASE`                    | `http://localhost:8080`       | Nitter instance for `player_context` tweet lookup                                                                                                                               |
| `SSB_MCP_STDIO_COALESCE_MS`      | `0`                           | Batch stdout writes (ms). `0` = passthrough (no change). `1`+ buffers and flushes on a timer. Reduces write syscalls during bursty JSON-RPC responses. Requires server restart. |
| `SSB_CIRCUIT_BREAKER_THRESHOLD`  | `5`                           | Consecutive upstream failures before the circuit opens.                                                                                                                         |
| `SSB_CIRCUIT_BREAKER_TIMEOUT_MS` | `30000`                       | Ms until the circuit transitions open → half-open for a test request.                                                                                                           |

### Advanced tuning

Scan, history, and auth knobs. Defaults are safe — set these only to trade speed against depth.

| Variable                          | Default                                                             | Description                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PP_ODDS_HISTORY_BUDGET`          | `2000`                                                              | Local rolling-window cap (5 minutes) on odds-history requests. Values below 25 are ignored. When exhausted, calls fail fast with no network until the window rolls over. |
| `PP_ODDS_HISTORY_CONCURRENCY`     | `3`                                                                 | Parallel odds-history requests, clamped 1–8. Raising it spends the local budget faster; real upstream 429s still cool down independently.                                |
| `PP_PAIR_TIMEOUT_MS`              | `120000`                                                            | Per-pair timeout for the sharp-plays fan-out.                                                                                                                            |
| `PP_HISTORY_DEADLINE_MS`          | `300000`                                                            | Hydration deadline for a ranked screen (5 minutes). On timeout, rows are returned unhydrated and `resultMeta.historyPartial` is set.                                     |
| `PP_SCAN_DEEP`                    | (unset)                                                             | `1` opts multi-league BET-only scans into deep history hydration. Same as `--deep`.                                                                                      |
| `PP_SCAN_TIMING`                  | (unset)                                                             | `1` prints per-phase scan timings to stderr (`[scan-timing] <phase>=<ms>`).                                                                                              |
| `PP_TODAY_HISTORY_ALLOCATION`     | `300`                                                               | Odds-history calls `pp today` may spend on its composite fan-out. Raise it for a deeper slate, lower it for a faster card. `pp scan` takes the full share.               |
| `SSB_ODDS_HISTORY_LOOKBACK_HOURS` | `6`                                                                 | Hours of odds history fetched when hydrating movement.                                                                                                                   |
| `SSB_CACHE_MAX_ENTRY_SIZE_BYTES`  | `5242880`                                                           | Per-entry response-cache size cap (5 MB). `0` disables the cap.                                                                                                          |
| `SSB_RATE_LIMIT`                  | `25`                                                                | Max MCP tool calls per rate-limit window.                                                                                                                                |
| `SSB_RATE_WINDOW_MS`              | `60000`                                                             | Rate-limit window in milliseconds.                                                                                                                                       |
| `SSB_MCP_DEBUG_NDJSON`            | (unset)                                                             | `true` also enables NDJSON framing — debug/benchmark use, same effect as `SSB_MCP_NDJSON`.                                                                               |
| `PP_NO_EGO_FALLBACK`              | (unset)                                                             | `1` skips the ego-browser fallback in token refresh and goes straight to CDP.                                                                                            |
| `PP_NO_CDP_FALLBACK`              | (unset)                                                             | `1` disables the CDP fallback entirely.                                                                                                                                  |
| `PP_LOGIN_HEADLESS`               | `true`                                                              | The login browser runs headless. Set to `false` to watch the login in a visible window.                                                                                  |
| `PP_RECORD_LEDGER`                | `~/.ssb-for-agents/tracker/ledger.json`                             | Tracker ledger path — the v2 source of truth for official bets.                                                                                                          |
| `PP_PICKS_FILE`                   | `~/.ssb-for-agents/picks.json`                                      | Local picks store.                                                                                                                                                       |
| `PP_CHECKPOINT_FILE`              | `~/.ssb-for-agents/alerts-checkpoint.json`                          | Alert-watchdog checkpoint store.                                                                                                                                         |
| `PP_SIGNAL_CALIBRATION_FILE`      | `~/.ssb-for-agents/signal-calibration.json`                         | Signal-calibration store used by ledger scoring.                                                                                                                         |
| `PP_SPORTS_WATCHLIST_PATH`        | `~/.hermes/skills/pp-sports/references/beat-reporter-watchlists.md` | Optional beat-reporter watchlist markdown. A missing file degrades to an empty watchlist.                                                                                |
| `FLASHSCORE_PYTHON`               | Hermes venv interpreter                                             | Interpreter for the Playwright tennis-schedule scraper. Set only if you need a different one.                                                                            |
| `NO_COLOR`                        | (unset)                                                             | `1` disables ANSI colour in CLI output. Same as `--no-color`.                                                                                                            |

## Book configuration

The MCP uses three book categories. These are passed as parameters to specific tools.

### 1. Target execution books (your betting books)

Books you actually place bets on. Pass to `quick_screen`, `smart_bet`:

```json
{ "targetBooks": ["OnyxOdds", "Fliff", "NoVigApp", "Rebet"] }
```

Target/execution support is separate from default sharp-book comparison: a book listed here (e.g. `OnyxOdds`) is a valid execution target but is not part of any default sharp set (see section 2 and "Default sharp sets" below).

### 2. Sharp comparison books (movement detection)

Books whose line movement signals sharp action. Pass to `quick_screen` (mode='sharp'), `sharp_consensus`, `screen_ranked`:

```json
{ "sharpBooks": ["Pinnacle", "Circa", "BookMaker", "BetOnline"] }
```

### 3. Display books (line shopping)

Books to show in `find_best_price` or `screen_raw`:

```json
{ "books": ["Pinnacle", "FanDuel", "DraftKings", "NoVigApp"] }
```

### Default sharp sets (per sport/market)

Pre-configured in `lib/ssb-sharp-books.js`:

| Sport                               | Main market                                               | Props                                                     |
| ----------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| **NBA**                             | Circa, Pinnacle, BookMaker, BetOnline, DraftKings         | FanDuel, BookMaker, Prop Builder, NoVigApp, Pinnacle      |
| **NFL**                             | Circa, Pinnacle, BookMaker, NoVigApp, FanDuel             | Pinnacle, FanDuel, BookMaker, Circa, BetOnline            |
| **MLB**                             | Pinnacle, Circa, BookMaker, BetOnline, DraftKings, BetMGM | Circa, FanDuel, PropBuilder, Pinnacle, DraftKings, Bet365 |
| **NHL**                             | Pinnacle, Circa, BookMaker, BetOnline, DraftKings         | (same as main)                                            |
| **Soccer, UFC, NCAAB, NCAAF, WNBA** | Pinnacle, Polymarket, Kalshi, BetOnline, Circa            | (same as main)                                            |

## Token compression

For agents that hit context-window limits:

1. Install `caveman-shrink` globally: `npm install -g caveman-shrink`
2. Use it as the command wrapper in your MCP client config:

```yaml
mcp_servers:
  ssb:
    command: caveman-shrink
    args:
      - node
      - /path/to/ssb-for-agents/scripts/ssb-mcp-server.js
    enabled: true
    env:
      AUTH_FILE: /path/to/.ssb-for-agents/auth.json
      SSB_MCP_NDJSON: 'true'
```

Typically cuts token usage 30–50% on large responses with minimal loss of meaning.
