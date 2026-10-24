import { type PromptInput } from "@get-bb/plugin-sdk/provider-bridge";

export function extractAgyPromptText(input: PromptInput[]): string | null {
  const chunks: string[] = [];
  for (const item of input) {
    if (item.type === "text") {
      chunks.push(item.text);
    } else if (item.type === "localFile") {
      chunks.push(
        item.name
          ? `[Attached file "${item.name}": ${item.path}]`
          : `[Attached file: ${item.path}]`,
      );
    } else if (item.type === "localImage") {
      chunks.push(`[Attached image: ${item.path}]`);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : null;
}
