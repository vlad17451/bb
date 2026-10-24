#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/dev-isolation-test.sh

Runs on the host. Starts the dev container through fork/dev.sh and checks that
nothing in it can write to .git or fork/, which the host runs later, while the
rest of the repository stays writable."

[ $# -eq 0 ] || { echo "$usage" >&2; exit 1; }

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
control_file=.dev-isolation-probe

in_container() {
  "$repo_dir/fork/dev.sh" bash -c "$1" 2>&1
}

remove_probes() {
  git -C "$repo_dir" config --local --unset bb.devIsolationProbe || true
  rm -f "$repo_dir/.git/hooks/$control_file" "$repo_dir/fork/$control_file" "$repo_dir/$control_file"
}
trap remove_probes EXIT

failures=0
expect_blocked() {
  local name=$1 command=$2 output
  if output=$(in_container "$command"); then
    echo "FAIL  $name: succeeded in the container"
    failures=$((failures + 1))
  elif [[ "$output" == *"Read-only file system"* ]]; then
    echo "PASS  $name: refused by the read-only mount"
  else
    echo "FAIL  $name: failed for another reason:"
    printf '  | %s\n' "$output"
    failures=$((failures + 1))
  fi
}

control="git -C /repo rev-parse HEAD && git config --file /repo/$control_file bb.devIsolationProbe 1 && rm /repo/$control_file"
if in_container "$control" >/dev/null; then
  echo "PASS  control: git in the container reads the repository and writes a config file elsewhere in /repo"
else
  echo "FAIL  control: git in the container cannot read the repository or write to /repo, so the checks below prove nothing"
  exit 1
fi

expect_blocked "git config in .git" "git -C /repo config --local bb.devIsolationProbe 1"
expect_blocked "a file in .git/hooks" "touch /repo/.git/hooks/$control_file"
expect_blocked "a file in fork/" "touch /repo/fork/$control_file"
expect_blocked "opening fork/release.sh for writing" ": >>/repo/fork/release.sh"

probe_left=$(git -C "$repo_dir" config --local --get bb.devIsolationProbe || true)
[ -z "$probe_left" ] || { echo "FAIL  bb.devIsolationProbe reached the host's .git/config"; failures=$((failures + 1)); }

[ "$failures" -eq 0 ] || { echo "$failures check(s) failed"; exit 1; }
echo "All dev container isolation checks passed."
