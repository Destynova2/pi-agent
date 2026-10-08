type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const HIDDEN = "[REDACTED]";
const OMITTED = "[OMITTED]";
const SENSITIVE = /password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|^stdin$|^env$|^environment$|^headers$/i;
const SECRET_LABEL = "[\\w.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)[\\w.-]*";
const ASSIGNMENT = new RegExp(`(["']?\\b${SECRET_LABEL}["']?\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;\\]}]+)`, "gi");
const FLAG = new RegExp(`(--?${SECRET_LABEL}\\s+)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s;]+)`, "gi");

export function sensitiveDialog(title: string): boolean {
  return SENSITIVE.test(title) || /mot de passe|jeton|clé (?:api|privée)|cle (?:api|privee)/i.test(title);
}

/** Known secret formats only. Unlabelled secrets cannot be identified reliably. */
export function redactAudit(value: unknown): { value: Json; redactions: number; truncated: boolean } {
  let redactions = 0, truncated = false, budget = 128 * 1024, nodes = 0;
  const seen = new WeakSet<object>();
  const hidden = () => { redactions++; return HIDDEN; };
  const omitted = () => { truncated = true; return OMITTED; };
  const text = (input: string): string => {
    // Never keep a prefix of an uninspected oversized secret or binary payload.
    if (input.length > 1024 * 1024 || budget <= 0) return omitted();
    let result = input
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
    result = result
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, hidden)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, hidden)
      .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g, hidden)
      .replace(/\b(?:token|secret|password)[_-][A-Za-z0-9_-]{8,}\b/gi, hidden)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden)
      .replace(/\b(?:https?|postgres(?:ql)?|redis|mysql):\/\/[^\s<>"']+/gi, url => {
        try {
          const parsed = new URL(url);
          if (parsed.username || parsed.password) { parsed.username = HIDDEN; parsed.password = ""; redactions++; }
          for (const key of new Set(parsed.searchParams.keys())) { parsed.searchParams.set(key, HIDDEN); redactions++; }
          if (parsed.hash) { parsed.hash = HIDDEN; redactions++; }
          return parsed.toString();
        } catch { return hidden(); }
      })
      .replace(ASSIGNMENT, (_match, label: string) => `${label}${hidden()}`)
      .replace(FLAG, (_match, label: string) => `${label}${hidden()}`);
    const limit = Math.min(32768, budget);
    if (result.length > limit) { result = `${result.slice(0, limit)}[TRUNCATED]`; truncated = true; }
    budget -= result.length;
    return result;
  };
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > 4096 || depth > 12 || budget <= 0) return omitted();
    if (item === null || item === undefined) return null;
    if (typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "string") {
      // Tool arguments and reviewer requests often contain serialized JSON.
      if (item.length <= 1024 * 1024 && /^[\s]*[\[{]/.test(item)) {
        try { return JSON.stringify(visit(JSON.parse(item), depth + 1)); } catch { /* Plain text still needs masking. */ }
      }
      return text(item);
    }
    if (typeof item !== "object") return `[${typeof item}]`;
    if (seen.has(item)) return omitted();
    seen.add(item);
    try {
      if (item instanceof Error) {
        return visit({ name: item.name, message: item.message, ...("code" in item ? { code: item.code } : {}) }, depth + 1);
      }
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return omitted();
      if (Array.isArray(item)) {
        const result = item.slice(0, 256).map(child => visit(child, depth + 1));
        if (item.length > 256) result.push(omitted());
        return result;
      }
      const object = item as Record<string, unknown>;
      if (["image", "audio", "thinking", "redacted_thinking"].includes(String(object.type))) {
        return { type: String(object.type), content: omitted() };
      }
      const result: Record<string, Json> = Object.create(null);
      const entries = Object.entries(object);
      for (const [key, child] of entries.slice(0, 256)) {
        result[text(key)] = SENSITIVE.test(key) ? hidden() : /^(data|blob|base64|signature|thinking)$/i.test(key) ? omitted() : visit(child, depth + 1);
      }
      if (entries.length > 256) result._truncated = omitted();
      return result;
    } finally { seen.delete(item); }
  };
  const cleaned = visit(value, 0);
  return { value: cleaned, redactions, truncated };
}
