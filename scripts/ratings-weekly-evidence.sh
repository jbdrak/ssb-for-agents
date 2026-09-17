#!/bin/bash
# Cron entrypoint for the weekly SSB ratings evidence loop.
#
# The cron scheduler runs .sh/.bash with bash and hands everything else to Python,
# so a JS entrypoint has to be reached through a shell wrapper. The `/` allows an
# absolute or workdir-relative path to be passed through the cron payload.
#
# workdir is set on the cron job, so this resolves from the repo root; the explicit
# cd keeps the script correct when run by hand from anywhere.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
exec node scripts/ratings-weekly-evidence.js "$@"
