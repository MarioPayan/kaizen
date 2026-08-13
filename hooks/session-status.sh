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

# The weekly pass — the one unattended model run kaizen makes, and the only
# reader `cadence.weekly` ever had. `asks --due` exits 0 only when the configured
# slot has gone by since the last run, so this is a file read on every other
# session. Off unless `asks.enabled` is set; --due answers 1 when it is not.
#
# Stamped before the pass, not after: a pass that cannot run must not retry every
# session forever. Detached, because a session start has no business waiting on a
# model. The spawned session fires this same hook, sees a fresh stamp, and stops
# there — that is what keeps it from recursing.
if node "$cli" asks --due >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
  node "$cli" asks --stamp >/dev/null 2>&1 || true
  prompt="Read $root/skills/kaizen/SKILL.md and follow only its \"Recurring asks\" \
section, against the JSON on stdin. File suggestion files and nothing else — no \
report, no commits, no edits to any skill."
  (node "$cli" asks --json 2>/dev/null | claude -p "$prompt" >/dev/null 2>&1 &) &
fi

exit 0
