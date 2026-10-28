import { describe, expect, it } from "vitest";
import {
  createProject,
  createQueuedThreadMessage,
  createThread,
  getHost,
  getProjectExecutionDefaults,
  getQueuedThreadMessage,
  migrate,
  noopNotifier,
  upsertHost,
  upsertProjectExecutionDefaults,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

const retirementMigrationTimestamp = 1793138400000;

describe("fork permission mode retirement", () => {
  it.each([
    ["read-only", "auto"],
    ["accept-edits", "accept-edits"],
    ["auto", "auto"],
    ["full", "full"],
  ] as const)(
    "restores stored %s settings to %s across repeated startup",
    (storedPermissionMode, expectedMode) => {
      const db = createMigratedConnection();
      try {
        const host = upsertHost(db, noopNotifier, { name: "test-host" });
        const { project } = createProject(db, noopNotifier, {
          name: "test-project",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/workspace/test-project",
          },
        });
        const thread = createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          status: "idle",
        });
        upsertProjectExecutionDefaults(db, {
          projectId: project.id,
          providerId: "codex",
          model: "test-model",
          reasoningLevel: "medium",
          permissionMode: expectedMode,
          serviceTier: "default",
        });
        const queued = createQueuedThreadMessage(db, noopNotifier, {
          threadId: thread.id,
          content: [{ type: "text", text: "pending work", mentions: [] }],
          model: "test-model",
          reasoningLevel: "medium",
          permissionMode: expectedMode,
          serviceTier: "default",
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });
        db.$client
          .prepare("UPDATE hosts SET max_permission_mode = ? WHERE id = ?")
          .run(storedPermissionMode, host.id);
        db.$client
          .prepare(
            "UPDATE project_execution_defaults SET permission_mode = ? WHERE project_id = ?",
          )
          .run(storedPermissionMode, project.id);
        db.$client
          .prepare(
            "UPDATE queued_thread_messages SET permission_mode = ? WHERE id = ?",
          )
          .run(storedPermissionMode, queued.id);
        db.$client
          .prepare("DELETE FROM __fork_migrations WHERE created_at = ?")
          .run(retirementMigrationTimestamp);

        for (let startup = 0; startup < 2; startup += 1) {
          migrate(db);
          expect(getHost(db, host.id)?.maxPermissionMode).toBe(expectedMode);
          expect(
            getProjectExecutionDefaults(db, { projectId: project.id }),
          ).toMatchObject({
            model: "test-model",
            permissionMode: expectedMode,
          });
          expect(getQueuedThreadMessage(db, queued.id)).toMatchObject({
            model: "test-model",
            permissionMode: expectedMode,
          });
        }
        expect(
          db.$client
            .prepare(
              "SELECT COUNT(*) AS count FROM __fork_migrations WHERE created_at = ?",
            )
            .get(retirementMigrationTimestamp),
        ).toEqual({ count: 1 });
      } finally {
        db.$client.close();
      }
    },
  );
});
