# Fork decisions

## A fork instead of patching the published bundle

The first fix was a build-time patch of the minified web bundle in the published package. It worked, but it matched minified names, had to regenerate the `.br` and `.gz` copies the server prefers, and would only grow with every further change. A fork fixes things in source, builds them with the normal toolchain and keeps the changes reviewable.

## Track npm releases, not `main`

Upstream publishes `bb-app` from `main` on a nightly schedule and has no release tags. npm records the source commit (`gitHead`) of every version, so `fork` is based on that commit. Releases are tested more than an arbitrary `main` commit.

## In-app updates off

BB's updater checks the npm registry and, when someone clicks Update, installs the official package into its data directory. In a deployment of the fork that would silently drop the fork's changes, and anyone with access to the UI can click it. Deployments start BB with `--no-in-app-updates` and update by installing a new fork release.

## Ctrl+Enter sends on touchscreen laptops

**Problem.** The composer treats a device as phone-like when `(pointer: coarse)` matches, and then Enter inserts a newline. On Windows laptops with a touchscreen, keyboard and touchpad, the primary pointer is touch, so `(pointer: coarse)` matches. In an idle thread neither Enter nor Ctrl+Enter sends (Ctrl+Enter only triggers the queue or steer action while a thread runs), so the keyboard cannot send at all.

**Change.** On a device where `(pointer: coarse)` matches, Ctrl+Enter or Cmd+Enter sends when there is no queue or steer action, that is in an idle thread (`handleEditorKeyDown` in `apps/app/src/components/promptbox/PromptBoxInternal.tsx`). Plain Enter keeps inserting a newline there, which is what upstream intends for touchscreen hybrids (its test "does not intercept code=Enter on a non-iPad coarse-pointer hybrid"). Software keyboards on phones have no Ctrl or Cmd key, so phones and tablets behave as before. While a thread runs, Ctrl+Enter still triggers the queue or steer action.

Related upstream request: [get-bb/bb#5446](https://github.com/get-bb/bb/issues/5446) asks for an opt-in "Enter inserts newline" setting and does not cover this case.

**First attempt, 0.46.1-fork.1 to fork.3.** `POINTER_COARSE_QUERY` in `packages/shared-ui/src/components/ui/hooks/use-pointer-coarse.ts` was changed to `(any-pointer: coarse) and not (any-pointer: fine)`, meant as "touch is present and no fine pointer is", and `ThreadTerminalView.tsx` was switched to the hook. That query is not valid Media Queries 4 syntax: `not` may only start a condition or sit inside parentheses. Browsers parse the whole string as `not all` (Firefox reports `matchMedia(...).media` as `"not all"`; by the spec and Blink's parser source, not run, Chromium does the same), so `usePointerCoarse()` was false on every device: phones and tablets got the desktop composer, Return sent, and the terminal key bar never showed. The tests stubbed `matchMedia` with the exported constant, so they could not catch it. The valid form, `(any-pointer: coarse) and (not (any-pointer: fine))`, gives the same answer as `(pointer: coarse)` in Chromium on Windows and Linux, which derives the primary pointer from the available ones (source read, not run), so it would not have fixed the laptop case there either. The hook, `ThreadTerminalView.tsx` and the two tests now match upstream again.

## Codex finds plugins that ship only a `.claude-plugin` manifest

**Problem.** Codex installs and enables a marketplace plugin whose manifest lives at `.claude-plugin/plugin.json`, with no `.codex-plugin` directory. BB's Codex skill catalog only looked for `.codex-plugin/plugin.json`, so such a plugin's skills never reached a Codex thread.

**Change.** `plugins/provider-codex/src/native-roots.ts` resolves the manifest once per plugin root: `.codex-plugin/plugin.json` when present, else `.claude-plugin/plugin.json`. Shipped in `0.46.1-fork.3`. The same patch is prepared as an upstream pull request; once upstream merges it, a rebase drops the fork's copy. If upstream lands a different version, drop the fork's commit in favour of upstream's.

## Enter answers a question with a typed answer

**Problem.** In a question from the agent, the "Other" field inserts a newline on Enter and submits only on Ctrl+Enter or Cmd+Enter. The composer sends on Enter, so a typed answer ends up with a stray newline instead of being submitted.

**Change.** `handleFreeTextKeyDown` in `packages/shared-ui/src/components/ui/question-form.tsx` follows the composer: on a device that is not coarse (`usePointerCoarse()`), Enter advances to the next question or submits, and Shift+Enter inserts a newline. Ctrl+Enter and Cmd+Enter still submit everywhere. Coarse-pointer devices (phones, tablets, touchscreen hybrids) keep Enter for newlines. The test `leaves free-text Enter available for newlines` is replaced by one test for each behaviour.
