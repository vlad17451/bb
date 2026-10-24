import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";

export const AGY_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [
      { path: ".gemini/antigravity-cli/skills", recursive: true },
      { path: ".agents/skills", recursive: true },
    ],
    project: [
      { path: ".agent/skills", recursive: true },
      { path: ".agents/skills", recursive: true, ancestors: true },
    ],
  },
  experimental_resolvesNativeRoots: true,
};

export interface ResolveAgyNativeRootsArgs {
  homeDir: string;
}

export async function resolveAgyNativeRoots(
  args: ResolveAgyNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const geminiSkills = path.join(
    args.homeDir,
    ".gemini",
    "antigravity-cli",
    "skills",
  );
  const agentsSkills = path.join(args.homeDir, ".agents", "skills");
  return {
    skills: experimental_filterResolvedNativeRoots(
      {
        skills: [
          {
            path: geminiSkills,
            origin: "user" as const,
            recursive: true,
            shape: "skills" as const,
          },
          {
            path: agentsSkills,
            origin: "user" as const,
            recursive: true,
            shape: "skills" as const,
          },
        ],
      },
      { warn: console.warn },
    ).answer.skills,
  };
}
