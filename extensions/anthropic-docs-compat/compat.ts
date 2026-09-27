import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DocumentationPaths {
  readme: string;
  docs: string;
  examples: string;
}

/** Build the guide from public asset paths, not from Pi's current prompt wording. */
export function documentationGuide(paths: DocumentationPaths): string {
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${paths.readme}
- Additional docs: ${paths.docs}
- Examples: ${paths.examples} (extensions, custom tools, SDK)
Resolve documentation paths under the docs/examples directories above, not cwd. Start at index.md in Additional docs for topic references.
For Pi work, read the relevant documentation fully, its examples, and linked Markdown before implementing.`;
}

/** Override the structured default docs section while leaving user instructions intact. */
export function registerDocsCompat(pi: ExtensionAPI, paths: DocumentationPaths): void {
  const guide = documentationGuide(paths);
  let warned = false;
  pi.on("session_start", () => { warned = false; });
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider !== "anthropic") return;
    const options = event.systemPromptOptions;
    // An incompatible extension API must never silently replace the whole prompt.
    if (!options || !options.sections || typeof options.sections !== "object") {
      if (warned) return;
      warned = true;
      const message = "anthropic-docs-compat : API de sections Pi indisponible, correctif non appliqué. " +
        "Mettre à jour cette extension ou la retirer si Pi fournit déjà une aide courte.";
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(message);
      return;
    }
    // User-owned prompts and docs always win, including an explicit empty section.
    if (options.forceSystemPrompt !== undefined || options.customPrompt || Object.hasOwn(options.sections, "docs")) return;
    options.sections.docs = guide;
  });
}
