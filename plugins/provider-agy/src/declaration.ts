import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { AGY_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";

export function agyProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: "agy",
    displayName: "Antigravity",
    icon: "./icons/agy.svg",
    strings: {
      signInHint: "Run `agy login` on the machine to sign in.",
      expiredHint:
        "Your Antigravity session expired. Run `agy login`, then reload.",
      installUrl: "https://antigravity.google",
      brandPrefix: "Antigravity ",
      planModeCopy:
        "Antigravity will plan without normal full-access execution.",
      iconTint: { light: "#4285F4", dark: "#8AB4F8" },
    },
    ...AGY_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    composerActions: ["plan"],
    completedTurnDisplay: "flat",
    env: {
      passthrough: ["BB_AGY_EXECUTABLE"],
    },
    models: { scope: "host" },
    deriveProviderOptions(context) {
      return {
        sandboxEnabled: context.settings.sandboxEnabled === true,
        ...(context.promptMode === "plan" ? { agyMode: "plan" } : {}),
      };
    },
  };
}
