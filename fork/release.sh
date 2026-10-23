#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/release.sh [--yes]

Releases bb-app from the fork branch without waiting for GitHub Actions:
builds in the fork's dev container, publishes the tarball as GitHub Release
v<version> (bumping to the next -fork.N first when the current version is
already released), pushes fork, sets BB_VERSION in bb-harness/.env and runs
setup.sh. --yes skips the confirmations; without a terminal they fail."

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
harness_dir=$repo_dir/../bb-harness
env_file=$harness_dir/.env
build_filters=(--filter=bb-app --filter=@bb/config --filter=@bb/server --filter=@bb/shared-ui --filter=@bb/app)

fail() { echo "ERROR: $*" >&2; exit 1; }

yes_flag=false
case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  --yes) yes_flag=true ;;
  "") ;;
  *) fail "unknown argument '$1'"$'\n'"$usage" ;;
esac

confirm() {
  $yes_flag && return 0
  [ -t 0 ] || fail "no terminal to confirm '$1': re-run with --yes"
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || fail "aborted"
}

echo "== Preconditions"
for tool in git node podman gh curl; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated: run 'gh auth login'"
[ -f "$env_file" ] || fail "no $env_file"
# shellcheck source=/dev/null
. "$env_file"
[ -n "${BB_RELEASES:-}" ] || fail "BB_RELEASES is empty in .env"
[ -n "${BB_VERSION:-}" ] || fail "BB_VERSION is empty in .env"
gh_repo=${BB_RELEASES#https://github.com/}
gh_repo=${gh_repo%/releases/download}
case "$gh_repo" in
  */*) ;;
  *) fail "BB_RELEASES is not https://github.com/<owner>/<repo>/releases/download: $BB_RELEASES" ;;
esac

branch=$(git -C "$repo_dir" branch --show-current)
[ "$branch" = "fork" ] || fail "repo is on '$branch', expected fork"
[ -z "$(git -C "$repo_dir" status --porcelain --untracked-files=no)" ] || fail "working tree has uncommitted changes"

echo "== Version"
current=$(node -p "require('$repo_dir/packages/bb-app/package.json').version")
[[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+-fork\.[0-9]+$ ]] || fail "bb-app version $current is not <upstream version>-fork.<n>"

release_exists() {
  gh release view "v$1" --repo "$gh_repo" >/dev/null 2>&1
}

if release_exists "$current"; then
  version="${current%-fork.*}-fork.$((${current##*-fork.} + 1))"
  echo "v$current is already released, bumping to $version"
  confirm "Commit the version bump 'Release bb-app $version'?"
  node "$repo_dir/scripts/bump-version.mjs" "$version"
  node "$repo_dir/.github/workflows/check-version-lockstep.mjs"
  git -C "$repo_dir" commit --quiet -am "Release bb-app $version"
else
  version=$current
  echo "v$version has no release yet, releasing it"
  node "$repo_dir/.github/workflows/check-version-lockstep.mjs"
fi
release_commit=$(git -C "$repo_dir" rev-parse HEAD)
tag=v$version
tarball_name=bb-app-$version.tgz
echo "release: $tag from $release_commit"

echo "== Build in the dev container"
"$repo_dir/fork/dev.sh" pnpm install --frozen-lockfile
"$repo_dir/fork/dev.sh" pnpm exec turbo run build "${build_filters[@]}" --output-logs=new-only
"$repo_dir/fork/dev.sh" pnpm exec turbo run smoke:tarball --filter=bb-app --force --output-logs=new-only
"$repo_dir/fork/dev.sh" sh -c "cd packages/bb-app && rm -f ./*.tgz && npm pack"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
mv "$repo_dir/packages/bb-app/$tarball_name" "$work_dir/"
tarball=$work_dir/$tarball_name
[ -f "$tarball" ] || fail "npm pack did not produce $tarball_name"

echo "== Publish $tag"
confirm "Push tag $tag to origin and create GitHub Release $tag on $gh_repo?"
git -C "$repo_dir" push origin "$release_commit:refs/tags/$tag"
gh release create "$tag" "$tarball" \
  --repo "$gh_repo" \
  --title "bb-app $version" \
  --notes "bb-app $version built from $release_commit. Install with \`npm install --global ./$tarball_name\` and start with \`--no-in-app-updates\`."
tarball_url=$BB_RELEASES/$tag/$tarball_name
for _ in 1 2 3 4 5 6; do
  curl -fsIL -o /dev/null "$tarball_url" && break
  sleep 5
done
curl -fsIL -o /dev/null "$tarball_url" || fail "release asset is not downloadable at $tarball_url"
echo "published $tarball_url"

echo "== Push fork"
confirm "Push fork to origin? The fork-release workflow will rebuild $tag without releasing."
git -C "$repo_dir" push origin fork

echo "== Deploy"
sed -i "s/^BB_VERSION=.*/BB_VERSION=$version/" "$env_file"
grep -q "^BB_VERSION=$version$" "$env_file" || fail "failed to set BB_VERSION=$version in $env_file"
echo "BB_VERSION=$version set in $env_file"
confirm "Run setup.sh now? It restarts both BB instances and cuts off running threads."
bash "$harness_dir/setup.sh"
echo "== done: bb-app $version is released and deployed"
