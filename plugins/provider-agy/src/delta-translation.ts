import { z } from "zod";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  toNonNegativeNumber,
  toOptionalString,
  type DeltaItemShape,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { resolveAgyModelContextWindow } from "./model-list.js";

const ASSISTANT_STREAM_KEY = "assistant";
const THOUGHT_STREAM_KEY = "thought";
const SUBAGENT_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "invoke_subagent",
  "manage_subagents",
]);

export const agyUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    thinking_tokens: z.number().optional(),
    cache_read_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

export const agyToolErrorSchema = z
  .object({
    type: z.string().optional(),
    message: z.string(),
  })
  .passthrough();

export const agyToolInfoSchema = z
  .object({
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    call_id: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    output: z.string().optional(),
    error: agyToolErrorSchema.optional(),
  })
  .passthrough();

export const agySubagentSpecSchema = z
  .object({
    type_name: z.string().optional(),
    role: z.string().optional(),
    initial_prompt: z.string().optional(),
    conversation_id: z.string().optional(),
    log_uri: z.string().optional(),
    workspace_uris: z.array(z.string()).optional(),
  })
  .passthrough();

export const agySubagentInfoSchema = z
  .object({
    subagents: z.array(agySubagentSpecSchema).default([]),
  })
  .passthrough();

export const agyStepUpdatePayloadSchema = z
  .object({
    conversation_id: z.string(),
    step_index: z.number(),
    state: z.string(),
    step_type: z.string().optional(),
    tool_name: z.string().optional(),
    text_delta: z.string().optional(),
    thinking_delta: z.string().optional(),
    thinking: z.string().optional(),
    duration_seconds: z.number().optional(),
    usage: agyUsageSchema.optional(),
    tool_info: agyToolInfoSchema.optional(),
    subagent_info: agySubagentInfoSchema.optional(),
  })
  .passthrough();

export const agyDeniedActionSchema = z
  .object({
    action: z.string().optional(),
    display_name: z.string(),
  })
  .passthrough();

export const agyResultPayloadSchema = z
  .object({
    conversation_id: z.string().optional(),
    status: z.string(),
    response: z.string().optional(),
    error: z.string().optional(),
    duration_seconds: z.number().optional(),
    num_turns: z.number().optional(),
    usage: agyUsageSchema.optional(),
    denied_actions: z.array(agyDeniedActionSchema).optional(),
  })
  .passthrough();

export const agyInitPayloadSchema = z
  .object({
    model: z.string().optional(),
    cwd: z.string().optional(),
    agent: z.string().optional(),
    tools: z.array(z.string()).optional(),
    permission_mode: z.string().optional(),
  })
  .passthrough();

export const agyStreamEventSchema = z
  .object({
    event: z.enum(["init", "step_update", "result"]),
    conversation_id: z.string().optional(),
    init: agyInitPayloadSchema.optional(),
    step_update: agyStepUpdatePayloadSchema.optional(),
    result: agyResultPayloadSchema.optional(),
  })
  .passthrough();

export type AgyStreamEvent = z.infer<typeof agyStreamEventSchema>;

