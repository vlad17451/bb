import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsage,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 20_000;

export async function agyExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = env.BB_AGY_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const resolved = await resolveExecutablePath("agy");
  if (resolved !== null) return resolved;
  const localBin = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "agy.exe" : "agy",
  );
  try {
    await fs.access(localBin);
    return localBin;
  } catch {
    return "agy";
  }
}

export async function resolveAgyExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = env.BB_AGY_EXECUTABLE?.trim();
  if (explicit) {
    if (path.isAbsolute(explicit)) {
      try {
        await fs.access(explicit);
        return explicit;
      } catch {
        return null;
      }
    }
    return resolveExecutablePath(explicit);
  }
  const onPath = await resolveExecutablePath("agy");
  if (onPath !== null) return onPath;
  const localBin = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "agy.exe" : "agy",
  );
  try {
    await fs.access(localBin);
    return localBin;
  } catch {
    return null;
  }
}

const agyBucketSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    window: z.string().optional(),
    disabled: z.boolean().optional(),
    remaining_fraction: z.number().nullish(),
    remaining_amount: z.number().nullish(),
    reset_time: z.string().nullish(),
  })
  .passthrough();

const agyGroupSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    buckets: z.array(agyBucketSchema).default([]),
  })
  .passthrough();

const agyUsageCommandOutputSchema = z
  .object({
    status: z.string().optional(),
    error: z.string().optional(),
    command: z
      .object({
        name: z.string(),
        data: z
          .object({
            description: z.string().optional(),
            groups: z.array(agyGroupSchema).default([]),
          })
          .passthrough(),
      })
      .nullish(),
  })
  .passthrough();

const agyCreditsCommandOutputSchema = z
  .object({
    command: z
      .object({
        name: z.string(),
        data: z
          .object({
            remaining_credits: z.number().optional(),
            plan_name: z.string().nullish(),
            upgrade_uri: z.string().nullish(),
          })
          .passthrough(),
      })
      .nullish(),
  })
  .passthrough();

function resetIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function shortGroupLabel(groupName: string): string {
  const lower = groupName.toLowerCase();
  if (lower.includes("argon")) return "Argon";
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("claude") || lower.includes("gpt")) return "Claude/GPT";
  return groupName.trim();
}

function shortDurationLabel(
  windowValue: string | undefined,
  bucketName: string,
): string {
  const w = (windowValue ?? "").toLowerCase();
  if (w === "5h" || w === "five-hour" || w === "5-hour") return "5h";
  if (w === "weekly" || w === "7d") return "7d";
  if (w === "daily" || w === "24h" || w === "1d") return "1d";
  const lowerName = bucketName.toLowerCase();
  if (lowerName.includes("five hour") || lowerName.includes("5-hour")) {
    return "5h";
  }
  if (lowerName.includes("weekly")) return "7d";
  return w || bucketName;
}

function groupSortPriority(groupName: string): number {
  const lower = groupName.toLowerCase();
  if (lower.includes("argon")) return 0;
  if (lower.includes("gemini")) return 1;
  return 2;
}

function windowSortPriority(windowValue: string | undefined): number {
  const w = (windowValue ?? "").toLowerCase();
  if (w === "5h" || w === "five-hour" || w === "5-hour") return 0;
  if (w === "weekly" || w === "7d") return 1;
  if (w === "daily" || w === "24h" || w === "1d") return 2;
  return 3;
}

function inferPlanFromGroups(
  groups: readonly z.infer<typeof agyGroupSchema>[],
  creditsPlanName?: string | null,
): {
  planLabel: string | null;
  plan: { id: string; multiplier: number | null } | null;
} {
  if (creditsPlanName && creditsPlanName.trim().length > 0) {
    const trimmed = creditsPlanName.trim();
    return {
      planLabel: trimmed,
      plan: { id: trimmed.toLowerCase(), multiplier: null },
    };
  }
  for (const group of groups) {
    if (
      group.buckets.some((bucket) => bucket.id === "gemini-argon-wtu-weekly")
    ) {
      return {
        planLabel: "Pro",
        plan: { id: "pro", multiplier: null },
      };
    }
  }
  return { planLabel: null, plan: null };
}

