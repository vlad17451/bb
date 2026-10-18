#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/github-setup.sh

Configures the fork's GitHub repository (origin) for fork releases: Actions on,
\`fork\` as the default branch, and every workflow except fork-release.yml
disabled. Safe to re-run; run it again after a rebase that adds upstream
workflows."

fork_workflow=.github/workflows/fork-release.yml

fail() { echo "ERROR: $*" >&2; exit 1; }

[ $# -eq 0 ] || fail "$usage"
command -v gh >/dev/null || fail "gh is not on PATH"
gh auth status >/dev/null 2>&1 || fail "gh is not logged in (gh auth login)"

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
origin_url=$(git -C "$repo_dir" remote get-url origin)
repo=$(sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' <<<"$origin_url")
[[ "$repo" =~ ^[^/]+/[^/]+$ ]] || fail "origin is not a GitHub repository: $origin_url"
[ "$repo" != "get-bb/bb" ] || fail "origin points at upstream"

git -C "$repo_dir" ls-remote --exit-code --heads origin fork >/dev/null \
  || fail "branch fork is not on origin yet: git push origin fork"

actions_enabled=$(gh api "repos/$repo/actions/permissions" --jq .enabled)
if [ "$actions_enabled" != "true" ]; then
  gh api --method PUT "repos/$repo/actions/permissions" -F enabled=true -f allowed_actions=all >/dev/null
  echo "Enabled Actions in $repo"
fi

default_branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)
if [ "$default_branch" != "fork" ]; then
  gh repo edit "$repo" --default-branch fork >/dev/null
  echo "Default branch of $repo: fork (was $default_branch)"
fi

while IFS=$'\t' read -r workflow_id workflow_path workflow_state; do
  if [ "$workflow_path" = "$fork_workflow" ]; then
    [ "$workflow_state" = active ] || gh workflow enable "$workflow_id" --repo "$repo"
    continue
  fi
  [ "$workflow_state" = active ] || continue
  gh workflow disable "$workflow_id" --repo "$repo"
  echo "Disabled $workflow_path"
done < <(gh api --paginate "repos/$repo/actions/workflows" --jq '.workflows[] | [.id, .path, .state] | @tsv')

echo "OK: $repo releases only through $fork_workflow"
