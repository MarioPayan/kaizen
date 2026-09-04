#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: proposal-worktree.sh <repo>" >&2
  echo "       proposal-worktree.sh --self-check" >&2
}

create_worktree() {
  local repo="$1" root worktree
  root="$(mktemp -d "${TMPDIR:-/tmp}/kaizen-wt.XXXXXX")"
  worktree="$root/tree"

  if ! git -C "$repo" worktree add --detach "$worktree" HEAD >/dev/null; then
    rm -rf "$root"
    return 1
  fi

  printf '%s\n' "$worktree"
}

self_check() {
  local script
  SELF_CHECK_TMP="$(mktemp -d)"
  SELF_CHECK_REPO="$SELF_CHECK_TMP/repo"
  script="$(realpath "$0")"
  SELF_CHECK_FIRST=""
  SELF_CHECK_SECOND=""

  cleanup() {
    [[ -z "$SELF_CHECK_FIRST" ]] || git -C "$SELF_CHECK_REPO" worktree remove --force "$SELF_CHECK_FIRST" 2>/dev/null || true
    [[ -z "$SELF_CHECK_SECOND" ]] || git -C "$SELF_CHECK_REPO" worktree remove --force "$SELF_CHECK_SECOND" 2>/dev/null || true
    rm -rf "$SELF_CHECK_TMP"
  }
  trap cleanup EXIT

  git init -q "$SELF_CHECK_REPO"
  git -C "$SELF_CHECK_REPO" config user.email kaizen@example.invalid
  git -C "$SELF_CHECK_REPO" config user.name kaizen
  printf 'base\n' >"$SELF_CHECK_REPO/tracked.txt"
  git -C "$SELF_CHECK_REPO" add tracked.txt
  git -C "$SELF_CHECK_REPO" commit -qm base

  SELF_CHECK_FIRST="$("$script" "$SELF_CHECK_REPO")"
  SELF_CHECK_SECOND="$("$script" "$SELF_CHECK_REPO")"
  test "$SELF_CHECK_FIRST" != "$SELF_CHECK_SECOND"
  test -d "$SELF_CHECK_FIRST"
  test -d "$SELF_CHECK_SECOND"
  test "$(git -C "$SELF_CHECK_FIRST" rev-parse HEAD)" = "$(git -C "$SELF_CHECK_REPO" rev-parse HEAD)"
  test "$(git -C "$SELF_CHECK_SECOND" rev-parse HEAD)" = "$(git -C "$SELF_CHECK_REPO" rev-parse HEAD)"
  echo PASS
}

if [[ "${1:-}" == "--self-check" ]]; then
  self_check
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

create_worktree "$1"
