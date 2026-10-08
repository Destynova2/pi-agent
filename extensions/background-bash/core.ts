import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The upstream public factory owns processes and cleanup. Its foreground path is
// deliberately unreachable: Pi's native bash preserves structured exit failures.
export function registerBackground(pi: ExtensionAPI, factory: (options: Record<string, unknown>) => (api: ExtensionAPI) => void, outputDir: string) {
  factory({
    bashToolName: "bash_background",
    outputDir,
    bashSystemPromptSnippet: "Start a confined command in the background",
    bashToolDescription: "Start a confined command in the background. Returns its PGID and log path. Completion, including the exit status, arrives automatically.",
    systemPromptGuidelines: [
      "Use bash for foreground commands and bash_background for long-running commands.",
      "Use bash_process list/peek/kill to inspect or stop background processes.",
      "Background completion is pending work until its notification arrives and the result is checked.",
    ],
  })({
    ...pi,
    registerTool(tool) {
      if (tool.name !== "bash_background") { pi.registerTool(tool); return; }
      pi.registerTool({
        ...tool,
        parameters: Type.Object({ command: Type.String(), name: Type.Optional(Type.String()) }, { additionalProperties: false }),
        execute(id, args, signal, update, ctx) {
          return tool.execute(id, { command: args.command, name: args.name, background: true }, signal, update, ctx);
        },
      });
    },
  });
}
