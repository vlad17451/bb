# Fork decisions

## A fork instead of patching the published bundle

The first fix was a build-time patch of the minified web bundle in the published package. It worked, but it matched minified names, had to regenerate the `.br` and `.gz` copies the server prefers, and would only grow with every further change. A fork fixes things in source, builds them with the normal toolchain and keeps the changes reviewable.

## Merge upstream main

The fork merges upstream `main` to keep the maintained diff small and adopt upstream features such as child notification policies. Fork versions retain the `<upstream version>-fork.<n>` format. npm's `gitHead` remains available when comparing a published release with its source.

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

## The Updates screen does not offer the official build

**Problem.** `updateAvailable` compared the running version with npm `latest` by semver. A prerelease sorts below its release, so `0.46.1` is greater than `0.46.1-fork.N` and every fork build showed an update arrow, the command `npx bb-app@latest` and the global update badge. That command would start the official package instead of the fork. `--no-in-app-updates` hides only the Update button.

**Change.** `getSystemVersion` in `apps/server/src/services/system/app-version.ts` keeps `updateAvailable` false when the running version has a `fork` prerelease, and still reports `latestVersion`. `UpdatesSettingsSection.tsx` derives the upstream base from `currentVersion` and, when npm `latest` differs from it, shows a quiet "upstream 0.46.1 · npm 0.46.2" next to the version, without a badge or button. The server contract is unchanged, which keeps rebases small.

## Restore upstream permission modes

The fork's active `read-only` mode has been removed to reduce divergence from BB. The available modes are upstream's `accept-edits`, `auto` and `full`. Former `read-only` selections and saved execution settings resolve to `auto`; the historical aliases `readonly` and `workspace-write` retain upstream's `accept-edits` normalization. Recorded events remain readable without rewriting their history. The removal advanced the host-daemon protocol to 239; subsequent upstream merges retain their newer protocol version.

The follow-up migration converts stored host ceilings, project defaults and queued message modes. Tasks and Automations migrate their own saved settings; Workflows normalizes a retired origin mode when resuming. Review prompts still request read-only work, but that instruction is no longer a filesystem restriction.

## The reasoning before a pending question stays open

**Problem.** An agent often writes what the owner needs to answer a question (a plan, the facts behind the options) and then calls AskUserQuestion in the same turn. Claude Code frequently delivers that text as a `thinking` block, not a `text` block (in one session, 165 of 247 assistant messages with tool calls), so BB showed it as a folded "Thought" row and the owner saw only the question card.

**Change.** `collectTimelineAutoExpansionRowIds` (`packages/client-core/src/timeline/timeline-auto-expand.ts`) adds a live-frontier rule: while the frontier is a pending question, the reasoning rows of the same turn right before it are open, and so is a summary row whose trailing children are that reasoning (only those children open; a tool or command in the summary is the boundary). When the question is answered or newer output arrives, the rows fold back as before. Ordinary assistant text before a question was already visible and is unchanged.

## Restore upstream child notifications

The fork's `notifyParentOnTurnEnd` setting and `--no-notify-parent` flag have been removed. Child threads retain their normal parent and lifecycle links and report successful, failed and interrupted turns, questions and approvals using BB's existing behavior. Swarm helpers use these ordinary child threads and collect results as before.

Upstream provides `parentNotifications` with `auto`, `stuck` and `off`. Swarm helpers use `stuck`: successful results are collected explicitly while failures, interruptions, questions and approvals notify the parent.

## Fork migrations have a separate journal and ledger

**Problem.** Adding the next numbered migration to upstream's journal would collide with later upstream migration numbers and snapshots. Renumbering alone does not fix existing databases. Drizzle's `readMigrationFiles` (`drizzle-orm/migrator`) reads entries in journal order, uses each tag as the SQL filename, hashes its contents and uses `when` as `folderMillis`. `SQLiteSyncDialect.migrate` (`drizzle-orm/sqlite-core/dialect`) reads the latest `created_at` from the selected ledger and executes only migrations with a larger timestamp. Neither a new filename nor a new journal index makes an older timestamp run. A large fork timestamp could therefore skip later upstream migrations; changing an already applied timestamp could replay the fork's `ALTER TABLE`. BB's `readExpectedAppliedMigrations` and `validateAppliedMigrationHistory` in `packages/db/src/migrate.ts` additionally require upstream timestamps and hashes to match the applied history. `packages/db/test/migration-journal.test.ts` requires increasing timestamps, positional indices and a snapshot chain.

**Change.** The custom SQL migration lives in `packages/db/drizzle/fork`, with its own `meta/_journal.json`, numbering starting at `0000`, and ledger `__fork_migrations`. `migrate` runs it after upstream migration and history validation, using Drizzle's `migrationsTable` option. The upstream journal, snapshots and ledger stay unchanged. The server's existing build copies the whole `packages/db/drizzle` directory recursively, so the fork journal ships in the bundle too. The shipped `0000` migration remains immutable after the notification feature is retired; its column and stored values are inert. Migration `0001` converts retired permission settings to `auto`. A regression test applies a simulated upstream migration at the fork timestamp to verify the ledgers are independent.

On rebase, retain upstream's SQL, journal and generated snapshots as upstream shipped them, and retain the fork directory and the second migrator call. Do not renumber, retimestamp or rewrite shipped fork SQL. Append future fork migrations with unique tags, positional indices and strictly increasing timestamps within the fork journal; their timestamps need no ordering relative to upstream's. These are custom SQL migrations, so they do not participate in upstream's generated snapshot chain; do not hand-edit snapshots or generate the fork column into upstream's journal. The retired notification column is no longer an application contract. If upstream later adopts that column name, reconcile its migration with already upgraded fork databases. Validate both a fresh database and an existing fork database after each rebase.

## Account Pooler can return to the first account

**Problem.** The Account Pooler is sticky: once it fails over to a later account, new conversations stay there even after the first account has quota again, and existing conversations keep their pinned account. An owner who wants a main account used first and a second one only as overflow has to switch back by hand.

**Change.** A `preferPriority` setting (default `false`, upstream's behaviour) in `plugins/account-pool`. When it is on, account selection in `src/hub.ts` takes the first eligible, unattempted account in priority order for every request and moves the session pin and the provider cursor with it. When that account is under a temporary hold, selection falls back to upstream's rules, so a conversation pinned to it still waits or gets Retry-After while new conversations move on. Failover, the switch threshold and model-family detours are unchanged. Set with `bb pool config set preferPriority true`; the settings page has no control for it.