function classifyAgyToolShape(
  toolName: string,
  params: Record<string, unknown> | undefined,
  cwd: string,
): DeltaItemShape {
  if (toolName === "run_command") {
    const command =
      toOptionalString(params?.CommandLine) ??
      toOptionalString(params?.command) ??
      "run_command";
    const commandCwd =
      toOptionalString(params?.Cwd) ?? toOptionalString(params?.cwd) ?? cwd;
    return {
      type: "command",
      command,
      cwd: commandCwd,
    };
  }

  if (toolName === "view_file" || toolName === "read_file") {
    const path =
      toOptionalString(params?.AbsolutePath) ??
      toOptionalString(params?.Path) ??
      toOptionalString(params?.path);
    if (path) {
      return { type: "fileRead", path };
    }
  }

  if (
    toolName === "write_to_file" ||
    toolName === "write_file" ||
    toolName === "replace_file_content" ||
    toolName === "multi_replace_file_content" ||
    toolName === "edit_file" ||
    toolName === "sed_file"
  ) {
    const path =
      toOptionalString(params?.TargetFile) ??
      toOptionalString(params?.Path) ??
      toOptionalString(params?.path);
    if (path) {
      const isCreate =
        toolName === "write_to_file" || toolName === "write_file";
      const oldText =
        toOptionalString(params?.TargetContent) ??
        toOptionalString(params?.Target);
      const newText =
        toOptionalString(params?.ReplacementContent) ??
        toOptionalString(params?.Replacement) ??
        toOptionalString(params?.CodeContent) ??
        toOptionalString(params?.Content);
      return {
        type: "fileChange",
        changes: [
          {
            path,
            kind: isCreate ? "add" : "update",
            ...(oldText === undefined ? {} : { oldText }),
            ...(newText === undefined ? {} : { newText }),
          },
        ],
      };
    }
  }

  if (toolName === "grep_search" || toolName === "find_by_name") {
    const query =
      toOptionalString(params?.Query) ??
      toOptionalString(params?.Pattern) ??
      toolName;
    const searchPath =
      toOptionalString(params?.SearchPath) ??
      toOptionalString(params?.SearchDirectory);
    return {
      type: "search",
      mode: toolName === "find_by_name" ? "path" : "content",
      query,
      ...(searchPath === undefined ? {} : { path: searchPath }),
    };
  }

  if (toolName === "search_web") {
    const query = toOptionalString(params?.query) ?? "web search";
    return {
      type: "webSearch",
      queries: [query],
    };
  }

  if (toolName === "read_url_content") {
    const url =
      toOptionalString(params?.Url) ?? toOptionalString(params?.url);
    if (url) {
      return {
        type: "webFetch",
        url,
        pattern: null,
      };
    }
  }

  return {
    type: "tool",
    tool: toolName,
    ...(params === undefined ? {} : { args: params }),
  };
}

function toTokenUsageBreakdown(
  usage: z.infer<typeof agyUsageSchema> | undefined,
): ThreadEventTokenUsageBreakdown | undefined {
  if (!usage) return undefined;
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const reasoningOutputTokens = toNonNegativeNumber(usage.thinking_tokens);
  const cacheReadInputTokens = toNonNegativeNumber(usage.cache_read_tokens);
  const totalTokens = toNonNegativeNumber(usage.total_tokens);
  return {
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens + reasoningOutputTokens,
    inputTokens,
    cachedInputTokens: cacheReadInputTokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    outputTokens,
    reasoningOutputTokens,
  };
}

function assistantStreamKey(stepIndex: number): { channel: string } {
  return { channel: `${ASSISTANT_STREAM_KEY}-${String(stepIndex)}` };
}

function completeStepText(streamedText: string, doneText: string): string {
  return doneText.startsWith(streamedText)
    ? doneText
    : `${streamedText}${doneText}`;
}

function preferFullResponse(stepText: string, response: string): string {
  const isResponseFullerVersion =
    response.trim().length > stepText.trim().length &&
    response.trim().startsWith(stepText.trim());
  return isResponseFullerVersion ? response : stepText;
}

interface ThreadTranslationState {
  cumulativeUsage: ThreadEventTokenUsageBreakdown;
  openedSteps: Map<string, DeltaItemShape>;
  assistantTextByStep: Map<number, string>;
  streamedThinkingText: string;
  turnSeq: number;
  model: string | undefined;
}

export interface AgyDeltaTranslator {
  translateEvent(
    rawEvent: unknown,
    context: { threadId: string; cwd: string; model?: string },
  ): ThreadDelta[];
  resetThread(threadId: string): void;
}

