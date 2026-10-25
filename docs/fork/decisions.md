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

## The Updates screen does not offer the official build

**Problem.** `updateAvailable` compared the running version with npm `latest` by semver. A prerelease sorts below its release, so `0.46.1` is greater than `0.46.1-fork.N` and every fork build showed an update arrow, the command `npx bb-app@latest` and the global update badge. That command would start the official package instead of the fork. `--no-in-app-updates` hides only the Update button.

**Change.** `getSystemVersion` in `apps/server/src/services/system/app-version.ts` keeps `updateAvailable` false when the running version has a `fork` prerelease, and still reports `latestVersion`. `UpdatesSettingsSection.tsx` derives the upstream base from `currentVersion` and, when npm `latest` differs from it, shows a quiet "upstream 0.46.1 · npm 0.46.2" next to the version, without a badge or button. The server contract is unchanged, which keeps rebases small.

## A read-only permission mode for Codex

**Problem.** A swarm of review agents must not change the checkout, but BB's least privileged mode, `accept-edits`, still writes inside the workspace. The only guard was an instruction in the prompt and a `git status` check afterwards.

**Change.** `read-only` is a fourth permission mode, ranked below `accept-edits` (`permissionModeValues` in `packages/domain/src/shared-types.ts`). Its runtime policy has scope `read-only` and, like `full`, no reviewer and no escalation. Codex declares it and maps it to its own `read-only` sandbox with `approvalPolicy: "never"` and `sandboxPolicy: { type: "readOnly", networkAccess: true }` (`plugins/provider-codex/src/session-params.ts`); network stays open as in `workspace-write`. The server rejects it for any provider that does not declare it, and the ACP bridges and Claude Code throw if it reaches them anyway. The CLI, SDK, picker, tasks, automations and workflows accept it; `HOST_DAEMON_PROTOCOL_VERSION` is bumped because the wire enums changed. The legacy recorded value `readonly` still normalizes to `accept-edits`. A child thread inheriting `read-only` from its parent gets the child provider's least privileged mode when that provider lacks `read-only` (`accept-edits` for Claude Code and agy), instead of the usual `auto` fallback.

**Limit.** `read-only` stops accidental writes, not an agent that looks for a way around it. The sandbox keeps network access, and a live check on 2026-10-25 showed a `read-only` Codex thread reaching BB's API (`bb status`), so it could ask BB for a thread with a writing mode. Closing that belongs to how much BB's API sandboxed code may reach, not to this mode.

The policy builder in `thread-commands.ts` and Codex's sandbox policy used to fall through to `accept-edits` and `dangerFullAccess` for any unknown mode; both now handle `read-only` explicitly, and Codex's sandbox policy is an exhaustive `switch`. The UI's placeholder permission ceiling stays `accept-edits` instead of following the first entry of the list.

**Not for Antigravity.** A control run on 2026-10-25 with agy 1.4.7 (`--mode plan --sandbox`) refused `touch` in the terminal (`Read-only file system`) but created a file through agy's own `write_file` tool. The CLI has no per-process deny rules; the only hard block is a `PreToolUse` hook in a global `hooks.json`, so agy does not declare `read-only`.

## Antigravity does not claim skill injection

**Problem.** The agy bridge declared `skills: { configure: true }` and answered `skills/configure` with `ok` while discarding the roots, so BB believed its global skills reached agy threads when they never did.

**Change.** `plugins/provider-agy/src/bridge/bridge.ts` declares `skills: { configure: false }` and no longer decodes `skills/configure`, so the runtime never sends it and a stray request is refused as an unknown method (the `skills/configure-declared` conformance rule). agy threads run without BB's injected skills, as before. Delivering them needs global agy state (`~/.gemini/config` skills or plugins, or symlinks into a user skill root) on both BB instances; that is left for later.

## Antigravity subagents as a workflow panel

**Problem.** agy starts subagents itself (`invoke_subagent`), but its stream-json output carries only the parent's own steps: a launch, an occasional `manage_subagents` listing, nothing about what a subagent does or when it ends. BB showed each launch as a tool row and the subagents' work was invisible.