export function normalizeAgyUsage(
  rawUsage: unknown,
  rawCredits?: unknown,
): ProviderUsage {
  const parsed = agyUsageCommandOutputSchema.safeParse(rawUsage);
  if (!parsed.success || !parsed.data.command?.data) {
    return {
      status: "error",
      message:
        parsed.success && parsed.data.error
          ? parsed.data.error
          : "Antigravity usage response was malformed.",
      planLabel: null,
      accountEmail: null,
    };
  }

  const creditsParsed = agyCreditsCommandOutputSchema.safeParse(rawCredits);
  const creditsPlanName = creditsParsed.success
    ? creditsParsed.data.command?.data.plan_name
    : null;

  const groups = [...parsed.data.command.data.groups].sort(
    (left, right) =>
      groupSortPriority(left.name) - groupSortPriority(right.name),
  );
  const { planLabel, plan } = inferPlanFromGroups(groups, creditsPlanName);

  const windows: ProviderUsageWindow[] = [];
  for (const group of groups) {
    const groupShort = shortGroupLabel(group.name);
    const buckets = [...group.buckets].sort(
      (left, right) =>
        windowSortPriority(left.window) - windowSortPriority(right.window),
    );
    for (const bucket of buckets) {
      if (bucket.disabled || bucket.remaining_fraction == null) continue;
      const duration = shortDurationLabel(bucket.window, bucket.name);
      const usedPercent = clampPercent((1 - bucket.remaining_fraction) * 100);
      windows.push({
        kind: "custom",
        label: `${duration} · ${groupShort}`,
        usedPercent,
        resetsAt: resetIso(bucket.reset_time),
      });
    }
  }

  return {
    status: "ok",
    accountEmail: null,
    planLabel,
    plan,
    windows,
  };
}

function classifyAgyCliFailure(
  error: unknown,
): "unauthenticated" | "expired" | "error" {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { stderr?: string }).stderr ?? ""} ${(error as { stdout?: string }).stdout ?? ""}`
      : String(error);
  const lower = text.toLowerCase();
  if (
    lower.includes("not authenticated") ||
    lower.includes("no stored credentials") ||
    lower.includes("run `agy login`") ||
    lower.includes("not logged in") ||
    lower.includes("please log in") ||
    lower.includes("login required") ||
    lower.includes("unauthenticated")
  ) {
    return "unauthenticated";
  }
  if (
    lower.includes("invalid or expired") ||
    lower.includes("token refresh failed") ||
    lower.includes("session expired")
  ) {
    return "expired";
  }
  return "error";
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end >= start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  return JSON.parse(text.trim());
}

async function runAgySlashJson(
  executable: string,
  slashCommand: string,
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(
      executable,
      ["-p", slashCommand, "--output-format", "json"],
      {
        timeout: COMMAND_TIMEOUT_MS,
        env: withoutBridgeRuntimeEnv(process.env),
      },
    );
    return extractJson(stdout);
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      try {
        return extractJson(stdout);
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

export async function getAgyProviderUsage(): Promise<ProviderUsageResult> {
  const resolved = await resolveAgyExecutablePath();
  if (resolved === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  try {
    const [usageJson, creditsJson] = await Promise.all([
      runAgySlashJson(resolved, "/usage"),
      runAgySlashJson(resolved, "/credits").catch(() => null),
    ]);
    return {
      supported: true,
      usage: normalizeAgyUsage(usageJson, creditsJson),
    };
  } catch (error) {
    const status = classifyAgyCliFailure(error);
    if (status === "unauthenticated" || status === "expired") {
      return { supported: true, usage: { status } };
    }
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        accountEmail: null,
        planLabel: null,
      },
    };
  }
}

function healthResult(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  args: {
    accountEmail?: string | null;
    planLabel?: string | null;
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: args.planLabel ?? null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: status !== "not_installed",
      loginCommand: "agy login",
    },
  };
}

export async function getAgyProviderHealth(): Promise<ProviderHealthResult> {
  const resolved = await resolveAgyExecutablePath();
  if (resolved === null) {
    return healthResult("not_installed");
  }
  const version = await readCliVersion(resolved);
  try {
    const usageResult = await getAgyProviderUsage();
    if (!usageResult.supported) {
      return healthResult("ready", { installedVersion: version });
    }
    const { usage } = usageResult;
    if (usage.status === "not_installed") {
      return healthResult("not_installed");
    }
    if (usage.status === "unauthenticated" || usage.status === "expired") {
      return healthResult(usage.status, { installedVersion: version });
    }
    if (usage.status === "error") {
      return healthResult("unknown", {
        installedVersion: version,
        statusMessage: usage.message,
      });
    }
    return healthResult("ready", {
      installedVersion: version,
      accountEmail: usage.accountEmail ?? null,
      planLabel: usage.planLabel ?? null,
    });
  } catch (error) {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAgyProviderInstallationStatus(): Promise<ProviderInstallationStatus> {
  const resolved = await resolveAgyExecutablePath();
  const currentVersion =
    resolved !== null ? await readCliVersion(resolved) : null;
  const installed = resolved !== null;
  return {
    executableName: "agy",
    executablePath: resolved,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

export async function getAgyProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getAgyProviderInstallationStatus();
  if (action === "update" && status.executablePath) {
    const command = status.executablePath;
    const args = ["update"];
    return {
      available: true,
      command: {
        command,
        args,
        displayCommand: formatCommand(command, args),
      },
      verification: installationVerification(status, action),
    };
  }
  return {
    available: false,
    message: `Antigravity ${action} is not available automatically on this host.`,
  };
}
