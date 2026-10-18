# About this fork

This is a personal fork of [get-bb/bb](https://github.com/get-bb/bb). It exists to run BB for a small private setup and to carry fixes that the setup needs before or instead of upstream. It is not a product and does not publish to npm.

## Branches and versions

- `main` mirrors upstream and is not used for our work.
- `fork` holds our commits on top of the commit that npm records as `gitHead` for a published `bb-app` release (for example `411eac54ac16d0a3cb57d1de8396d37564884a73` for 0.46.1). Upstream has no release tags, so the npm metadata is the only exact link between a published version and its source.
- Versions are `<upstream version>-fork.<n>`.

## Releases

`.github/workflows/fork-release.yml` runs on every push to `fork` and on manual dispatch. It installs with the frozen lockfile, builds, typechecks and tests `bb-app` and the packages the fork changes, runs upstream's tarball smoke test, packs `packages/bb-app` and creates the GitHub Release `v<version>` with `bb-app-<version>.tgz` as its asset. When that release already exists, it builds without releasing.

To release, bump both locked versions (`packages/bb-app` and `apps/desktop`, see `.github/workflows/check-version-lockstep.mjs`) to the next `<upstream version>-fork.<n>` and push.

Upstream's own workflows (nightly npm publish, desktop builds, deploys, CI) do not run here. `fork/github-setup.sh` turns Actions on, makes `fork` the default branch (manual dispatch needs the workflow on the default branch) and disables every workflow except `fork-release.yml`. A rebase that brings a new upstream workflow needs another run of it.

## What deployments expect from a build

- An installable `bb-app` tarball (`npm install -g ./bb-app-<version>.tgz`).
- BB started with `--no-in-app-updates`: the in-app updater installs the official npm package, which would replace the fork.
- In a container, BB listens on `0.0.0.0` inside the container and the port is published on the host's loopback only.
- `BB_CLAUDE_CODE_EXECUTABLE` pointing at `claude`, because the host daemon reads PATH from a login shell, and on Debian-based images `/etc/profile` drops `~/.local/bin`.

## Changes carried by the fork

See [decisions.md](decisions.md).

## Development

Dependencies, dev servers, builds and tests run in the fork's dev container, not on the host, so that dependency install scripts never see the developer's home. `fork/dev.sh <command>` builds the image from `fork/dev/` (Node 24, pnpm 9.15.0 through corepack) and runs the command with only the repository mounted at `/repo`:

```sh
fork/dev.sh pnpm install --frozen-lockfile
fork/dev.sh pnpm build
fork/dev.sh pnpm exec turbo run typecheck test --filter=@bb/shared-ui --filter=@bb/app
fork/dev.sh --serve pnpm dev
fork/dev.sh
```

- The pnpm store lives in the named volume `bb-fork-pnpm-store`.
- The container runs as `0:0`. Under rootless podman that is the developer's own UID on the host, so files in the repository keep their owner. `--userns keep-id` fails on the owner's host with `crun: write to uid_map`.
- Before the command starts, the entrypoint adds an nftables egress filter in the container's network namespace: the internet and the DNS servers from `/etc/resolv.conf` are open; private networks, link-local (which includes podman's `host.containers.internal`), CGNAT and the tailnet (`100.64.0.0/10`), multicast and the IPv6 equivalents are rejected. It then drops `CAP_NET_ADMIN`, so nothing in the container can change the filter. Without it, a dependency could reach services on the host or the tailnet, such as an unauthenticated BB published with Tailscale Serve.
- `--serve` publishes the dev app and server ports on `127.0.0.1` only and makes them listen on `0.0.0.0` inside the container. The ports follow upstream's per-checkout scheme for the repository root `/repo` (`resolvePorts` in `packages/config/src/runtime.ts`); the script prints the app URL.

## Planned

A daily job that rebases `fork` onto the `gitHead` of the newest npm release and builds it, opening an issue when the rebase conflicts.