export function createAgyDeltaTranslator(): AgyDeltaTranslator {
  const stateByThread = new Map<string, ThreadTranslationState>();

  function getThreadState(
    threadId: string,
    model?: string,
  ): ThreadTranslationState {
    let state = stateByThread.get(threadId);
    if (!state) {
      state = {
        cumulativeUsage: ZERO_TOKEN_USAGE,
        openedSteps: new Map(),
        assistantTextByStep: new Map(),
        streamedThinkingText: "",
        turnSeq: 0,
        model,
      };
      stateByThread.set(threadId, state);
    } else if (model !== undefined) {
      state.model = model;
    }
    return state;
  }

  function resetThread(threadId: string): void {
    stateByThread.delete(threadId);
  }

  function translateEvent(
    rawEvent: unknown,
    context: { threadId: string; cwd: string; model?: string },
  ): ThreadDelta[] {
    const parsed = agyStreamEventSchema.safeParse(rawEvent);
    if (!parsed.success) return [];
    const event = parsed.data;
    const state = getThreadState(context.threadId, context.model);

    if (event.event === "init") {
      if (event.init?.model) {
        state.model = event.init.model;
      }
      const convId = event.conversation_id;
      if (convId && convId.length > 0) {
        return [{ kind: "thread.identity", providerThreadId: convId }];
      }
      return [];
    }

    if (event.event === "step_update" && event.step_update) {
      const step = event.step_update;
      const stepType = step.step_type ?? "unknown";
      const rawToolId = step.tool_info?.tool_call_id ?? step.tool_info?.call_id;
      const itemId =
        rawToolId ??
        `${step.conversation_id || context.threadId}-t${state.turnSeq}-step-${step.step_index}`;

      if (stepType === "agent_response" || stepType === "planner_response") {
        const deltas: ThreadDelta[] = [];
        if (
          step.state === "ACTIVE" &&
          step.thinking_delta &&
          step.thinking_delta.length > 0
        ) {
          state.streamedThinkingText += step.thinking_delta;
          deltas.push({
            kind: "item.textDelta",
            key: { channel: THOUGHT_STREAM_KEY },
            channel: "reasoningText",
            text: step.thinking_delta,
          });
        }
        if (
          step.state === "ACTIVE" &&
          step.text_delta &&
          step.text_delta.length > 0
        ) {
          const streamedText =
            state.assistantTextByStep.get(step.step_index) ?? "";
          state.assistantTextByStep.set(
            step.step_index,
            `${streamedText}${step.text_delta}`,
          );
          deltas.push({
            kind: "item.textDelta",
            key: assistantStreamKey(step.step_index),
            channel: "agentMessage",
            text: step.text_delta,
          });
        }
        if (step.state === "DONE" && step.text_delta) {
          const streamedText =
            state.assistantTextByStep.get(step.step_index) ?? "";
          state.assistantTextByStep.set(
            step.step_index,
            completeStepText(streamedText, step.text_delta),
          );
        }
        return deltas;
      }

      const toolName = step.tool_info?.name ?? step.tool_name;
      const isSubagentStep =
        stepType === "subagent" ||
        stepType === "invoke_subagent" ||
        step.subagent_info !== undefined ||
        (toolName !== undefined && SUBAGENT_WORKFLOW_TOOL_NAMES.has(toolName));
      if (isSubagentStep) {
        return [];
      }

      if (
        stepType === "tool" ||
        step.tool_info !== undefined ||
        toolName !== undefined
      ) {
        const shape =
          state.openedSteps.get(itemId) ??
          classifyAgyToolShape(
            toolName ?? "tool",
            step.tool_info?.parameters,
            context.cwd,
          );
        const deltas: ThreadDelta[] = [];
        if (!state.openedSteps.has(itemId)) {
          state.openedSteps.set(itemId, shape);
          deltas.push({
            kind: "item.open",
            key: { providerItemId: itemId },
            item: shape,
          });
        }
        if (step.state === "DONE" || step.state === "ERROR") {
          state.openedSteps.delete(itemId);
          const isError =
            step.state === "ERROR" || step.tool_info?.error !== undefined;
          const outputText =
            step.tool_info?.error?.message ?? step.tool_info?.output;
          deltas.push({
            kind: "item.close",
            key: { providerItemId: itemId },
            status: isError ? "failed" : "completed",
            ...(shape.type === "command"
              ? {
                  exitCode: isError ? 1 : 0,
                  ...(outputText === undefined
                    ? {}
                    : { aggregatedOutput: outputText }),
                }
              : outputText === undefined
                ? {}
                : { resultText: outputText }),
            item: shape,
          });
        }
        return deltas;
      }

      if (stepType === "error_message") {
        return [
          {
            kind: "provider.error",
            message: "Antigravity step error",
            ...(step.text_delta ? { detail: step.text_delta } : {}),
          },
        ];
      }

      return [];
    }

    if (event.event === "result" && event.result) {
      const result = event.result;
      const deltas: ThreadDelta[] = [];
      state.turnSeq += 1;

      if (
        result.conversation_id &&
        result.conversation_id.length > 0
      ) {
        deltas.push({
          kind: "thread.identity",
          providerThreadId: result.conversation_id,
        });
      }

      for (const [openItemId, shape] of state.openedSteps.entries()) {
        deltas.push({
          kind: "item.close",
          key: { providerItemId: openItemId },
          status: result.status === "SUCCESS" ? "completed" : "failed",
          item: shape,
        });
      }
      state.openedSteps.clear();

      const finalThinking = state.streamedThinkingText.trim();
      if (finalThinking.length > 0) {
        deltas.push({
          kind: "item.textClose",
          key: { channel: THOUGHT_STREAM_KEY },
          channel: "reasoningText",
          text: finalThinking,
        });
      }
      state.streamedThinkingText = "";

      const response = result.response ?? "";
      const stepIndexes = [...state.assistantTextByStep.keys()];
      const lastStepIndex = stepIndexes[stepIndexes.length - 1];
      for (const [stepIndex, stepText] of state.assistantTextByStep) {
        const finalStepText = (
          stepIndex === lastStepIndex
            ? preferFullResponse(stepText, response)
            : stepText
        ).trim();
        if (finalStepText.length === 0) continue;
        deltas.push({
          kind: "item.textClose",
          key: assistantStreamKey(stepIndex),
          channel: "agentMessage",
          text: finalStepText,
        });
      }
      const lastStepText =
        lastStepIndex === undefined
          ? ""
          : (state.assistantTextByStep.get(lastStepIndex) ?? "").trim();
      const isResponseCoveredByLastStep =
        lastStepText.length > 0 && response.trim().startsWith(lastStepText);
      if (!isResponseCoveredByLastStep && response.trim().length > 0) {
        deltas.push({
          kind: "item.textDelta",
          key: { channel: ASSISTANT_STREAM_KEY },
          channel: "agentMessage",
          text: response,
        });
        deltas.push({
          kind: "item.textClose",
          key: { channel: ASSISTANT_STREAM_KEY },
          channel: "agentMessage",
          text: response.trim(),
        });
      }
      state.assistantTextByStep.clear();

      if (result.denied_actions && result.denied_actions.length > 0) {
        const names = result.denied_actions
          .map((item) => item.display_name)
          .join(", ");
        deltas.push({
          kind: "provider.warning",
          summary: `Denied actions in headless mode: ${names}`,
        });
      }

      const usage = toTokenUsageBreakdown(result.usage);
      if (usage && usage.totalTokens > 0) {
        state.cumulativeUsage = addTokenUsage(state.cumulativeUsage, usage);
        const contextWindow = resolveAgyModelContextWindow(state.model);
        deltas.push({
          kind: "usage",
          total: state.cumulativeUsage,
          last: usage,
          modelContextWindow: contextWindow,
        });
        deltas.push({
          kind: "contextWindow",
          used: usage.totalTokens,
          size: contextWindow,
          estimated: false,
          attach: "currentOrLast",
        });
      }

      if (result.status === "ERROR") {
        deltas.push({
          kind: "provider.error",
          message: "Antigravity turn failed",
          ...(result.error ? { detail: result.error } : {}),
        });
        deltas.push({
          kind: "turn.boundary",
          status: "failed",
          ...(result.error ? { error: { message: result.error } } : {}),
          claimIfIdle: true,
        });
      } else {
        deltas.push({
          kind: "turn.boundary",
          status:
            result.status === "INTERRUPTED" ? "interrupted" : "completed",
          claimIfIdle: true,
        });
      }

      return deltas;
    }

    return [];
  }

  return { translateEvent, resetThread };
}
