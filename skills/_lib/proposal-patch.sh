#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: proposal-patch.sh <output.patch> [new-path ...]" >&2
  echo "       proposal-patch.sh --self-check" >&2
}

self_check() {
  local tmp repo patch script
  tmp="$(mktemp -d)"
  SELF_CHECK_TMP="$tmp"
  repo="$tmp/repo"
  patch="$tmp/proposal.patch"
  script="$(realpath "$0")"
  trap 'rm -rf "$SELF_CHECK_TMP"' EXIT

  git init -q "$repo"
  git -C "$repo" config user.email kaizen@example.invalid
  git -C "$repo" config user.name kaizen
  printf 'before\n' >"$repo/tracked.txt"
  git -C "$repo" add tracked.txt
  git -C "$repo" commit -qm base

  printf 'after\n' >"$repo/tracked.txt"
  printf 'new\n' >"$repo/new.txt"
  (cd "$repo" && "$script" "$patch" new.txt)

  grep -q '^new file mode ' "$patch"
  git -C "$repo" diff --quiet
  git -C "$repo" diff --cached --quiet
  test -z "$(git -C "$repo" status --porcelain)"
  git -C "$repo" apply --check "$patch"
  echo PASS
}

if [[ "${1:-}" == "--self-check" ]]; then
  self_check
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

patch="$1"
shift
new_paths=("$@")

reset_new_paths() {
  if (( ${#new_paths[@]} )); then
    git reset -q -- "${new_paths[@]}" || true
  fi
}

trap reset_new_paths EXIT
if (( ${#new_paths[@]} )); then
  git add -N -- "${new_paths[@]}"
fi
git diff --binary >"$patch"
reset_new_paths
trap - EXIT

git checkout -- .
git clean -fdq
git apply --check "$patch"
