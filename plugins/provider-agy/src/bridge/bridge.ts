#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type InitializeResult,
  type ReasoningLevel,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { createAgyDeltaTranslator } from "../delta-translation.js";
import { buildAgyAvailableModels } from "../model-list.js";
import {
  getAgyProviderHealth,
  getAgyProviderInstallationRun,
  getAgyProviderInstallationStatus,
  getAgyProviderUsage,
  resolveAgyExecutablePath,
} from "./provider-maintenance.js";
import { startAgyTurn, type AgyRunningTurn } from "./session-runner.js";
import { extractAgyPromptText } from "./turn-input.js";

const agyCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
]);

type AgyCommand = z.infer<typeof agyCommandSchema>;

const agyCommandMethodValues = agyCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedAgyBridgeRequest =
  | { kind: "request"; request: AgyCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodeAgyJsonRpcRequest(raw: unknown): DecodedAgyBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = agyCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }
  if (
    !(agyCommandMethodValues as readonly string[]).includes(
      envelope.data.method,
    )
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface AgyThreadSession {
  threadId: string;
  providerThreadId: string;
  conversationId: string | null;
  cwd: string;
  baseInstructions?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  permissionMode?: string;
  agyMode?: string;
  sandboxEnabled?: boolean;
  envVars?: Record<string, string>;
  activeTurn: AgyRunningTurn | null;
  previousTurnFinished: Promise<void>;
}

const { send, sendResult, sendError } =
  createBridgeIo<BridgeEventNotification>();

const sessions = new Map<string, AgyThreadSession>();
const deltaTranslator = createAgyDeltaTranslator();

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) return;
  send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
}

function extractProviderOptionBoolean(
  providerOptions: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const val = providerOptions?.[key];
  return typeof val === "boolean" ? val : undefined;
}

function extractProviderOptionString(
  providerOptions: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const val = providerOptions?.[key];
  return typeof val === "string" ? val : undefined;
}

async function handleModelList(id: string | number): Promise<void> {
  const resolved = await resolveAgyExecutablePath();
  if (resolved === null) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
      "Could not find the agy CLI on this host. Install Antigravity CLI (`agy`) and retry.",
    );
    return;
  }
  sendResult(id, buildAgyAvailableModels());
}

