import { describe, expect, it } from "vitest";
import {
  buildTimelineViewRows,
  type ThreadTimelineViewRow,
  type TimelineWorkSummaryChild,
} from "@bb/thread-view";
import {
  ECHO_RECEIPT_PRESENTATION,
  commandRow,
  conversationRow,
  delegationRow,
  extensionRow,
  imageViewRow,
  questionRow,
  systemRow,
  toolRow,
  workflowRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  collectTimelineAutoExpansionRowIds,
  isRowExpandable,
} from "@bb/client-core";

interface CollectAutoExpandedIdsArgs {
  rows: ReturnType<typeof buildTimelineViewRows>;
  scopeActive: boolean;
}

function collectAutoExpandedIds({
  rows,
  scopeActive,
}: CollectAutoExpandedIdsArgs): Set<string> {
  const { liveExpandedRowIds, terminalFrontierRowIds } =
    collectTimelineAutoExpansionRowIds({
      rows,
      scopeActive,
    });
  return new Set([...liveExpandedRowIds, ...terminalFrontierRowIds]);
}

const extensionPresentation = {
  ...ECHO_RECEIPT_PRESENTATION,
  icon: { glyph: "Check" },
};

function reasoningRow(
  id: string,
  turnId = "question-turn",
): Extract<TimelineWorkSummaryChild, { kind: "system" }> {
  const row = systemRow({
    id,
    turnId,
    operationKind: "reasoning",
    detail: "Context for the question",
  });
  if (row.systemKind !== "operation") {
    throw new Error("expected a reasoning operation row");
  }
  return {
    ...row,
    operationKind: "reasoning",
    status: "completed",
  };
}

function summaryRow(
  kind: "bundle-summary" | "step-summary",
  children: TimelineWorkSummaryChild[],
): ThreadTimelineViewRow {
  const { threadId, turnId, sourceSeqStart, sourceSeqEnd, startedAt, createdAt } =
    children[0] ?? reasoningRow("empty");
  return {
    id: "summary",
    threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    kind,
    status: "completed",
    children,
  };
}

describe("isRowExpandable", () => {
  it.each([
    {
      label: "an error-only degraded workflow row",
      row: workflowRow({
        error: "agent abandoned: user requested retry on all 3 attempts",
        status: "error",
        taskStatus: "failed",
      }),
      expandable: true,
    },
    {
      label: "a degraded workflow row without workflow, summary, or error",
      row: workflowRow({ status: "pending", taskStatus: "running" }),
      expandable: false,
    },
    ...[undefined, "", "   ", "\n\t "].map((detail) => ({
      label: `an extension row with detail ${JSON.stringify(detail)}`,
      row: extensionRow({
        presentation: { ...extensionPresentation, detail },
      }),
      expandable: false,
    })),
    {
      label: "an extension row with detail text",
      row: extensionRow({
        presentation: { ...extensionPresentation, detail: "Echoed **2**" },
      }),
      expandable: true,
    },
  ])("treats $label as expandable: $expandable", ({ row, expandable }) => {
    expect(isRowExpandable(row)).toBe(expandable);
  });
});

