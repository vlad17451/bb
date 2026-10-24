import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
  type ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";

export interface AgyBaseModelSpec {
  id: string;
  displayName: string;
  description: string;
  routeProviderId: string;
  efforts: readonly ("low" | "medium" | "high")[];
  defaultEffort: "low" | "medium" | "high";
  isDefault?: boolean;
  contextWindow: number;
}

export const AGY_BASE_MODELS: readonly AgyBaseModelSpec[] = [
  {
    id: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    description: "Google Gemini 4 Argon via Antigravity",
    routeProviderId: "google",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isDefault: true,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    description: "Google Gemini 3.8 Flash via Antigravity",
    routeProviderId: "google",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 1_000_000,
  },
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    description: "Anthropic Claude Opus 5.5 via Antigravity",
    routeProviderId: "anthropic",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    description: "Anthropic Claude Sonnet 5.5 via Antigravity",
    routeProviderId: "anthropic",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 200_000,
  },
  {
    id: "gpt-oss-120b",
    displayName: "GPT-OSS 120B",
    description: "Open-weight GPT-OSS 120B via Antigravity",
    routeProviderId: "openai",
    efforts: ["medium"],
    defaultEffort: "medium",
    contextWindow: 128_000,
  },
];

const EFFORT_MAP: Record<"low" | "medium" | "high", ModelReasoningEffort> = {
  low: LOW_REASONING_EFFORT,
  medium: MEDIUM_REASONING_EFFORT,
  high: HIGH_REASONING_EFFORT,
};

export function buildAgyAvailableModels(
  discoveredVariantIds?: readonly string[],
): {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
} {
  const discoveredSet =
    discoveredVariantIds && discoveredVariantIds.length > 0
      ? new Set(discoveredVariantIds)
      : null;

  const models: AvailableModel[] = [];
  const selectedOnlyModels: AvailableModel[] = [];

  for (const spec of AGY_BASE_MODELS) {
    const activeEfforts = discoveredSet
      ? spec.efforts.filter(
          (effort) =>
            discoveredSet.has(`${spec.id}-${effort}`) ||
            discoveredSet.has(spec.id),
        )
      : [...spec.efforts];
    const efforts = activeEfforts.length > 0 ? activeEfforts : [...spec.efforts];
    const supportedReasoningEfforts = efforts.map(
      (effort) => EFFORT_MAP[effort],
    );
    const defaultReasoningEffort = efforts.includes(spec.defaultEffort)
      ? spec.defaultEffort
      : (efforts[0] ?? "medium");

    models.push({
      id: spec.id,
      model: spec.id,
      displayName: spec.displayName,
      routeProviderId: spec.routeProviderId,
      description: spec.description,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      isDefault: spec.isDefault === true,
    });

    for (const effort of efforts) {
      const variantId = `${spec.id}-${effort}`;
      const effortLabel =
        effort.charAt(0).toUpperCase() + effort.slice(1);
      selectedOnlyModels.push({
        id: variantId,
        model: variantId,
        displayName: `${spec.displayName} (${effortLabel})`,
        routeProviderId: spec.routeProviderId,
        description: `${spec.description} (${effortLabel})`,
        supportedReasoningEfforts: [EFFORT_MAP[effort]],
        defaultReasoningEffort: effort,
        isDefault: false,
      });
    }
  }

  return { models, selectedOnlyModels };
}

export function resolveAgyModelAndEffort(
  modelId: string | undefined,
  reasoningLevel: ReasoningLevel | undefined,
): { model: string; effort: "low" | "medium" | "high" } {
  const normalizedEffort = (
    level: ReasoningLevel | undefined,
    fallback: "low" | "medium" | "high" = "medium",
  ): "low" | "medium" | "high" => {
    if (level === "low" || level === "medium" || level === "high") {
      return level;
    }
    if (level === "xhigh" || level === "max" || level === "ultracode") {
      return "high";
    }
    return fallback;
  };

  if (!modelId) {
    return {
      model: "gemini-4-argon",
      effort: normalizedEffort(reasoningLevel, "medium"),
    };
  }

  const suffixMatch = /^(.*)-(low|medium|high)$/u.exec(modelId);
  if (suffixMatch) {
    const base = suffixMatch[1]!;
    const suffixEffort = suffixMatch[2] as "low" | "medium" | "high";
    return {
      model: base,
      effort: reasoningLevel
        ? normalizedEffort(reasoningLevel, suffixEffort)
        : suffixEffort,
    };
  }

  const known = AGY_BASE_MODELS.find((spec) => spec.id === modelId);
  if (known) {
    const requested = normalizedEffort(reasoningLevel, known.defaultEffort);
    const effort = known.efforts.includes(requested)
      ? requested
      : known.defaultEffort;
    return { model: known.id, effort };
  }

  return {
    model: modelId,
    effort: normalizedEffort(reasoningLevel, "medium"),
  };
}

export function resolveAgyModelContextWindow(
  modelId: string | undefined,
): number {
  if (!modelId) return 1_000_000;
  const resolved = resolveAgyModelAndEffort(modelId, undefined);
  const spec = AGY_BASE_MODELS.find((entry) => entry.id === resolved.model);
  return spec?.contextWindow ?? 1_000_000;
}
