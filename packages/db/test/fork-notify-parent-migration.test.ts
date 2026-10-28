import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { createMigratedConnection } from "../src/testing.js";
import { createThread, getThread, migrate, noopNotifier } from "../src/index.js";

function createTestThread(db: ReturnType<typeof createMigratedConnection>) {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
  });
}

describe("fork parent notification migration", () => {
  it("preserves retired column values across repeated startup", () => {
    const db = createMigratedConnection();
    try {
      const existing = createTestThread(db);
      db.$client.exec("ALTER TABLE threads DROP COLUMN notify_parent_on_turn_end");
      db.$client.exec("DROP TABLE __fork_migrations");

      migrate(db);
      expect(
        db.$client
          .prepare(
            "SELECT notify_parent_on_turn_end AS value FROM threads WHERE id = ?",
          )
          .get(existing.id),
      ).toEqual({ value: 1 });
      const muted = createTestThread(db);
      db.$client
        .prepare(
          "UPDATE threads SET notify_parent_on_turn_end = 0 WHERE id = ?",
        )
        .run(muted.id);
      migrate(db);
      expect(getThread(db, muted.id)?.id).toBe(muted.id);
      expect(
        db.$client
          .prepare(
            "SELECT notify_parent_on_turn_end AS value FROM threads WHERE id = ?",
          )
          .get(muted.id),
      ).toEqual({ value: 0 });
      expect(
        db.$client.prepare("SELECT count(*) AS count FROM __fork_migrations").get(),
      ).toEqual({ count: 2 });
    } finally {
      db.$client.close();
    }
  });

  it("applies a later upstream migration even at the fork migration timestamp", () => {
    const db = createMigratedConnection();
    const folder = mkdtempSync(join(tmpdir(), "bb-fork-migrations-"));
    try {
      const forkMigration = db.$client
        .prepare<[], { created_at: number }>(
          "SELECT max(created_at) AS created_at FROM __fork_migrations",
        )
        .get();
      if (!forkMigration) throw new Error("Missing fork migration");
      mkdirSync(join(folder, "meta"));
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "sqlite",
          entries: [{
            idx: 0,
            version: "6",
            when: forkMigration.created_at,
            tag: "0144_test_upstream",
            breakpoints: true,
          }],
        }),
      );
      writeFileSync(
        join(folder, "0144_test_upstream.sql"),
        "CREATE TABLE test_upstream_migration (id integer);",
      );

      drizzleMigrate(db, { migrationsFolder: folder });
      expect(
        db.$client.prepare(
          "SELECT name FROM sqlite_master WHERE name = 'test_upstream_migration'",
        ).get(),
      ).toBeDefined();
      migrate(db);
      const thread = createTestThread(db);
      expect(getThread(db, thread.id)?.id).toBe(thread.id);
    } finally {
      db.$client.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
