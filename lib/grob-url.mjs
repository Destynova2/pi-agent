export const DEFAULT_GROB_URL = "http://127.0.0.1:13456";

/** Shared by the transport and doctor; never include a rejected URL in errors. */
export function grobUrl(value = process.env.GROB_URL ?? DEFAULT_GROB_URL) {
  let url;
  try { url = new URL(value); } catch { /* Use the same non-secret error below. */ }
  if (!url || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") throw new Error("GROB_URL must be a loopback HTTP(S) origin without credentials or a path");
  return url.origin;
}
