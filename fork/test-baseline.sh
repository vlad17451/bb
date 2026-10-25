#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/test-baseline.sh [<turbo filter> ...]

Runs on the host. Runs turbo test in the dev container (every package, or the
given filters such as --filter=@bb/server) and compares the failing tests with
fork/known-test-failures.txt. Prints new failures (exit 1) and known failures
that now pass. The full log goes to ~/.local/state/bb-fork/test-<time>.log."

case "${1:-}" in -h|--help) echo "$usage"; exit 0 ;; esac

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
known_file="$repo_dir/fork/known-test-failures.txt"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/bb-fork"
mkdir -p "$log_dir"
log_file="$log_dir/test-$(date +%Y%m%d-%H%M%S).log"

echo "Running tests in the dev container, log: $log_file"
turbo_status=0
"$repo_dir/fork/dev.sh" pnpm exec turbo run test "$@" --continue 2>&1 | tee "$log_file" || turbo_status=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$log_file"

failing=$(sed -nE 's/^([^ :]+):test: +FAIL +([^ ]+ +)?([^ ]+\.[cm]?[jt]sx?( .*)?)$/\1: \3/p' "$log_file" | sed 's/ *$//' | sort -u)
ran_packages=$(sed -nE 's/^([^ :]+):test: .*/\1/p' "$log_file" | sort -u)
known=$(grep -vE '^(#|$)' "$known_file" | sed 's/^flaky: //' | sort -u)
known_stable=$(grep -vE '^(#|$|flaky: )' "$known_file" | sort -u)

new_failures=$(comm -23 <(printf '%s\n' "$failing" | sed '/^$/d') <(printf '%s\n' "$known"))
now_passing=$(comm -23 <(printf '%s\n' "$known_stable") <(printf '%s\n' "$failing") |
  while IFS= read -r entry; do
    package=${entry%%: *}
    if grep -qxF -- "$package" <<<"$ran_packages"; then echo "$entry"; fi
  done)

known_count=$(comm -12 <(printf '%s\n' "$failing" | sed '/^$/d') <(printf '%s\n' "$known") | wc -l)
echo "Known failures seen: $known_count"
if [ -n "$now_passing" ]; then
  echo "Known failures that passed (remove them from fork/known-test-failures.txt):"
  printf '  %s\n' "$now_passing"
fi
if [ -n "$new_failures" ]; then
  echo "NEW failures:"
  printf '  %s\n' "$new_failures"
  exit 1
fi
if [ "$turbo_status" -ne 0 ] && [ -z "$failing" ]; then
  echo "turbo failed without a failing test (a build or typecheck step?); read $log_file"
  exit 1
fi
echo "No new failures."
