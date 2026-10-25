import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgyWorkflowSnapshot,
  createAgySubagentWorkflowTracker,
  findAgySubagentLaunches,
  parseAgyTranscript,
} from "./subagent-workflow.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN_START = Date.parse("2026-10-25T07:16:01Z");

let brainRoot: string;

function at(seconds: number): string {
  return new Date(TURN_START + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function transcriptPath(conversationId: string): string {
  return path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

function writeTranscript(conversationId: string, steps: readonly object[]): void {
  const file = transcriptPath(conversationId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, steps.map((step, index) => JSON.stringify({ step_index: index, ...step })).join("\n"));
}

function launchStep(seconds: number, roles: readonly string[]): object {
  return {
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: at(seconds),
    tool_calls: roles.map((role) => ({
      name: "invoke_subagent",
      args: { Role: role, Model: "flash", TypeName: "self", Prompt: `Prompt of ${role}.`, Workspace: "inherit" },
    })),
  };
}

function createdStep(seconds: number, conversationId: string): object {
  const logUri = pathToFileURL(path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl")).href;
  return {
    type: "GENERIC",
    status: "DONE",
    created_at: at(seconds),
    content: `Created At: ${at(seconds)}\nCreated the following subagent:\n{\n  "conversationId":  "${conversationId}",\n  "logAbsoluteUri":  "${logUri}",\n  "workspaceUris":  []\n}\nThe subagent will send you a message when it has completed its task.`,
  };
}

function finishedStep(seconds: number, conversationId: string): object {
  return {
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    created_at: at(seconds),
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${at(seconds)} sender=${conversationId} priority=MESSAGE_PRIORITY_HIGH content=done\n</SYSTEM_MESSAGE>`,
  };
}

function childSteps(seconds: readonly number[], answer?: string): object[] {
  const steps: object[] = [{ type: "USER_INPUT", status: "DONE", created_at: at(seconds[0]), content: "Prompt." }];
  for (const second of seconds.slice(1)) {
    steps.push({
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: at(second),
      tool_calls: [{ name: "run_command", args: { CommandLine: "sleep 20" } }],
    });
  }
  if (answer !== undefined) {
    steps.push({ type: "PLANNER_RESPONSE", status: "DONE", created_at: at(seconds[seconds.length - 1] + 1), content: answer });
  }
  return steps;
}

function createTracker(now: () => number) {
  return createAgySubagentWorkflowTracker({
    itemId: "subagents-test",
    turnStartedAt: TURN_START,
    fallbackModel: "gemini-3.8-flash",
    brainRoot,
    now,
  });
}

beforeEach(() => {
  brainRoot = mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
});

describe("findAgySubagentLaunches", () => {
  it("matches each created subagent to its call in order and marks the ones that reported back", () => {
    writeTranscript(PARENT_ID, [
      { type: "USER_INPUT", status: "DONE", created_at: at(0), content: "Go." },
      launchStep(1, ["Probe A", "Probe B"]),
      createdStep(4, CHILD_A),
      createdStep(4, CHILD_B),
      finishedStep(80, CHILD_B),
    ]);

    const launches = findAgySubagentLaunches(
      parseAgyTranscript(readFileSync(transcriptPath(PARENT_ID), "utf8")),
      TURN_START,
    );

    expect(launches.map((launch) => [launch.role, launch.conversationId, launch.finishedAt !== undefined, launch.phaseIndex])).toEqual([
      ["Probe A", CHILD_A, false, 1],
      ["Probe B", CHILD_B, true, 1],
    ]);
    expect(launches[0].transcriptPath).toBe(transcriptPath(CHILD_A));
    expect(launches[1].finalMessage).toBe("done");
  });

  it("ignores subagents launched by an earlier turn of the same conversation", () => {
    const steps = parseAgyTranscript(
      [
        JSON.stringify({ step_index: 0, ...launchStep(-600, ["Old"]) }),
        JSON.stringify({ step_index: 1, ...createdStep(-599, CHILD_A) }),
        JSON.stringify({ step_index: 2, ...launchStep(2, ["New"]) }),
        "not json",
      ].join("\n"),
    );

    expect(findAgySubagentLaunches(steps, TURN_START - 1000).map((launch) => launch.role)).toEqual(["New"]);
  });
});

describe("buildAgyWorkflowSnapshot", () => {
  it("groups agents into phases named by their role prefix, falling back to the launch wave", () => {
    writeTranscript(PARENT_ID, [
      launchStep(1, ["Review: correctness", "Review: security"]),
      launchStep(30, ["Verify: src/a.ts:3", "Probe"]),
      launchStep(40, ["Review: late", ": no phase", "Trailing: "]),
    ]);
    const launches = findAgySubagentLaunches(parseAgyTranscript(readFileSync(transcriptPath(PARENT_ID), "utf8")), TURN_START);

    const snapshot = buildAgyWorkflowSnapshot({ launches, childSteps: new Map(), fallbackModel: "gemini-3.8-flash", now: TURN_START });

    expect(snapshot.phases).toEqual([
      { index: 1, title: "Review" },
      { index: 2, title: "Verify" },
      { index: 3, title: "Wave 2" },
      { index: 4, title: "Wave 3" },
    ]);
    expect(snapshot.agents.map((agent) => [agent.label, agent.phaseIndex, agent.phaseTitle])).toEqual([
      ["correctness", 1, "Review"],
      ["security", 1, "Review"],
      ["src/a.ts:3", 2, "Verify"],
      ["Probe", 3, "Wave 2"],
      ["late", 1, "Review"],
      [": no phase", 4, "Wave 3"],
      ["Trailing: ", 4, "Wave 3"],
    ]);
  });
});

describe("createAgySubagentWorkflowTracker", () => {
  it("opens a workflow item once subagents start, updates it as they work and closes it at the turn end", () => {
    let nowMs = TURN_START + 5000;
    const tracker = createTracker(() => nowMs);

    expect(tracker.poll(null)).toEqual([]);
    expect(tracker.poll(PARENT_ID)).toEqual([]);

    writeTranscript(PARENT_ID, [launchStep(1, ["Probe A", "Probe B"]), createdStep(4, CHILD_A)]);
    const opened = tracker.poll(PARENT_ID);
    expect(opened.map((delta) => delta.kind)).toEqual(["item.open", "item.progress"]);
    const openDelta = opened[0];
    expect(openDelta.kind === "item.open" && openDelta.item.type === "backgroundTask" && openDelta.item.taskType).toBe("local_workflow");
    const firstProgress = opened[1];
    expect(firstProgress.kind === "item.progress" && firstProgress.flush).toBe(true);
    const firstAgents = firstProgress.kind === "item.progress" && firstProgress.snapshot?.type === "backgroundTask"
      ? firstProgress.snapshot.workflow?.agents
      : undefined;
    expect(firstAgents?.map((agent) => [agent.label, agent.state, agent.model, agent.phaseTitle])).toEqual([
      ["Probe A", "running", "flash", "Wave 1"],
      ["Probe B", "queued", "flash", "Wave 1"],
    ]);

    expect(tracker.poll(PARENT_ID)).toEqual([]);

    writeTranscript(CHILD_A, childSteps([5, 10, 30]));
    nowMs = TURN_START + 31000;
    const working = tracker.poll(PARENT_ID);
    expect(working).toHaveLength(1);
    const workingDelta = working[0];
    expect(workingDelta.kind === "item.progress" && workingDelta.flush).toBeUndefined();
    const workingAgent = workingDelta.kind === "item.progress" && workingDelta.snapshot?.type === "backgroundTask"
      ? workingDelta.snapshot.workflow?.agents[0]
      : undefined;
    expect([workingAgent?.toolCalls, workingAgent?.lastToolName, workingAgent?.durationMs]).toEqual([2, "run_command", 26000]);

    writeTranscript(PARENT_ID, [
      launchStep(1, ["Probe A", "Probe B"]),
      createdStep(4, CHILD_A),
      createdStep(4, CHILD_B),
      finishedStep(60, CHILD_A),
    ]);
    writeTranscript(CHILD_A, childSteps([5, 10, 30], "All three commands ran."));
    writeTranscript(CHILD_B, childSteps([6, 12]));

    const closing = tracker.finish(PARENT_ID, "completed");
    expect(closing.map((delta) => delta.kind)).toEqual(["item.progress", "item.close"]);
    const closeDelta = closing[1];
    expect(closeDelta.kind === "item.close" && closeDelta.status).toBe("completed");
    const finalAgents = closeDelta.kind === "item.close" && closeDelta.item.type === "backgroundTask"
      ? closeDelta.item.workflow?.agents
      : undefined;
    expect(finalAgents?.map((agent) => [agent.label, agent.state, agent.resultPreview ?? null, agent.durationMs])).toEqual([
      ["Probe A", "done", "All three commands ran.", 55000],
      ["Probe B", "running", null, 25000],
    ]);
    expect(closeDelta.kind === "item.close" && closeDelta.item.type === "backgroundTask" && closeDelta.item.taskStatus).toBe("completed");

    expect(tracker.poll(PARENT_ID)).toEqual([]);
    expect(tracker.finish(PARENT_ID, "completed")).toEqual([]);
  });

  it("emits nothing for a turn that starts no subagents", () => {
    writeTranscript(PARENT_ID, [
      { type: "USER_INPUT", status: "DONE", created_at: at(0), content: "Hi." },
      { type: "PLANNER_RESPONSE", status: "DONE", created_at: at(1), content: "Hello." },
    ]);
    const tracker = createTracker(() => TURN_START + 2000);

    expect(tracker.poll(PARENT_ID)).toEqual([]);
    expect(tracker.finish(PARENT_ID, "completed")).toEqual([]);
  });

  it("marks a subagent whose last step failed and stops the workflow when the turn is interrupted", () => {
    writeTranscript(PARENT_ID, [launchStep(1, ["Probe A"]), createdStep(2, CHILD_A)]);
    writeTranscript(CHILD_A, [
      { type: "USER_INPUT", status: "DONE", created_at: at(3), content: "Prompt." },
      { type: "PLANNER_RESPONSE", status: "ERROR", created_at: at(9), content: "" },
    ]);
    const tracker = createTracker(() => TURN_START + 20000);

    tracker.poll(PARENT_ID);
    const closing = tracker.finish(PARENT_ID, "interrupted");

    const closeDelta = closing.at(-1);
    expect(closeDelta?.kind === "item.close" && closeDelta.status).toBe("interrupted");
    const item = closeDelta?.kind === "item.close" && closeDelta.item.type === "backgroundTask" ? closeDelta.item : undefined;
    expect(item?.taskStatus).toBe("stopped");
    expect(item?.workflow?.agents.map((agent) => [agent.state, agent.durationMs])).toEqual([["failed", 6000]]);
  });
});
