import { realpathSync } from "node:fs";
import { publicWebUrl } from "../scripts/codex-network.mjs";

/** Only current-session human input can authorize an exact public web read. */
export class UserWebUrls {
  private root: string | undefined;
  private readonly urls = new Set<string>();
  clear() { this.root = undefined; this.urls.clear(); }
  remember(text: string, source: string, cwd: string, child = false) {
    if (child || !["interactive", "rpc"].includes(source)) return;
    const root = realpathSync(cwd);
    if (root !== this.root) { this.clear(); this.root = root; }
    // Reject oversized input instead of granting a URL cut off at the limit.
    if (text.length > 128 * 1024) return;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/gu)) {
      let value = match[0];
      // Strip one explicit surrounding delimiter, never punctuation in a bare URL.
      const before = text[match.index - 1];
      const close = before === "(" ? ")" : before === "[" ? "]" : before === "'" ? "'" : undefined;
      if (close && value.endsWith(close)) value = value.slice(0, -1);
      try {
        const url = publicWebUrl(value);
        if (!this.urls.has(url) && this.urls.size >= 64) this.urls.delete(this.urls.values().next().value!);
        this.urls.add(url);
      } catch { /* Non-public URLs never grant access. */ }
    }
  }
  includes(value: string, cwd: string) {
    return this.root === realpathSync(cwd) && this.urls.has(publicWebUrl(value));
  }
}
