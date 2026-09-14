# Installation

SSB MCP is a Model Context Protocol server plus a setup CLI. The npm package is not currently published, so the supported install path is from the GitHub repository.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- A [PropProfessor](https://propprofessor.com) account with valid credentials — the free tier is enough (see the auth section in [README.md](README.md))

## Install from source

```bash
git clone https://github.com/jbdrak/ssb-for-agents.git
cd ssb-for-agents
npm ci
npm link
```

This exposes the canonical `ssb`, `ssb-mcp`, `ssb-query`, and `ssb-backtest` binaries, plus the original `pp`, `pp-mcp`, `pp-query`, and `pp-backtest` names. Both name sets are identical — `ssb` and `pp` are the same CLI.

## First-run setup

```bash
ssb-query login
```

This stores your PropProfessor session locally under `~/.ssb-for-agents/` (auth files are written with owner-only permissions). Logging in is a one-time, manual action — there is no automated login or scheduled polling.

## Verify the install

```bash
ssb-mcp --help
ssb-query doctor
```

`ssb-query doctor` checks that your local auth state is valid without making a live PropProfessor request. The `pp-mcp` / `pp-query` names behave identically.

## MCP client configuration

Point your MCP client at the `ssb-mcp` binary (stdio transport). For example, a Claude-style client config entry:

```json
{
  "mcpServers": {
    "ssb": {
      "command": "ssb-mcp",
      "args": []
    }
  }
}
```

## Manual-only guarantee

SSB endpoints are manual-only. The package contains no cron jobs, scheduled workflows, or unattended pollers. Snapshot/backtest capture and all live queries require an explicit user-triggered command; see [BACKTESTING.md](docs/BACKTESTING.md) for the `--live` acknowledgment requirement.

## Uninstall

```bash
npm unlink -g ssb-for-agents   # for a clone install done with `npm link`
```

Local data under `~/.ssb-for-agents/` is left in place.

## Troubleshooting

- `ssb-query doctor` reports an auth problem → re-run `ssb-query login`.
- `ssb-mcp` fails to start → confirm the binary is on your PATH (a clone install exposes it via `npm link`).
- Any other issue → open a GitHub issue on the repository.

See [README.md](README.md) for the full user guide and [CHANGELOG.md](CHANGELOG.md) for release history.
