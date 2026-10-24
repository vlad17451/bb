import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { agyProviderDeclaration } from "./src/declaration.js";
import { registerUsageSource } from "./src/usage-source.js";

export default function plugin(bb: BbPluginApi): void {
  registerUsageSource(bb);
  bb.settings.define({
    sandboxEnabled: {
      type: "boolean",
      label: "Antigravity terminal sandbox",
      description:
        "Run shell commands inside Antigravity's built-in terminal sandbox. Auto mode always uses it, because headless Antigravity denies unsandboxed commands there.",
      default: false,
    },
  });
  const registered = bb.providers.register(agyProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
