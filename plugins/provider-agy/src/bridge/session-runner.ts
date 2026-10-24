import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import {
  buildShellEnvOverrides,
  experimental_killPortableProcess as killPortableProcess,
  withoutBridgeRuntimeEnv,
  type ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";
import { resolveAgyModelAndEffort } from "../model-list.js";
import { agyExecutable } from "./provider-maintenance.js";

export interface AgyTurnExecutionOptions {
  cwd: string;
  conversationId: string | null;
  promptText: string;
  baseInstructions?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  permissionMode?: string;
  agyMode?: string;
  sandboxEnabled?: boolean;
  envVars?: Record<string, string>;
  threadId: string;
  onEvent: (event: unknown) => void;
}

export interface AgyRunningTurn {
  cancel: () => void;
  done: Promise<void>;
}

export async function startAgyTurn(
  options: AgyTurnExecutionOptions,
): Promise<AgyRunningTurn> {
  const command = await agyExecutable();
  const { model, effort } = resolveAgyModelAndEffort(
    options.model,
    options.reasoningLevel,
  );

  const args: string[] = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--effort",
    effort,
  ];

  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }

  if (options.agyMode === "plan" || options.permissionMode === "plan") {
    args.push("--mode", "plan");
  } else if (options.permissionMode === "full") {
    args.push("--dangerously-skip-permissions", "--mode", "auto");
  } else if (options.permissionMode === "auto") {
    args.push("--mode", "auto");
  } else if (options.permissionMode === "accept-edits") {
    args.push("--mode", "accept-edits");
  }

  if (options.sandboxEnabled === true) {
    args.push("--sandbox");
  }

  args.push("-p=");

  const env: NodeJS.ProcessEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    BB_THREAD_ID: options.threadId,
    ...(options.envVars ? buildShellEnvOverrides(options.envVars) : {}),
  };

  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let cancelled = false;
  let sawResultEvent = false;
  let stderrText = "";

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
  }

  if (child.stdout) {
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { event?: unknown }).event === "result"
        ) {
          sawResultEvent = true;
        }
        options.onEvent(parsed);
      } catch {}
    });
  }

  const promptContent =
    !options.conversationId &&
    options.baseInstructions &&
    options.baseInstructions.trim().length > 0
      ? `${options.baseInstructions.trim()}\n\n${options.promptText}`
      : options.promptText;

  const inputPayload = JSON.stringify({
    event: "user",
    message: {
      content: promptContent,
    },
  });

  if (child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${inputPayload}\n`);
    child.stdin.end();
  }

  const done = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      if (!sawResultEvent) {
        sawResultEvent = true;
        options.onEvent({
          event: "result",
          result: {
            conversation_id: options.conversationId ?? "",
            status: "ERROR",
            response: "",
            error: error.message,
          },
        });
      }
      resolve();
    });
    child.on("close", (code) => {
      if (cancelled) {
        if (!sawResultEvent) {
          options.onEvent({
            event: "result",
            result: {
              conversation_id: options.conversationId ?? "",
              status: "INTERRUPTED",
              response: "",
            },
          });
        }
        resolve();
        return;
      }
      if (!sawResultEvent) {
        if (code !== 0) {
          options.onEvent({
            event: "result",
            result: {
              conversation_id: options.conversationId ?? "",
              status: "ERROR",
              response: "",
              error:
                stderrText.trim() ||
                `agy exited with code ${String(code ?? "unknown")}`,
            },
          });
        } else {
          options.onEvent({
            event: "result",
            result: {
              conversation_id: options.conversationId ?? "",
              status: "SUCCESS",
              response: "",
            },
          });
        }
      }
      resolve();
    });
  });

  return {
    cancel: () => {
      cancelled = true;
      killPortableProcess(child, "SIGTERM");
    },
    done,
  };
}