describe("collectTimelineAutoExpansionRowIds", () => {
  it.each([1, 2])(
    "opens %i consecutive reasoning rows before a pending question",
    (count) => {
      const thoughts = Array.from({ length: count }, (_, index) =>
        reasoningRow(`thought-${index}`),
      );
      const rows = buildTimelineViewRows([
        ...thoughts,
        questionRow({ turnId: "question-turn" }),
      ]);

      const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive: true,
      });

      expect([...liveExpandedRowIds].sort()).toEqual(
        thoughts.map((row) => row.id).sort(),
      );
    },
  );

  it.each(["bundle-summary", "step-summary"] as const)(
    "opens a reasoning-only %s and its children before a pending question",
    (kind) => {
      const rows: ThreadTimelineViewRow[] = [
        summaryRow(kind, [reasoningRow("thought")]),
        questionRow({ turnId: "question-turn" }),
      ];

      const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive: true,
      });

      expect([...liveExpandedRowIds].sort()).toEqual(["summary", "thought"]);
    },
  );

  it.each([
    {
      label: "assistant text",
      boundary: conversationRow({ role: "assistant", turnId: "question-turn", text: "Assistant text." }),
    },
    {
      label: "user input",
      boundary: conversationRow({ role: "user", turnId: "question-turn", text: "User text." }),
    },
    {
      label: "tool work",
      boundary: toolRow({ turnId: "question-turn" }),
    },
    {
      label: "command work",
      boundary: commandRow({ turnId: "question-turn", command: "git status" }),
    },
    {
      label: "a previous question",
      boundary: questionRow({
        id: "previous-question",
        turnId: "question-turn",
      }),
    },
    {
      label: "another turn",
      boundary: reasoningRow("previous-turn-thought", "previous-turn"),
    },
  ])("stops at $label before a pending question", ({ boundary }) => {
    const rows: ThreadTimelineViewRow[] = [
      reasoningRow("earlier-thought"),
      boundary,
      reasoningRow("question-context"),
      questionRow({ turnId: "question-turn" }),
    ];

    const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
      rows,
      scopeActive: true,
    });

    expect([...liveExpandedRowIds]).toEqual(["question-context"]);
  });

  it("opens only the reasoning after the last tool work before a pending question", () => {
    const rows = buildTimelineViewRows([
      reasoningRow("earlier-thought"),
      toolRow({ turnId: "question-turn" }),
      reasoningRow("later-thought"),
      questionRow({ turnId: "question-turn" }),
    ]);

    const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
      rows,
      scopeActive: true,
    });

    expect(liveExpandedRowIds.has("later-thought")).toBe(true);
    expect(liveExpandedRowIds.has("earlier-thought")).toBe(false);
  });

  it("opens a mixed summary and only its trailing reasoning before a pending question", () => {
    const rows: ThreadTimelineViewRow[] = [
      reasoningRow("outside-thought"),
      summaryRow("bundle-summary", [
        reasoningRow("earlier-thought"),
        toolRow({ turnId: "question-turn" }),
        reasoningRow("later-thought"),
      ]),
      questionRow({ turnId: "question-turn" }),
    ];

    const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
      rows,
      scopeActive: true,
    });

    expect([...liveExpandedRowIds].sort()).toEqual(["later-thought", "summary"]);
  });

  it.each(["answered", "resolving", "interrupted"] as const)(
    "does not open reasoning for a question that is %s",
    (lifecycle) => {
      const rows = buildTimelineViewRows([
        reasoningRow("thought"),
        questionRow({ turnId: "question-turn", lifecycle }),
      ]);

      const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive: true,
      });

      expect([...liveExpandedRowIds]).toEqual([]);
    },
  );

  it("releases question context when newer assistant output becomes the frontier", () => {
    const rows = buildTimelineViewRows([
      reasoningRow("thought"),
      questionRow({ turnId: "question-turn" }),
    ]);

    expect([
      ...collectTimelineAutoExpansionRowIds({ rows, scopeActive: true })
        .liveExpandedRowIds,
    ]).toEqual(["thought"]);

    const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
      rows: [...rows, conversationRow({ role: "assistant", text: "Newer output." })],
      scopeActive: true,
    });

    expect([...liveExpandedRowIds]).toEqual([]);
  });

  it.each([
    {
      scopeActive: true,
      status: "pending",
      expected: ["delegation", "thought"],
    },
    { scopeActive: false, status: "pending", expected: [] },
    { scopeActive: true, status: "completed", expected: ["delegation"] },
  ] as const)(
    "opens nested question context with active=$scopeActive and delegation=$status",
    ({ scopeActive, status, expected }) => {
      const rows = buildTimelineViewRows([
        delegationRow({
          id: "delegation",
          status,
          childRows: [
            reasoningRow("thought"),
            questionRow({ turnId: "question-turn" }),
          ],
        }),
      ]);

      const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive,
      });

      expect([...liveExpandedRowIds].sort()).toEqual([...expected]);
    },
  );

  it("does not open reasoning before a pending question in an inactive scope", () => {
    const rows = buildTimelineViewRows([
      reasoningRow("thought"),
      questionRow({ turnId: "question-turn" }),
    ]);

    const { liveExpandedRowIds } = collectTimelineAutoExpansionRowIds({
      rows,
      scopeActive: false,
    });

    expect([...liveExpandedRowIds]).toEqual([]);
  });

  it("returns no auto-expanded ids when the scope is inactive", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        output: "first output",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a trailing bundle in an active scope without expanding its children", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const bundle = rows[0];
    if (!bundle || bundle.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([bundle.id]);
    for (const child of bundle.children) {
      expect(ids.has(child.id)).toBe(false);
    }
  });

  it("auto-expands a trailing pending system row with detail in an active scope", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "system-with-detail",
        detail: "provider transcript",
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["system-with-detail"]);
  });

  it("does not live-auto-expand a completed system row with detail in an active scope", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "completed-system-with-detail",
        detail: "completed transcript",
        status: "completed",
      }),
    ]);

    const { liveExpandedRowIds, terminalFrontierRowIds } =
      collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive: true,
      });

    expect(Array.from(liveExpandedRowIds)).toEqual([]);
    expect(Array.from(terminalFrontierRowIds)).toEqual([]);
  });

  it("does not auto-expand a terminal system error after a follow-up makes the scope active", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "provider-rate-limit",
        detail:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        status: "error",
        systemKind: "error",
        title: "Provider rate limit reached",
        sourceSeqStart: 1,
      }),
      conversationRow({
        id: "follow-up",
        role: "user",
        text: "please keep going",
        sourceSeqStart: 2,
        turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a terminal system error when it is the tail row after the turn ends", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "provider-rate-limit",
        detail:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        status: "error",
        systemKind: "error",
        title: "Provider rate limit reached",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual(["provider-rate-limit"]);
  });

  it("auto-expands a pending delegation child terminal system error as a terminal frontier", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "pending-delegation-with-terminal-error",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-command",
            command: "pnpm test",
            output: "command output",
            sourceSeqStart: 1,
          }),
          systemRow({
            id: "nested-provider-error",
            detail: "Provider rate limit reached",
            status: "error",
            systemKind: "error",
            title: "Provider error",
            sourceSeqStart: 2,
          }),
        ],
      }),
    ]);

    const { liveExpandedRowIds, terminalFrontierRowIds } =
      collectTimelineAutoExpansionRowIds({
        rows,
        scopeActive: false,
      });

    expect(Array.from(terminalFrontierRowIds)).toEqual([
      "nested-provider-error",
    ]);
    expect(Array.from(liveExpandedRowIds)).toEqual([]);
  });

  it("does not auto-expand a trailing command row in an active scope", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        output: "first output",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a trailing image view row in an active scope", () => {
    const rows = buildTimelineViewRows([
      imageViewRow({
        id: "image-view-1",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["image-view-1"]);
  });

  it("auto-expands a trailing completed image view row in an active scope", () => {
    const rows = buildTimelineViewRows([
      imageViewRow({
        durationMs: 500,
        id: "image-view-1",
        sourceSeqStart: 1,
        status: "completed",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["image-view-1"]);
  });

  it("does not auto-expand a displaced completed bundle in an active scope", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        sourceSeqStart: 1,
      }),
      commandRow({
        id: "command-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
      }),
      commandRow({
        id: "explore-1",
        command: "cat src/app.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/app.ts",
            name: "app.ts",
            path: "src/app.ts",
          },
        ],
        sourceSeqStart: 3,
      }),
      commandRow({
        id: "explore-2",
        command: "cat src/other.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/other.ts",
            name: "other.ts",
            path: "src/other.ts",
          },
        ],
        sourceSeqStart: 4,
      }),
    ]);

    expect(rows).toHaveLength(2);
    const [displaced, trailing] = rows;
    if (!displaced || displaced.kind !== "bundle-summary") {
      throw new Error("expected the first row to be a bundle-summary");
    }
    if (!trailing || trailing.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(trailing.id)).toBe(true);
    expect(ids.has(displaced.id)).toBe(false);
  });

  it("does not auto-expand anything when an assistant message is the frontier", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "assistant-final",
        role: "assistant",
        text: "All done.",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("looks past trailing user conversation rows when finding the frontier", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "pending-steer-1",
        role: "user",
        text: "Keep this in mind",
        turnRequest: { isGrouped: false, kind: "steer", status: "pending" },
      }),
    ]);

    const bundle = rows.find((row) => row.kind === "bundle-summary");
    if (!bundle) {
      throw new Error("expected a bundle-summary row in the view");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(bundle.id)).toBe(true);
  });

  it("does not auto-expand a pending delegation's frontier on an idle thread", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "idle-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a pending delegation's frontier when the top-level scope is active", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "active-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has("active-pending-delegation")).toBe(true);
    expect(ids.has("nested-pending-command")).toBe(false);
  });
});
