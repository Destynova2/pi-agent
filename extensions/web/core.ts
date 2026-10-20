import { tmpdir } from "node:os";
import { runProcess } from "../../lib/process.ts";
import { grobWebSearch } from "../../lib/grob.ts";

/** No intermediate model. The text read afterward by pi counts toward its context. */
export async function curlFetch(url: string, signal?: AbortSignal, followRedirects = true): Promise<string> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("HTTP(S) URL without credentials required");
  }
  let response: string;
  try {
    response = await runProcess("/usr/bin/curl", [
      "-q", "--silent", "--show-error", "--globoff", "--request", "GET",
      ...(followRedirects ? ["--location"] : []),
      "--proto", "=http,https", "--proto-redir", "=http,https",
      "--max-redirs", "5", "--max-time", "30",
      "--write-out", "\nPI_WEB_STATUS:%{http_code}:%{http_connect}\n", "--", parsed.href,
    ], { cwd: tmpdir(), signal, timeoutMs: 32_000, maxBytes: 4 * 1024 * 1024 });
  } catch (error) {
    if (/CONNECT tunnel failed, response 403|HTTP code 403 from proxy after CONNECT/i.test(String(error))) {
      throw new Error("WEB_PROXY_DENIED: proxy rejected the connection. This is not evidence that the website requires login. Do not request broader network access for an already authorized exact web read.");
    }
    throw error;
  }
  const status = /(?:^|\n)PI_WEB_STATUS:(\d{3}):(\d{3})$/.exec(response);
  if (!status) throw new Error("Missing web response status");
  const code = Number(status[1]);
  if (code === 403) throw new Error("WEB_HTTP_FORBIDDEN: HTTP 403. The site or proxy refused this read; the status alone does not establish an authentication problem. Do not request broader host access or credentials on this evidence alone.");
  if (code >= 400) throw new Error(`WEB_HTTP_ERROR: HTTP ${code}`);
  if (code >= 300) throw new Error(`WEB_REDIRECT: HTTP ${code}. The exact user URL redirected; no other URL was fetched and no wider network access was granted.`);
  if (code < 200) throw new Error(`Unexpected web response status ${code}`);
  const raw = response.slice(0, status.index);
  if (!/<(?:!doctype\s+html|html)[\s>]/i.test(raw)) return raw;
  return raw.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").trim();
}

/** Legacy worker entry uses the same proxy and has no credential discovery. */
export async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  return grobWebSearch(query, signal);
}
