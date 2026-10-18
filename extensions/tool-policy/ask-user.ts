import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A decision only the user can make (accept a dependency, pick between approaches) used to end the
 * turn with a question. This asks it in a dialog and lets the model continue with the answer.
 * It grants nothing: capability tools keep their own approvals.
 */
export const MAX_QUESTIONS_PER_SESSION = 40;

export function registerAskUser(pi: ExtensionAPI, verify: (ctx: ExtensionContext) => void) {
  let asked = 0;
  pi.on("session_start", () => { asked = 0; });
  pi.registerTool({
    name: "ask_user", label: "Ask the user", executionMode: "sequential",
    description: "Ask the human one bounded question in a dialog and continue with the answer, instead of ending the turn. With options (2-6), the user picks one; without, a yes/no confirmation. Returns the chosen option, \"yes\", \"no\" or \"cancelled\". Interactive parent only; it is a decision, never a permission.",
    promptGuidelines: [
      "Use ask_user for a decision only the user can make (accepting a dependency, choosing between approaches, a scope question) when the rest of the task waits on it; one question at a time, with the context in detail. Not for permissions, which capability tools request themselves, and not to replace reporting at the end of the turn.",
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 300 }),
      detail: Type.Optional(Type.String({ maxLength: 1500, description: "What the user needs to decide well: consequences, alternatives, what happens on no" })),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 2, maxItems: 6 })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("ask_user needs the interactive parent; report the open decision instead");
      if (asked >= MAX_QUESTIONS_PER_SESSION) throw new Error(`ask_user budget used (${MAX_QUESTIONS_PER_SESSION} per session); report the remaining decisions`);
      asked++;
      const clean = (text: string) => text.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
      const prompt = clean(input.detail ? `${input.question}\n${input.detail}` : input.question);
      let answer: string;
      if (input.options) {
        const options = input.options.map(clean);
        if (new Set(options).size !== options.length) throw new Error("ask_user options must be distinct");
        answer = (await ctx.ui.select(prompt, options, { signal })) ?? "cancelled";
      } else answer = (await ctx.ui.confirm(input.question, clean(input.detail ?? ""), { signal })) ? "yes" : "no";
      return { content: [{ type: "text" as const, text: answer }], details: undefined };
    },
  });
}
