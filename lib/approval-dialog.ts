import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** Review the entire payload before exposing approval choices. Escape always denies. */
export async function approvalDialog(ctx: ExtensionContext, title: string, choices: string[], options?: ExtensionUIDialogOptions): Promise<string | undefined> {
  options?.signal?.throwIfAborted();
  const columns = process.stdout.columns ?? 80, rows = process.stdout.rows ?? 24, width = columns - 4;
  if (columns < 40 || rows < 16) throw new Error("Enlarge the terminal to at least 40 columns and 16 rows to review this approval");
  const next = "Lire la page suivante", previous = "Relire la page précédente";
  const choiceRows = Math.max(...[[...choices, previous], [choices[0], next, previous]].map(items => items.reduce((n, item) => n + wrapTextWithAnsi(item, width).length, 0)));
  // Native selector borders, spacers, navigation hint, page heading and footer.
  const height = Math.max(1, rows - choiceRows - 10);
  const lines = wrapTextWithAnsi(title, width);
  const pages = Math.ceil(lines.length / height);
  let page = 0;
  while (true) {
    options?.signal?.throwIfAborted();
    const last = page === pages - 1;
    const offered = [...(last ? choices : [choices[0], next]), ...(page ? [previous] : [])];
    const reply = await ctx.ui.select(`Validation — page ${page + 1}/${pages}\n${lines.slice(page * height, (page + 1) * height).join("\n")}`, offered, options);
    options?.signal?.throwIfAborted();
    if ((process.stdout.columns ?? 80) !== columns || (process.stdout.rows ?? 24) !== rows) return approvalDialog(ctx, title, choices, options);
    if (page && reply === previous) { page--; continue; }
    if (!last && reply === next) { page++; continue; }
    if (reply === choices[0]) return reply;
    return last && reply && choices.includes(reply) ? reply : undefined;
  }
}
