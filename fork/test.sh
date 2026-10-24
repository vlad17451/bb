#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/test.sh

Runs fork/release.sh against stub gh, git push, git ls-remote, curl, podman,
dev.sh and setup.sh in a temporary repository, and checks which release path it
takes. Needs bash, git and node; run it in the dev container: fork/dev.sh fork/test.sh"

[ $# -eq 0 ] || { echo "$usage" >&2; exit 1; }

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
real_git=$(command -v git)
failures=0

write_stub() {
  local path=$1 body=$2
  printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" >"$path"
  chmod +x "$path"
}

setup_sandbox() {
  local version=$1
  sandbox=$(mktemp -d)
  local fake_repo=$sandbox/repo
  calls=$sandbox/calls
  : >"$calls"
  mkdir -p "$sandbox/bin" "$sandbox/bb-harness" "$fake_repo/fork" "$fake_repo/scripts" \
    "$fake_repo/.github/workflows" "$fake_repo/packages/bb-app"

  cp "$repo_dir/fork/release.sh" "$fake_repo/fork/release.sh"
  printf '{ "name": "bb-app", "version": "%s" }\n' "$version" >"$fake_repo/packages/bb-app/package.json"
  cat >"$fake_repo/scripts/bump-version.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const packagePath = new URL("../packages/bb-app/package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.version = process.argv[2];
writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
EOF
  : >"$fake_repo/.github/workflows/check-version-lockstep.mjs"
  write_stub "$fake_repo/fork/dev.sh" "echo \"dev.sh \$*\" >>'$calls'
case \"\$*\" in
  *'npm pack'*)
    version=\$(node -p \"require('$fake_repo/packages/bb-app/package.json').version\")
    touch '$fake_repo/packages/bb-app/bb-app-'\"\$version\".tgz ;;
esac"

  printf 'BB_RELEASES=https://github.com/owner/fork/releases/download\nBB_VERSION=0.0.0-fork.0\n' \
    >"$sandbox/bb-harness/.env"
  write_stub "$sandbox/bb-harness/setup.sh" "echo setup.sh >>'$calls'"

  write_stub "$sandbox/bin/gh" "echo \"gh \$*\" >>'$calls'
case \"\$1 \$2\" in
  'auth status') exit 0 ;;
  'release view') grep -qxF \"\$3\" '$sandbox/released' ;;
  'release create') exit 0 ;;
  *) echo \"unexpected gh \$*\" >&2; exit 1 ;;
esac"
  write_stub "$sandbox/bin/git" "case \" \$* \" in
  *' push '*) echo \"git push \${*: -2}\" >>'$calls' ;;
  *' ls-remote '*) printf '%s\trefs/tags/%s\n' \"\$(cat '$sandbox/tag-commit')\" \"\${*: -1}\" ;;
  *) exec '$real_git' \"\$@\" ;;
esac"
  write_stub "$sandbox/bin/curl" "echo \"curl \${*: -1}\" >>'$calls'"
  write_stub "$sandbox/bin/podman" "exit 0"
  : >"$sandbox/released"

  "$real_git" -C "$fake_repo" init --quiet --initial-branch fork
  "$real_git" -C "$fake_repo" add -A
  GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com \
    GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com \
    "$real_git" -C "$fake_repo" commit --quiet -m "Release bb-app $version"
  head_commit=$("$real_git" -C "$fake_repo" rev-parse HEAD)
}

run_release() {
  PATH=$sandbox/bin:$PATH XDG_STATE_HOME=$sandbox/state \
    GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com \
    GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com \
    bash "$sandbox/repo/fork/release.sh" --yes >"$sandbox/output" 2>&1
}

expect_call() {
  grep -qxF -- "$1" "$calls" || { echo "  expected call: $1"; return 1; }
}

expect_call_matching() {
  grep -qE -- "$1" "$calls" || { echo "  expected call matching: $1"; return 1; }
}

expect_no_call_matching() {
  ! grep -qE -- "$1" "$calls" || { echo "  unexpected call matching: $1"; return 1; }
}

expect_env_version() {
  grep -qxF "BB_VERSION=$1" "$sandbox/bb-harness/.env" || { echo "  expected BB_VERSION=$1 in .env"; return 1; }
}

expect_head_subject() {
  local head_subject
  head_subject=$("$real_git" -C "$sandbox/repo" log -1 --format=%s)
  [ "$head_subject" = "$1" ] || { echo "  expected HEAD '$1', got '$head_subject'"; return 1; }
}

report() {
  local name=$1 status=$2
  if [ "$status" -eq 0 ]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    sed 's/^/  | /' "$sandbox/output"
    failures=$((failures + 1))
  fi
  rm -rf "$sandbox"
}

test_resumes_a_release_published_from_head() {
  setup_sandbox 1.2.3-fork.4
  echo v1.2.3-fork.4 >"$sandbox/released"
  echo "$head_commit" >"$sandbox/tag-commit"
  run_release \
    && expect_no_call_matching '^gh release create' \
    && expect_no_call_matching '^git push .*refs/tags/' \
    && expect_no_call_matching '^dev.sh' \
    && expect_call "curl https://github.com/owner/fork/releases/download/v1.2.3-fork.4/bb-app-1.2.3-fork.4.tgz" \
    && expect_call "git push origin fork" \
    && expect_call "setup.sh" \
    && expect_env_version 1.2.3-fork.4
}

test_bumps_when_the_release_is_from_another_commit() {
  setup_sandbox 1.2.3-fork.4
  echo v1.2.3-fork.4 >"$sandbox/released"
  echo 0000000000000000000000000000000000000000 >"$sandbox/tag-commit"
  run_release \
    && expect_call_matching '^gh release create v1\.2\.3-fork\.5 ' \
    && expect_call_matching '^git push origin [0-9a-f]{40}:refs/tags/v1\.2\.3-fork\.5$' \
    && expect_call "git push origin fork" \
    && expect_env_version 1.2.3-fork.5 \
    && expect_head_subject "Release bb-app 1.2.3-fork.5"
}

test_releases_the_current_version_when_it_has_no_release() {
  setup_sandbox 1.2.3-fork.4
  run_release \
    && expect_call_matching '^dev.sh .*npm pack' \
    && expect_call_matching '^gh release create v1\.2\.3-fork\.4 ' \
    && expect_call "git push origin $head_commit:refs/tags/v1.2.3-fork.4" \
    && expect_call "git push origin fork" \
    && expect_env_version 1.2.3-fork.4 \
    && expect_head_subject "Release bb-app 1.2.3-fork.4"
}

for test_name in $(declare -F | awk '{print $3}' | grep '^test_'); do
  status=0
  "$test_name" || status=$?
  report "$test_name" "$status"
done

[ "$failures" -eq 0 ] || { echo "$failures test(s) failed"; exit 1; }
echo "All release.sh tests passed."
