#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: proposal-patch.sh <output.patch> [new-path ...]" >&2
  echo "       proposal-patch.sh --worktree <repo> <worktree> <output.patch> [new-path ...]" >&2
  echo "       proposal-patch.sh --self-check" >&2
}

self_check() {
  local tmp repo worktree patch script
  tmp="$(mktemp -d)"
  SELF_CHECK_TMP="$tmp"
  repo="$tmp/repo"
  worktree="$tmp/allocation/tree"
  patch="$tmp/proposal.patch"
  script="$(realpath "$0")"
  trap 'rm -rf "$SELF_CHECK_TMP"' EXIT

  git init -q "$repo"
  git -C "$repo" config user.email kaizen@example.invalid
  git -C "$repo" config user.name kaizen
  printf 'before\n' >"$repo/tracked.txt"
  git -C "$repo" add tracked.txt
  git -C "$repo" commit -qm base

  mkdir -p "$(dirname "$worktree")"
  git -C "$repo" worktree add -q --detach "$worktree" HEAD
  printf 'after\n' >"$worktree/tracked.txt"
  printf 'new\n' >"$worktree/new.txt"
  "$script" --worktree "$repo" "$worktree" "$patch" new.txt

  grep -q '^new file mode ' "$patch"
  test ! -e "$worktree"
  test ! -e "$(dirname "$worktree")"
  test -z "$(git -C "$repo" worktree list --porcelain | grep -F "$worktree" || true)"
  git -C "$repo" apply --check "$patch"
  echo PASS
}

capture_patch() {
  local tree="$1" patch="$2"
  shift 2
  local new_paths=("$@")

  reset_new_paths() {
    if (( ${#new_paths[@]} )); then
      git -C "$tree" reset -q -- "${new_paths[@]}" || true
    fi
  }

  trap reset_new_paths EXIT
  if (( ${#new_paths[@]} )); then
    git -C "$tree" add -N -- "${new_paths[@]}"
  fi
  git -C "$tree" diff --binary >"$patch"
  reset_new_paths
  trap - EXIT

  git -C "$tree" checkout -- .
  git -C "$tree" clean -fdq
  git -C "$tree" apply --check "$patch"
}

if [[ "${1:-}" == "--self-check" ]]; then
  self_check
  exit 0
fi

if [[ "${1:-}" == "--worktree" ]]; then
  if [[ $# -lt 4 ]]; then
    usage
    exit 2
  fi

  repo="$(realpath "$2")"
  worktree="$(realpath "$3")"
  patch="$(realpath -m "$4")"
  shift 4

  repo_common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
  worktree_common="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)"
  if [[ "$repo_common" != "$worktree_common" || "$repo" == "$worktree" ]]; then
    echo "proposal-patch.sh: worktree is not an allocation from repo: $worktree" >&2
    exit 2
  fi

  capture_patch "$worktree" "$patch" "$@"
  git -C "$repo" worktree remove --force "$worktree"
  rmdir "$(dirname "$worktree")"
  git -C "$repo" apply --check "$patch"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

patch="$1"
shift
capture_patch . "$patch" "$@"
