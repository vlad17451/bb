import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LOCAL_WORKFLOW_TASK_TYPE,
  experimental_presentationTitle as presentationTitle,
  experimental_withTitle as withTitle,
  type BackgroundTaskStatus,
  type DeltaBackgroundTaskShape,
  type DeltaPresentation,
  type ThreadDelta,
  type WorkflowAgentSnapshot,
  type WorkflowProgressSnapshot,
} from "@get-bb/plugin-sdk/provider-bridge";

const SUBAGENT_TOOL_NAME = "invoke_subagent";
const SUBAGENT_CREATED_MARKER = "Created the following subagent:";
const PREVIEW_LENGTH = 400;
const WORKFLOW_NAME = "Antigravity subagents";

const transcriptStepSchema = z
  .object({
    step_index: z.number(),
    type: z.string(),
    status: z.string().optional(),
    created_at: z.string(),
    content: z.string().optional(),
    tool_calls: z
      .array(
        z
          .object({
            name: z.string(),
            args: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface AgyTranscriptStep {
  type: string;
  status: string;
  createdAt: number;
  content: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

export function parseAgyTranscript(text: string): AgyTranscriptStep[] {
  const steps: AgyTranscriptStep[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = transcriptStepSchema.safeParse(raw);
    if (!parsed.success) continue;
    const createdAt = Date.parse(parsed.data.created_at);
    if (Number.isNaN(createdAt)) continue;
    steps.push({
      type: parsed.data.type,
      status: parsed.data.status ?? "",
      createdAt,
      content: parsed.data.content ?? "",
      toolCalls: (parsed.data.tool_calls ?? []).map((call) => ({
        name: call.name,
        args: call.args ?? {},
      })),
    });
  }
  return steps;
}

export interface AgySubagentLaunch {
  phaseIndex: number;
  role: string;
  model: string | undefined;
  typeName: string | undefined;
  prompt: string | undefined;
  launchedAt: number;
  conversationId: string | undefined;
  transcriptPath: string | undefined;
  finishedAt: number | undefined;
  finalMessage: string | undefined;
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function transcriptPathFromLogUri(logUri: string): string | undefined {
  try {
    return path.join(path.dirname(fileURLToPath(logUri)), "transcript_full.jsonl");
  } catch {
    return undefined;
  }
}

function parseCreatedSubagent(
  content: string,
): { conversationId: string; transcriptPath: string | undefined } | null {
  if (!content.includes(SUBAGENT_CREATED_MARKER)) return null;
  const conversationId = /"conversationId":\s*"([^"]+)"/.exec(content)?.[1];
  if (conversationId === undefined) return null;
  const logUri = /"logAbsoluteUri":\s*"([^"]+)"/.exec(content)?.[1];
  return {
    conversationId,
    transcriptPath:
      logUri === undefined ? undefined : transcriptPathFromLogUri(logUri),
  };
}

function parseSubagentMessage(
  content: string,
): { sender: string; text: string } | null {
  const match =
    /\[Message\][^\n]*?sender=([^\s]+)[^\n]*?content=([\s\S]*?)\n?<\/SYSTEM_MESSAGE>/.exec(
      content,
    );
  if (match === null) return null;
  return { sender: match[1], text: match[2].trim() };
}

export function findAgySubagentLaunches(
  parentSteps: readonly AgyTranscriptStep[],
  sinceMs: number,
): AgySubagentLaunch[] {
  const launches: AgySubagentLaunch[] = [];
  let unmatchedLaunches: AgySubagentLaunch[] = [];
  let phaseCount = 0;
  for (const step of parentSteps) {
    if (step.createdAt < sinceMs) continue;
    if (step.type === "PLANNER_RESPONSE") {
      const subagentCalls = step.toolCalls.filter(
        (call) => call.name === SUBAGENT_TOOL_NAME,
      );
      if (subagentCalls.length === 0) continue;
      phaseCount += 1;
      unmatchedLaunches = subagentCalls.map((call) => ({
        phaseIndex: phaseCount,
        role: stringArg(call.args, "Role") ?? "Subagent",
        model: stringArg(call.args, "Model"),
        typeName: stringArg(call.args, "TypeName"),
        prompt: stringArg(call.args, "Prompt"),
        launchedAt: step.createdAt,
        conversationId: undefined,
        transcriptPath: undefined,
        finishedAt: undefined,
        finalMessage: undefined,
      }));
      launches.push(...unmatchedLaunches);
      continue;
    }
    const created = parseCreatedSubagent(step.content);
    if (created !== null) {
      const launch = unmatchedLaunches.shift();
      if (launch === undefined) continue;
      launch.conversationId = created.conversationId;
      launch.transcriptPath = created.transcriptPath;
      continue;
    }
    if (step.type !== "SYSTEM_MESSAGE") continue;
    const message = parseSubagentMessage(step.content);
    if (message === null) continue;
    const finished = launches.find(
      (launch) =>
        launch.conversationId === message.sender &&
        launch.finishedAt === undefined,
    );
    if (finished === undefined) continue;
    finished.finishedAt = step.createdAt;
    finished.finalMessage = message.text;
  }
  return launches;
}

function preview(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.length > PREVIEW_LENGTH
    ? `${trimmed.slice(0, PREVIEW_LENGTH)}…`
    : trimmed;
}

function lastAnswerOf(steps: readonly AgyTranscriptStep[]): string | undefined {
  const answers = steps.filter(
    (step) =>
      step.type === "PLANNER_RESPONSE" &&
      step.toolCalls.length === 0 &&
      step.content.trim().length > 0,
  );
  return answers.at(-1)?.content;
}

const PHASE_SEPARATOR = ": ";

function splitRole(launch: AgySubagentLaunch): { phaseTitle: string; label: string } {
  const separatorIndex = launch.role.indexOf(PHASE_SEPARATOR);
  const hasPhasePrefix =
    separatorIndex > 0 &&
    separatorIndex + PHASE_SEPARATOR.length < launch.role.length;
  if (!hasPhasePrefix) {
    return { phaseTitle: `Wave ${String(launch.phaseIndex)}`, label: launch.role };
  }
  return {
    phaseTitle: launch.role.slice(0, separatorIndex),
    label: launch.role.slice(separatorIndex + PHASE_SEPARATOR.length),
  };
}

export function buildAgyWorkflowSnapshot(args: {
  launches: readonly AgySubagentLaunch[];
  childSteps: ReadonlyMap<string, readonly AgyTranscriptStep[]>;
  fallbackModel: string;
  now: number;
}): WorkflowProgressSnapshot {
  const roles = args.launches.map(splitRole);
  const phaseTitles = [...new Set(roles.map((role) => role.phaseTitle))];
  const phases = phaseTitles.map((title, position) => ({
    index: position + 1,
    title,
  }));
  const agents = args.launches.map((launch, position): WorkflowAgentSnapshot => {
    const { phaseTitle, label } = roles[position];
    const steps =
      launch.conversationId === undefined
        ? []
        : (args.childSteps.get(launch.conversationId) ?? []);
    const toolCalls = steps.flatMap((step) => step.toolCalls);
    const startedAt = steps[0]?.createdAt ?? launch.launchedAt;
    const lastStepAt = steps.at(-1)?.createdAt ?? launch.launchedAt;
    const hasFailed = steps.at(-1)?.status === "ERROR";
    const isFinished = launch.finishedAt !== undefined;
    const state =
      launch.conversationId === undefined
        ? "queued"
        : hasFailed
          ? "failed"
          : isFinished
            ? "done"
            : "running";
    const endedAt = launch.finishedAt ?? (hasFailed ? lastStepAt : args.now);
    const lastTool = toolCalls.at(-1);
    const promptPreview = preview(launch.prompt);
    const resultPreview = isFinished
      ? preview(lastAnswerOf(steps) ?? launch.finalMessage)
      : undefined;
    return {
      index: position + 1,
      label,
      state,
      model: launch.model ?? args.fallbackModel,
      attempt: 1,
      cached: false,
      lastProgressAt: launch.finishedAt ?? lastStepAt,
      phaseIndex: phaseTitles.indexOf(phaseTitle) + 1,
      phaseTitle,
      ...(launch.typeName === undefined ? {} : { agentType: launch.typeName }),
      queuedAt: launch.launchedAt,
      ...(state === "queued" ? {} : { startedAt }),
      ...(lastTool === undefined ? {} : { lastToolName: lastTool.name }),
      ...(promptPreview === undefined ? {} : { promptPreview }),
      ...(resultPreview === undefined ? {} : { resultPreview }),
      toolCalls: toolCalls.length,
      ...(state === "queued"
        ? {}
        : { durationMs: Math.max(0, endedAt - startedAt) }),
    };
  });
  return { phases, agents };
}

export type AgyTurnEndStatus = "completed" | "failed" | "interrupted";

const TASK_STATUS_BY_TURN_END: Record<AgyTurnEndStatus, BackgroundTaskStatus> =
  {
    completed: "completed",
    failed: "failed",
    interrupted: "stopped",
  };

function workflowPresentation(): DeltaPresentation {
  return withTitle(
    {
      label: {
        pending: "Running subagents",
        completed: "Subagents finished",
      },
      icon: { glyph: "Workflow" },
    },
    presentationTitle(WORKFLOW_NAME),
  );
}

interface CachedTranscript {
  size: number;
  steps: AgyTranscriptStep[];
}

export interface AgySubagentWorkflowTracker {
  poll(conversationId: string | null): ThreadDelta[];
  finish(
    conversationId: string | null,
    status: AgyTurnEndStatus,
  ): ThreadDelta[];
}

export function agyBrainRoot(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

export function createAgySubagentWorkflowTracker(options: {
  itemId: string;
  turnStartedAt: number;
  fallbackModel: string;
  brainRoot: string;
  now?: () => number;
}): AgySubagentWorkflowTracker {
  const now = options.now ?? Date.now;
  const sinceMs = Math.floor(options.turnStartedAt / 1000) * 1000 - 1000;
  const transcripts = new Map<string, CachedTranscript>();
  let isOpen = false;
  let isClosed = false;
  let lastSnapshotJson = "";
  let lastStatesJson = "";

  function readTranscript(transcriptPath: string): AgyTranscriptStep[] {
    let size: number;
    try {
      size = statSync(transcriptPath).size;
    } catch {
      return [];
    }
    const cached = transcripts.get(transcriptPath);
    if (cached !== undefined && cached.size === size) return cached.steps;
    let text: string;
    try {
      text = readFileSync(transcriptPath, "utf8");
    } catch {
      return cached?.steps ?? [];
    }
    const steps = parseAgyTranscript(text);
    transcripts.set(transcriptPath, { size, steps });
    return steps;
  }

  function parentTranscriptPath(conversationId: string): string {
    return path.join(
      options.brainRoot,
      conversationId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
  }

  function currentSnapshot(
    conversationId: string,
  ): WorkflowProgressSnapshot | null {
    const launches = findAgySubagentLaunches(
      readTranscript(parentTranscriptPath(conversationId)),
      sinceMs,
    );
    if (launches.length === 0) return null;
    const childSteps = new Map<string, AgyTranscriptStep[]>();
    for (const launch of launches) {
      if (launch.conversationId === undefined) continue;
      const transcriptPath =
        launch.transcriptPath ?? parentTranscriptPath(launch.conversationId);
      childSteps.set(launch.conversationId, readTranscript(transcriptPath));
    }
    return buildAgyWorkflowSnapshot({
      launches,
      childSteps,
      fallbackModel: options.fallbackModel,
      now: now(),
    });
  }

  function shape(
    workflow: WorkflowProgressSnapshot,
    taskStatus: BackgroundTaskStatus,
    status: DeltaBackgroundTaskShape["status"],
  ): DeltaBackgroundTaskShape {
    return {
      type: "backgroundTask",
      familyId: options.itemId,
      taskType: LOCAL_WORKFLOW_TASK_TYPE,
      description: WORKFLOW_NAME,
      status,
      taskStatus,
      skipTranscript: false,
      workflowName: WORKFLOW_NAME,
      workflow,
    };
  }

  function poll(conversationId: string | null): ThreadDelta[] {
    if (conversationId === null || isClosed) return [];
    const workflow = currentSnapshot(conversationId);
    if (workflow === null) return [];
    const key = { providerItemId: options.itemId };
    const deltas: ThreadDelta[] = [];
    const item = shape(workflow, "running", "pending");
    if (!isOpen) {
      isOpen = true;
      deltas.push({
        kind: "item.open",
        key,
        item,
        presentation: workflowPresentation(),
      });
    }
    const snapshotJson = JSON.stringify(workflow);
    if (snapshotJson === lastSnapshotJson) return deltas;
    lastSnapshotJson = snapshotJson;
    const statesJson = JSON.stringify(
      workflow.agents.map((agent) => agent.state),
    );
    const hasStateChange = statesJson !== lastStatesJson;
    lastStatesJson = statesJson;
    deltas.push({
      kind: "item.progress",
      key,
      snapshot: item,
      ...(hasStateChange ? { flush: true } : {}),
    });
    return deltas;
  }

  function finish(
    conversationId: string | null,
    status: AgyTurnEndStatus,
  ): ThreadDelta[] {
    const deltas = poll(conversationId);
    if (!isOpen || isClosed || conversationId === null) return deltas;
    isClosed = true;
    const workflow = currentSnapshot(conversationId);
    if (workflow === null) return deltas;
    deltas.push({
      kind: "item.close",
      key: { providerItemId: options.itemId },
      status,
      item: shape(workflow, TASK_STATUS_BY_TURN_END[status], status),
    });
    return deltas;
  }

  return { poll, finish };
}
