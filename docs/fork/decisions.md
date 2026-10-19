# Fork decisions

## A fork instead of patching the published bundle

The first fix was a build-time patch of the minified web bundle in the published package. It worked, but it matched minified names, had to regenerate the `.br` and `.gz` copies the server prefers, and would only grow with every further change. A fork fixes things in source, builds them with the normal toolchain and keeps the changes reviewable.

## Track npm releases, not `main`

Upstream publishes `bb-app` from `main` on a nightly schedule and has no release tags. npm records the source commit (`gitHead`) of every version, so `fork` is based on that commit. Releases are tested more than an arbitrary `main` commit.

## In-app updates off

BB's updater checks the npm registry and, when someone clicks Update, installs the official package into its data directory. In a deployment of the fork that would silently drop the fork's changes, and anyone with access to the UI can click it. Deployments start BB with `--no-in-app-updates` and update by installing a new fork release.

## Enter sends on touchscreen laptops

**Problem.** The composer treats a device as phone-like when `(pointer: coarse)` matches, and then Enter inserts a newline. On Windows laptops with a touchscreen, keyboard and touchpad, the primary pointer is touch, so `(pointer: coarse)` matches. In an idle thread neither Enter nor Ctrl+Enter sends (Ctrl+Enter only triggers the queue or steer action while a thread runs), so the keyboard cannot send at all.

**Change.** `POINTER_COARSE_QUERY` in `packages/shared-ui/src/components/ui/hooks/use-pointer-coarse.ts` is `(any-pointer: coarse) and not (any-pointer: fine)`: touch is present and no fine pointer is. Phones and tablets without a mouse behave as before. Touchscreen laptops and tablets with a trackpad get the desktop composer, where Enter sends and Shift+Enter inserts a newline. Other consumers of the hook switch to their desktop behaviour on those devices too, which is intended.

- `ThreadTerminalView.tsx` used its own `(pointer: coarse)` check to show the on-screen terminal keys; it now uses `usePointerCoarse()`, since a device with a keyboard does not need them.
- `realtime-cache-effects.ts` keeps its raw `(pointer: coarse)` check: it sizes a cache by device class, not by input method.
- Two tests that stubbed the literal query now use `POINTER_COARSE_QUERY`.

Related upstream request: [get-bb/bb#5446](https://github.com/get-bb/bb/issues/5446) asks for an opt-in "Enter inserts newline" setting and does not cover this case.

## Enter answers a question with a typed answer

**Problem.** In a question from the agent, the "Other" field inserts a newline on Enter and submits only on Ctrl+Enter or Cmd+Enter. The composer sends on Enter, so a typed answer ends up with a stray newline instead of being submitted.

**Change.** `handleFreeTextKeyDown` in `packages/shared-ui/src/components/ui/question-form.tsx` follows the composer: on a device that is not coarse (`usePointerCoarse()`), Enter advances to the next question or submits, and Shift+Enter inserts a newline. Ctrl+Enter and Cmd+Enter still submit everywhere. Phones and tablets without a fine pointer keep Enter for newlines. The test `leaves free-text Enter available for newlines` is replaced by one test for each behaviour.
