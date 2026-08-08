#!/usr/bin/env bash
# One line per session, no model involved.
#
# This is the rung-0 part of kaizen: the backlog becomes impossible to forget
# because it greets you, and it costs nothing to do so. It deliberately does not
# open a browser — SessionStart fires for every terminal, scheduled run and
# remote-triggered session, and a dashboard that opens itself all day stops
# being read.
#
# Silence is the correct output when there is nothing worth saying.

set -uo pipefail

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cli="$root/scripts/cli.mjs"

command -v node >/dev/null 2>&1 || exit 0
[ -f "$cli" ] || exit 0

# Never let a slow or broken scan delay a session starting.
if command -v timeout >/dev/null 2>&1; then
  timeout 5s node "$cli" status 2>/dev/null || true
else
  node "$cli" status 2>/dev/null || true
fi

exit 0