**Change.** `plugins/provider-agy/src/subagent-workflow.ts` reads agy's own transcripts during a turn, every 1.5 s: the parent's `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl` for launches (a `PLANNER_RESPONSE` with `invoke_subagent` calls, then one `Created the following subagent:` step per call with the child's conversation id and log path) and completions (a `SYSTEM_MESSAGE` with `sender=<child id>`), and each child's transcript for its tool calls and timing. A control run on 2026-10-25 with agy 1.4.7 showed both written step by step within about a second. From that the bridge emits the same `backgroundTask` / `local_workflow` item Claude Code workflows use (`item.open`, `item.progress` with the full snapshot, `item.close` before the turn boundary). A role `Phase: label` names the phase, otherwise each launch batch is `Wave N`. The translator drops the `invoke_subagent` and `manage_subagents` steps from the timeline.

**Limits.** The `state` field of agy's `subagents/<id>.json` stays `SUBAGENT_STATE_ALIVE` after a subagent ends, so it is not used. A failed subagent is assumed from an `ERROR` status on its last step, which has not been observed. A turn stopped without agy's `result` event leaves the item to BB's own reconciliation.

## The reasoning before a pending question stays open

**Problem.** An agent often writes what the owner needs to answer a question (a plan, the facts behind the options) and then calls AskUserQuestion in the same turn. Claude Code frequently delivers that text as a `thinking` block, not a `text` block (in one session, 165 of 247 assistant messages with tool calls), so BB showed it as a folded "Thought" row and the owner saw only the question card.

**Change.** `collectTimelineAutoExpansionRowIds` (`packages/client-core/src/timeline/timeline-auto-expand.ts`) adds a live-frontier rule: while the frontier is a pending question, the reasoning rows of the same turn right before it are open, and so is a summary row whose trailing children are that reasoning (only those children open; a tool or command in the summary is the boundary). When the question is answered or newer output arrives, the rows fold back as before. Ordinary assistant text before a question was already visible and is unchanged.

## Child threads that do not wake their parent

**Problem.** A coordinator can be a real child for sidebar nesting, related threads and `bb status`, while its caller already waits for its result with `bb thread wait`. Posting each turn outcome into the parent wakes its agent unnecessarily and copies raw child output into its context. Lifecycle ownership alone does not establish the hierarchy.

**Change.** `notifyParentOnTurnEnd` is a persisted thread boolean, set at creation and defaulting to `true`. `bb thread spawn --no-notify-parent` sends `notifyParentOnTurnEnd: false` and requires `--parent-self` or `--parent-thread`; it rejects `--origin-kind`, which creates a fork rather than a hierarchy child. The SDK create request accepts the same field. The outcome call sites suppress completed, failed and interrupted turns, command failures, exhausted queue-drain retries and environment provisioning failures. The shared `isParentNotifiableChildThread` predicate and the interactive-request path remain unchanged: approvals and questions still notify the parent. Parenting and lifecycle ownership remain independent.

## Fork migrations have a separate journal and ledger

**Problem.** Adding the next numbered migration to upstream's journal would collide with later upstream migration numbers and snapshots. Renumbering alone does not fix existing databases. Drizzle's `readMigrationFiles` (`drizzle-orm/migrator`) reads entries in journal order, uses each tag as the SQL filename, hashes its contents and uses `when` as `folderMillis`. `SQLiteSyncDialect.migrate` (`drizzle-orm/sqlite-core/dialect`) reads the latest `created_at` from the selected ledger and executes only migrations with a larger timestamp. Neither a new filename nor a new journal index makes an older timestamp run. A large fork timestamp could therefore skip later upstream migrations; changing an already applied timestamp could replay the fork's `ALTER TABLE`. BB's `readExpectedAppliedMigrations` and `validateAppliedMigrationHistory` in `packages/db/src/migrate.ts` additionally require upstream timestamps and hashes to match the applied history. `packages/db/test/migration-journal.test.ts` requires increasing timestamps, positional indices and a snapshot chain.

**Change.** The custom SQL migration lives in `packages/db/drizzle/fork`, with its own `meta/_journal.json`, numbering starting at `0000`, and ledger `__fork_migrations`. `migrate` runs it after upstream migration and history validation, using Drizzle's `migrationsTable` option. The upstream journal, snapshots and ledger stay unchanged. The server's existing build copies the whole `packages/db/drizzle` directory recursively, so the fork journal ships in the bundle too. Existing rows receive `true`; subsequent startups skip the already applied fork SQL and retain explicit `false` values. A regression test applies a simulated upstream migration at the fork timestamp to verify the ledgers are independent.

On rebase, retain upstream's SQL, journal and generated snapshots as upstream shipped them, and retain the fork directory and the second migrator call. Do not renumber, retimestamp or rewrite shipped fork SQL. Append future fork migrations with unique tags, positional indices and strictly increasing timestamps within the fork journal; their timestamps need no ordering relative to upstream's. These are custom SQL migrations, so they do not participate in upstream's generated snapshot chain; do not hand-edit snapshots or generate the fork column into upstream's journal. Inspect any upstream migration that rebuilds `threads`: its copy must preserve fork column values, or the rebase needs a staging/restore step around upstream migration before it is released. If upstream adopts this field, reconcile its column migration with already upgraded fork databases before removing the fork migrator. Validate both a fresh database and an existing fork database with a stored `false` after each such rebase.
