import { describe, expect, it } from "vitest";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { agyProviderDeclaration } from "./declaration.js";
import { createAgyDeltaTranslator } from "./delta-translation.js";
import {
  buildAgyAvailableModels,
  resolveAgyModelAndEffort,
} from "./model-list.js";
import { normalizeAgyUsage } from "./bridge/provider-maintenance.js";
import { buildAgyTurnArgs } from "./bridge/session-runner.js";

describe("provider-agy", () => {
  it("normalizes agy /usage and /credits JSON into ProviderUsage windows", () => {
    const rawUsage = {
      conversation_id: "",
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0.9875,
                  reset_time: "2026-10-31T10:53:58Z",
                },
                {
                  id: "gemini-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.9814,
                  reset_time: "2026-10-24T16:00:56Z",
                },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                {
                  id: "3p-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0.8045,
                  reset_time: "2026-10-31T11:29:32Z",
                },
                {
                  id: "3p-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.6248,
                  reset_time: "2026-10-24T16:29:32Z",
                },
              ],
            },
            {
              name: "Gemini 4 Argon",
              buckets: [
                {
                  id: "gemini-argon-wtu-weekly",
                  name: "Gemini 4 Argon Weekly Limit",
                  window: "weekly",
                  remaining_fraction: 0.8209,
                  reset_time: "2026-10-31T10:47:06Z",
                },
              ],
            },
          ],
        },
      },
    };
    const rawCredits = {
      command: {
        name: "credits",
        data: {
          remaining_credits: 0,
          upgrade_uri: "https://antigravity.google/g1-upgrade",
        },
      },
    };

    const usage = normalizeAgyUsage(rawUsage, rawCredits);
    expect(usage.status).toBe("ok");
    if (usage.status === "ok") {
      expect(usage.planLabel).toBe("Pro");
      expect(usage.windows.map((w) => w.label)).toEqual([
        "7d · Argon",
        "5h · Gemini",
        "7d · Gemini",
        "5h · Claude/GPT",
        "7d · Claude/GPT",
      ]);
      expect(Math.round(usage.windows[0]!.usedPercent)).toBe(18);
      expect(Math.round(usage.windows[3]!.usedPercent)).toBe(38);
    }
  });

  it("exposes Gemini 4 Argon as default base model and resolves efforts", () => {
    const catalog = buildAgyAvailableModels();
    expect(catalog.models[0]?.id).toBe("gemini-4-argon");
    expect(catalog.models[0]?.isDefault).toBe(true);
    expect(
      catalog.selectedOnlyModels.some((m) => m.id === "gemini-4-argon-high"),
    ).toBe(true);

    expect(resolveAgyModelAndEffort("gemini-4-argon", "high")).toEqual({
      model: "gemini-4-argon",
      effort: "high",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon-low", undefined)).toEqual({
      model: "gemini-4-argon",
      effort: "low",
    });
  });

  it("translates agy stream-json init, step_update, and result events into ThreadDeltas", () => {
    const translator = createAgyDeltaTranslator();
    const ctx = { threadId: "t-1", cwd: "/tmp", model: "gemini-4-argon" };

    const initDeltas = translator.translateEvent(
      {
        event: "init",
        conversation_id: "75601961-76d7-43dc-9a47-e5880bc423a7",
        init: { model: "gemini-4-argon", cwd: "/tmp" },
      },
      ctx,
    );
    expect(initDeltas).toEqual([
      {
        kind: "thread.identity",
        providerThreadId: "75601961-76d7-43dc-9a47-e5880bc423a7",
      },
    ]);

    const stepDeltas = translator.translateEvent(
      {
        event: "step_update",
        step_update: {
          conversation_id: "75601961-76d7-43dc-9a47-e5880bc423a7",
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          thinking_delta: "Думаю...",
          text_delta: "Привет!",
        },
      },
      ctx,
    );
    expect(stepDeltas).toEqual([
      {
        kind: "item.textDelta",
        key: { channel: "thought" },
        channel: "reasoningText",
        text: "Думаю...",
      },
      {
        kind: "item.textDelta",
        key: { channel: "assistant-1" },
        channel: "agentMessage",
        text: "Привет!",
      },
    ]);

    const doneStepDeltas = translator.translateEvent(
      {
        event: "step_update",
        step_update: {
          conversation_id: "75601961-76d7-43dc-9a47-e5880bc423a7",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Привет!",
        },
      },
      ctx,
    );
    expect(doneStepDeltas).toEqual([]);

    const resultDeltas = translator.translateEvent(
      {
        event: "result",
        result: {
          conversation_id: "75601961-76d7-43dc-9a47-e5880bc423a7",
          status: "SUCCESS",
          response: "Привет!\n",
          duration_seconds: 2.7,
          num_turns: 1,
          usage: {
            input_tokens: 6798,
            output_tokens: 10,
            thinking_tokens: 5,
            cache_read_tokens: 0,
            total_tokens: 6813,
          },
        },
      },
      ctx,
    );
    expect(
      resultDeltas.some(
        (d) => d.kind === "item.textClose" && d.channel === "reasoningText",
      ),
    ).toBe(true);
    expect(
      resultDeltas.some(
        (d) => d.kind === "item.textClose" && d.channel === "agentMessage",
      ),
    ).toBe(true);
    expect(resultDeltas.some((d) => d.kind === "usage")).toBe(true);
    expect(
      resultDeltas.some(
        (d) => d.kind === "turn.boundary" && d.status === "completed",
      ),
    ).toBe(true);
  });

  describe("agent messages", () => {
    const THREAD_ID = "t-1";
    const ctx = { threadId: THREAD_ID, cwd: "/work", model: "gemini-3.8-flash" };

    function runTurn(events: readonly unknown[]): string[] {
      const translator = createAgyDeltaTranslator();
      const assembler = createDeltaAssembler({
        providerId: "agy",
        entropyPrefix: "agy-test",
        textDeltaFlushMs: 0,
      });
      const threadEvents = [
        ...assembler.assemble({
          threadId: THREAD_ID,
          deltas: [{ kind: "turn.open" }],
        }),
        ...events.flatMap((event) =>
          assembler.assemble({
            threadId: THREAD_ID,
            deltas: translator.translateEvent(event, ctx),
          }),
        ),
      ];
      return threadEvents.flatMap((event) =>
        event.type === "item/completed" && event.item.type === "agentMessage"
          ? [event.item.text]
          : [],
      );
    }

    function responseStep(
      stepIndex: number,
      state: "ACTIVE" | "DONE",
      textDelta: string,
    ): unknown {
      return {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: stepIndex,
          state,
          step_type: "planner_response",
          text_delta: textDelta,
        },
      };
    }

    function resultEvent(response: string): unknown {
      return {
        event: "result",
        result: { conversation_id: "conv-1", status: "SUCCESS", response },
      };
    }

    it("keeps the full final response when only its first chunk was streamed", () => {
      expect(
        runTurn([
          responseStep(22, "ACTIVE", "Image generation could not be"),
          resultEvent(
            "Image generation could not be completed due to a quota error.",
          ),
        ]),
      ).toEqual([
        "Image generation could not be completed due to a quota error.",
      ]);
    });

    it("completes a message from a DONE update that carries the remainder", () => {
      expect(
        runTurn([
          responseStep(3, "ACTIVE", "Hello, "),
          responseStep(3, "DONE", "world."),
          resultEvent(""),
        ]),
      ).toEqual(["Hello, world."]);
    });

    it("completes a message from a DONE update that carries the whole text", () => {
      expect(
        runTurn([
          responseStep(3, "ACTIVE", "Hello, "),
          responseStep(3, "DONE", "Hello, world."),
          resultEvent(""),
        ]),
      ).toEqual(["Hello, world."]);
    });

    it("keeps responses from separate steps as separate messages", () => {
      expect(
        runTurn([
          responseStep(1, "ACTIVE", "Started the Image Generator."),
          responseStep(5, "ACTIVE", "The generator hit its quota."),
          resultEvent("The generator hit its quota."),
        ]),
      ).toEqual([
        "Started the Image Generator.",
        "The generator hit its quota.",
      ]);
    });

    it("adds the result response as a final message when only an earlier step was streamed", () => {
      expect(
        runTurn([
          responseStep(1, "ACTIVE", "Searching the codebase."),
          resultEvent("The bug is in the parser."),
        ]),
      ).toEqual(["Searching the codebase.", "The bug is in the parser."]);
    });

    it("uses the result response when nothing was streamed", () => {
      expect(runTurn([resultEvent("Done.\n")])).toEqual(["Done."]);
    });
  });

  it("leaves subagent launches and listings to the workflow panel and keeps other tools", () => {
    const translator = createAgyDeltaTranslator();
    const ctx = { threadId: "t-sub", cwd: "/tmp" };
    const toolStep = (stepIndex: number, name: string, extra: Record<string, unknown> = {}) => ({
      event: "step_update",
      step_update: {
        conversation_id: "conv-sub",
        step_index: stepIndex,
        state: "DONE",
        step_type: "tool",
        tool_info: { name, tool_call_id: `call-${String(stepIndex)}`, parameters: {} },
        ...extra,
      },
    });

    expect(translator.translateEvent(toolStep(1, "invoke_subagent"), ctx)).toEqual([]);
    expect(translator.translateEvent(toolStep(2, "manage_subagents"), ctx)).toEqual([]);
    expect(
      translator.translateEvent(
        toolStep(3, "invoke_subagent", { subagent_info: { subagents: [{ role: "Review: correctness", conversation_id: "child-1" }] } }),
        ctx,
      ),
    ).toEqual([]);
    expect(
      translator.translateEvent(toolStep(4, "view_file"), ctx).map((delta) => delta.kind),
    ).toEqual(["item.open", "item.close"]);
  });

  it("runs agy in its terminal sandbox in auto mode", () => {
    const baseOptions = {
      conversationId: null,
      model: "gemini-3.8-flash",
    };
    expect(
      buildAgyTurnArgs({
        ...baseOptions,
        permissionMode: "auto",
        sandboxEnabled: false,
      }),
    ).toContain("--sandbox");
    expect(
      buildAgyTurnArgs({
        ...baseOptions,
        permissionMode: "accept-edits",
        sandboxEnabled: false,
      }),
    ).not.toContain("--sandbox");
    expect(
      buildAgyTurnArgs({
        ...baseOptions,
        permissionMode: "full",
        sandboxEnabled: false,
      }),
    ).not.toContain("--sandbox");
  });

  it("derives sandboxEnabled default as false when setting is unset", () => {
    const decl = agyProviderDeclaration();
    const options = decl.deriveProviderOptions?.({
      threadId: "thr_1",
      projectId: "prj_1",
      model: "gemini-4-argon",
      permissionMode: "accept-edits",
      settings: {},
    });
    expect(options).toEqual({ sandboxEnabled: false });
  });
});
