#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/check-changes.sh [<base ref>]

Runs on the host. Typechecks in the dev container, then runs
fork/test-baseline.sh for packages changed since <base ref> (default HEAD)
and their dependents, including staged, unstaged and untracked files.
Streams output and saves logs to ~/.local/state/bb-fork/."

case "${1:-}" in -h|--help) echo "$usage"; exit 0 ;; esac
[ "$#" -le 1 ] || { echo "$usage" >&2; exit 1; }

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
base_ref=${1:-HEAD}
base_commit=$(git -C "$repo_dir" rev-parse --verify --end-of-options "$base_ref^{commit}")
filter="--filter=...[$base_commit]"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/bb-fork"
mkdir -p "$log_dir"
stamp=$(date +%Y%m%d-%H%M%S)-$$
typecheck_log="$log_dir/typecheck-$stamp.log"
test_log="$log_dir/check-tests-$stamp.log"

echo "Checking changes since $base_ref ($base_commit) and their dependents"
echo "Typecheck log: $typecheck_log"
echo "Test output log: $test_log"
typecheck_status=0
"$repo_dir/fork/dev.sh" pnpm exec turbo run typecheck "$filter" --output-logs=full --log-order=stream --ui=stream 2>&1 | tee "$typecheck_log" || typecheck_status=$?

test_status=0
"$repo_dir/fork/test-baseline.sh" "$filter" --output-logs=full --log-order=stream --ui=stream 2>&1 | tee "$test_log" || test_status=$?

echo "Typecheck exit: $typecheck_status; log: $typecheck_log"
echo "Test baseline exit: $test_status; log: $test_log"
if [ "$typecheck_status" -ne 0 ] || [ "$test_status" -ne 0 ]; then
  exit 1
fi
