import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_agybridge1";
const threadStartResultSchema = z.object({ providerThreadId: z.string() });
const OPTIONS = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
  instructions: "test",
} as const;

function promptInput(text: string) {
  return [{ type: "text", text, mentions: [] }];
}

async function waitForLogLines(
  logPath: string,
  count: number,
): Promise<string[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    if (lines.length >= count || Date.now() > deadline) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("provider-agy bridge", () => {
  let workDir: string;
  let logPath: string;
  let bridge: BridgeJsonRpcTestHarness;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agy-bridge-"));
    logPath = join(workDir, "agy.log");
    writeFileSync(logPath, "");
    const fakeAgyPath = join(workDir, "agy");
    writeFileSync(
      fakeAgyPath,
      [
        "#!/bin/sh",
        `echo "start $*" >> "${logPath}"`,
        `cat >> "${logPath}.inputs"`,
        `while [ -f "${logPath}.blocked" ]; do sleep 0.02; done`,
        "sleep 0.3",
        `echo '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"done"}}'`,
        `echo end >> "${logPath}"`,
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgyPath, 0o755);
    process.env.BB_AGY_EXECUTABLE = fakeAgyPath;
    bridge = createBridgeJsonRpcTestHarness(handleLine);
  });

  afterEach(async () => {
    bridge.sendRequest("cleanup-stop", "thread/stop", {
      threadId: THREAD_ID,
      providerThreadId: "conv-1",
      intent: "interrupt",
      activeTurnId: null,
    });
    await bridge.waitForResponse("cleanup-stop");
    bridge.sendRequest("cleanup-discard", "thread/discard", {
      threadId: THREAD_ID,
      providerThreadId: "conv-1",
    });
    await bridge.waitForResponse("cleanup-discard");
    bridge.restore();
    delete process.env.BB_AGY_EXECUTABLE;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("does not offer skill injection and refuses skills/configure", async () => {
    bridge.sendRequest(1, "initialize", {
      protocolVersion: 2,
      client: { name: "test", version: "0.0.0" },
    });
    const initializeResponse = await bridge.waitForResponse(1);
    expect(initializeResponse.result).toMatchObject({
      capabilities: { skills: { configure: false } },
    });

    bridge.sendRequest(2, "skills/configure", {
      roots: [{ id: "global-skills:test", path: workDir, skills: [] }],
    });
    const configureResponse = await bridge.waitForResponse(2);
    expect(configureResponse.error).toBeDefined();
    expect(configureResponse.result).toBeUndefined();
  });

  it("starts the next turn only after the previous agy process exits, in its conversation", async () => {
    bridge.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workDir,
      options: OPTIONS,
      instructionMode: "append",
    });
    const startResponse = await bridge.waitForResponse(1);
    const { providerThreadId } = threadStartResultSchema.parse(
      startResponse.result,
    );

    bridge.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: promptInput("first"),
      clientRequestId: "creq_23456789ab",
      options: OPTIONS,
    });
    bridge.sendRequest(3, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: promptInput("second"),
      clientRequestId: "creq_23456789ac",
      options: OPTIONS,
    });
    await bridge.waitForResponse(2);
    await bridge.waitForResponse(3);

    const lines = await waitForLogLines(logPath, 4);
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    expect(lines[0]).not.toContain("--conversation");
    expect(lines[2]).toContain("--conversation conv-1");
  });

  it.each([
    { steers: ["second"], stop: false },
    { steers: ["second", "third"], stop: false },
    { steers: ["second", "third"], stop: true },
  ])(
    "queues $steers in order after the active turn (stop: $stop)",
    async ({ steers, stop }) => {
      writeFileSync(`${logPath}.blocked`, "");
      bridge.sendRequest(1, "thread/start", {
        threadId: THREAD_ID,
        cwd: workDir,
        options: OPTIONS,
        instructionMode: "append",
      });
      const { providerThreadId } = threadStartResultSchema.parse(
        (await bridge.waitForResponse(1)).result,
      );
      bridge.sendRequest(2, "turn/start", {
        threadId: THREAD_ID,
        providerThreadId,
        input: promptInput("first"),
        clientRequestId: "creq_23456789ab",
        options: OPTIONS,
      });
      expect((await bridge.waitForResponse(2)).error).toBeUndefined();
      await waitForLogLines(logPath, 1);

      for (const [index, text] of steers.entries()) {
        const id = 3 + index;
        bridge.sendRequest(id, "turn/steer", {
          threadId: THREAD_ID,
          providerThreadId,
          expectedTurnId: "turn-1",
          input: promptInput(text),
          clientRequestId: `creq_23456789a${index + 2}`,
          options: OPTIONS,
        });
        expect((await bridge.waitForResponse(id)).error).toBeUndefined();
      }
      expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
      if (stop) {
        bridge.sendRequest(10, "thread/stop", {
          threadId: THREAD_ID,
          providerThreadId,
          intent: "interrupt",
          activeTurnId: "turn-1",
        });
        expect((await bridge.waitForResponse(10)).error).toBeUndefined();
        await bridge.flushWork();
        expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(
          1,
        );
        return;
      }
      rmSync(`${logPath}.blocked`);

      const lines = await waitForLogLines(logPath, 2 * (1 + steers.length));
      expect(lines.map((line) => line.split(" ")[0])).toEqual([
        "start",
        "end",
        ...steers.flatMap(() => ["start", "end"]),
      ]);
      for (const line of lines
        .filter((line) => line.startsWith("start"))
        .slice(1)) {
        expect(line).toContain("--conversation conv-1");
      }
      const inputs = readFileSync(`${logPath}.inputs`, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            z
              .object({ message: z.object({ content: z.string() }) })
              .parse(JSON.parse(line)).message.content,
        );
      expect(inputs).toEqual(["test\n\nfirst", ...steers]);
    },
  );
});