function startOrResumeSession(
  id: string | number,
  params: z.infer<typeof threadStartParamsSchema>,
  existingProviderThreadId: string | null,
): void {
  const existing = sessions.get(params.threadId);
  if (existing?.activeTurn) {
    existing.activeTurn.cancel();
  }
  const isRealConversationId =
    existingProviderThreadId !== null &&
    !existingProviderThreadId.startsWith("agy_");
  const providerThreadId =
    existingProviderThreadId ?? `agy_${randomUUID()}`;
  const providerOptions = params.options.providerOptions;
  const session: AgyThreadSession = {
    threadId: params.threadId,
    providerThreadId,
    conversationId: isRealConversationId ? existingProviderThreadId : null,
    cwd: params.cwd,
    baseInstructions: params.options.instructions,
    model: params.options.model,
    reasoningLevel: params.options.reasoningLevel,
    permissionMode: params.options.permissionMode,
    agyMode: extractProviderOptionString(providerOptions, "agyMode"),
    sandboxEnabled: extractProviderOptionBoolean(
      providerOptions,
      "sandboxEnabled",
    ),
    envVars: params.options.envVars,
    activeTurn: null,
    previousTurnFinished: Promise.resolve(),
  };
  sessions.set(params.threadId, session);
  deltaTranslator.resetThread(params.threadId);
  sendThreadIdentity(params.threadId, providerThreadId);
  sendThreadDeltas(params.threadId, [{ kind: "session.reset" }]);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleTurnStart(
  id: string | number,
  params: z.infer<typeof turnStartParamsSchema>,
): Promise<void> {
  const session = sessions.get(params.threadId);
  if (!session) {
    sendError(id, -32000, "No active Antigravity session");
    return;
  }
  const promptText = extractAgyPromptText(params.input);
  if (promptText === null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }

  const previousTurnFinished = session.previousTurnFinished;
  let finishThisTurn: () => void = () => undefined;
  session.previousTurnFinished = new Promise<void>((resolve) => {
    finishThisTurn = resolve;
  });
  await previousTurnFinished;

  if (params.options.model !== undefined) {
    session.model = params.options.model;
  }
  if (params.options.reasoningLevel !== undefined) {
    session.reasoningLevel = params.options.reasoningLevel;
  }
  if (params.options.permissionMode !== undefined) {
    session.permissionMode = params.options.permissionMode;
  }
  if (params.options.envVars !== undefined) {
    session.envVars = params.options.envVars;
  }
  const providerOptions = params.options.providerOptions;
  const agyMode = extractProviderOptionString(providerOptions, "agyMode");
  session.agyMode = agyMode;
  const sandboxEnabled = extractProviderOptionBoolean(
    providerOptions,
    "sandboxEnabled",
  );
  if (sandboxEnabled !== undefined) {
    session.sandboxEnabled = sandboxEnabled;
  }

  sendThreadDeltas(params.threadId, [
    { kind: "turn.open" },
    { kind: "input.accepted", clientRequestId: params.clientRequestId },
  ]);

  try {
    const runningTurn = await startAgyTurn({
      threadId: params.threadId,
      cwd: session.cwd,
      conversationId: session.conversationId,
      promptText,
      baseInstructions: session.baseInstructions,
      model: session.model,
      reasoningLevel: session.reasoningLevel,
      permissionMode: session.permissionMode,
      agyMode: session.agyMode,
      sandboxEnabled: session.sandboxEnabled,
      envVars: session.envVars,
      onEvent: (rawEvent) => {
        const deltas = deltaTranslator.translateEvent(rawEvent, {
          threadId: params.threadId,
          cwd: session.cwd,
          model: session.model,
        });
        for (const delta of deltas) {
          if (delta.kind === "thread.identity") {
            session.conversationId = delta.providerThreadId;
            session.providerThreadId = delta.providerThreadId;
            sendThreadIdentity(params.threadId, delta.providerThreadId);
          }
        }
        sendThreadDeltas(params.threadId, deltas);
      },
    });
    session.activeTurn = runningTurn;
    void runningTurn.done.catch(() => undefined).finally(() => {
      if (session.activeTurn === runningTurn) {
        session.activeTurn = null;
      }
      finishThisTurn();
    });
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    finishThisTurn();
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleThreadStop(
  id: string | number,
  params: z.infer<typeof threadStopParamsSchema>,
): Promise<void> {
  const session = sessions.get(params.threadId);
  if (session?.activeTurn) {
    session.activeTurn.cancel();
    await session.activeTurn.done.catch(() => undefined);
    session.activeTurn = null;
  }
  if (params.intent === "interrupt" && session) {
    sendThreadDeltas(params.threadId, [{ kind: "session.ended" }]);
  }
  sendResult(id, { ok: true, providerCheckpointId: null });
}

async function handleRequest(
  request: AgyCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "none",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "queue",
          skills: { configure: false },
        },
      };
      sendResult(request.id, result);
      break;
    }
    case "model/list":
      await handleModelList(request.id);
      break;
    case "provider/health":
      sendResult(request.id, await getAgyProviderHealth());
      break;
    case "provider/usage":
      sendResult(request.id, await getAgyProviderUsage());
      break;
    case "provider/installation/status":
      sendResult(request.id, await getAgyProviderInstallationStatus());
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getAgyProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      startOrResumeSession(request.id, request.params, null);
      break;
    case "thread/resume":
      startOrResumeSession(
        request.id,
        request.params,
        request.params.providerThreadId,
      );
      break;
    case "thread/fork":
      sendError(
        request.id,
        -32000,
        "Fork is not supported by the Antigravity provider",
      );
      break;
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      sendError(
        request.id,
        -32000,
        "Steer is not supported by the Antigravity provider",
      );
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard": {
      const session = sessions.get(request.params.threadId);
      if (session?.activeTurn) {
        session.activeTurn.cancel();
      }
      sessions.delete(request.params.threadId);
      sendResult(request.id, { ok: true });
      break;
    }
  }
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response) return;
  const decoded = decodeAgyJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") return;
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );
    return;
  }
  runBridgeRequest({ request: decoded.request, handleRequest, sendError });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

async function shutdownGracefully(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const session of sessions.values()) {
    if (session.activeTurn) {
      session.activeTurn.cancel();
      pending.push(session.activeTurn.done.catch(() => undefined));
    }
  }
  await Promise.all(pending);
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: () => {},
  onClose: () => {
    void shutdownGracefully().finally(() => {
      process.exit(0);
    });
  },
  onSigterm: () => {
    void shutdownGracefully().finally(() => {
      process.exit(0);
    });
  },
  onSigint: () => {
    void shutdownGracefully().finally(() => {
      process.exit(0);
    });
  },
});
