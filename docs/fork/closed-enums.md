# Adding a value to a closed enum

Applies when a change adds a value to a closed list that grants or restricts something: permission modes, permission scopes, sandbox modes, provider capabilities, any `z.enum([...])` or `[...] as const` such a value flows through. Type checking only reaches exhaustive `switch` statements, so a new value can silently take the branch meant for another one. Adding `read-only` (`83e4d5bce`) fell through to `accept-edits` in the server's policy builder and to `dangerFullAccess` in Codex's sandbox policy, and a later review found a third fallthrough in the child-thread fallback.

Before committing, account for every site:

1. **Comparisons.** `git grep -nE '"(<value 1>|<value 2>|...)"' -- '*.ts' '*.tsx'` with the existing values, then read every `===`, `!==`, ternary and `if` chain on that type. Each one handles the new value explicitly, or ends in a branch that refuses (`throw`, an error result). A chain whose last branch grants something is the bug.
2. **Copies of the list.** Grep for the whole existing list in each spelling: the array, a TypeScript union (`"a" | "b" | "c"`), a plugin's own `z.enum`, CLI help and error text, guide templates and skills, test expectations and fixtures. These copies compile with or without the new value.
3. **Position.** Code that picks by index or rank (`values[0]`, `permissionModeRank`, "the highest allowed") picks something else once the list grows at either end.
4. **Fallbacks.** Where the value is unsupported (a provider that does not declare it, a value inherited from a parent), fall back to the least privileged option, never to the product default.
5. **Wire.** A changed enum on the server/daemon wire bumps `HOST_DAEMON_PROTOCOL_VERSION`.

Then run `fork/test-baseline.sh` with filters for the touched packages and add a test for each site that branched.
