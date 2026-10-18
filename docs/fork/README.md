# About this fork

This is a personal fork of [get-bb/bb](https://github.com/get-bb/bb). It exists to run BB for a small private setup and to carry fixes that the setup needs before or instead of upstream. It is not a product and does not publish to npm.

## Branches and versions

- `main` mirrors upstream and is not used for our work.
- `fork` holds our commits on top of the commit that npm records as `gitHead` for a published `bb-app` release (for example `411eac54ac16d0a3cb57d1de8396d37564884a73` for 0.46.1). Upstream has no release tags, so the npm metadata is the only exact link between a published version and its source.
- Versions are `<upstream version>-fork.<n>`.

## Releases

GitHub Actions builds `packages/bb-app` on push to `fork` and attaches the packed tarball to a GitHub Release. Upstream's own workflows (nightly npm publish, desktop builds) are disabled here.

## What deployments expect from a build

- An installable `bb-app` tarball (`npm install -g ./bb-app-<version>.tgz`).
- BB started with `--no-in-app-updates`: the in-app updater installs the official npm package, which would replace the fork.
- In a container, BB listens on `0.0.0.0` inside the container and the port is published on the host's loopback only.
- `BB_CLAUDE_CODE_EXECUTABLE` pointing at `claude`, because the host daemon reads PATH from a login shell, and on Debian-based images `/etc/profile` drops `~/.local/bin`.

## Changes carried by the fork

See [decisions.md](decisions.md).

## Development

Dependencies, dev servers, builds and tests run in the fork's dev container, not on the host.

## Planned

A daily job that rebases `fork` onto the `gitHead` of the newest npm release and builds it, opening an issue when the rebase conflicts.
