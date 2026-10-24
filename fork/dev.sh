#!/usr/bin/env bash
set -euo pipefail

usage="Usage: fork/dev.sh [--serve] [<command> [args...]]

Builds the fork's dev container and runs <command> (default: bash) in it with
only the repository mounted (at /repo; .git and fork/ read-only). --serve also publishes the dev app and
server ports on 127.0.0.1, for example: fork/dev.sh --serve pnpm dev"

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
image=localhost/bb-fork-dev
store_volume=bb-fork-pnpm-store
container_repo_dir=/repo

fail() { echo "ERROR: $*" >&2; exit 1; }

dev_port_offset() {
  local repo_root_hash
  repo_root_hash=$(printf %s "$container_repo_dir" | sha256sum | cut -c1-8)
  echo $(( 16#$repo_root_hash % 8000 ))
}

serve=false
case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  --serve) serve=true; shift ;;
esac
command -v podman >/dev/null || fail "podman is not on PATH"
[ -f "$repo_dir/pnpm-lock.yaml" ] || fail "no pnpm-lock.yaml in $repo_dir"

podman build --quiet --tag "$image" "$repo_dir/fork/dev" >/dev/null

run_args=(
  --rm --init
  --user 0:0
  --cap-add NET_ADMIN
  -v "$repo_dir:$container_repo_dir:z"
  -v "$repo_dir/.git:$container_repo_dir/.git:ro,z"
  -v "$repo_dir/fork:$container_repo_dir/fork:ro,z"
  -v "$store_volume:/pnpm-store"
  -w "$container_repo_dir"
)
if [ -t 0 ] && [ -t 1 ]; then
  run_args+=(-it)
fi
if $serve; then
  port_offset=$(dev_port_offset)
  app_port=$((11000 + port_offset))
  server_port=$((19000 + port_offset))
  run_args+=(
    -p "127.0.0.1:$app_port:$app_port"
    -p "127.0.0.1:$server_port:$server_port"
    -e BB_DEV_APP_HOST=0.0.0.0
    -e BB_SERVER_BIND_HOST=0.0.0.0
  )
  echo "Dev app: http://127.0.0.1:$app_port" >&2
fi

exec podman run "${run_args[@]}" "$image" "$@"
