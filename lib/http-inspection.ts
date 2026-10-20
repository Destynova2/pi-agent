import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { redactAudit } from "./audit-redaction.ts";

export interface HttpInspection {
  url: string;
  reason: string;
  fields?: string[];
  auth?: { kind: "basic" | "bearer"; file: string; key: string; username?: string };
}
const key = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const sensitive = /password|passwd|passphrase|secret|token|api.?key|authorization|cookie|credential|private.?key|^env$|^environment$|^headers$/i;
const protectedNames = new Set([".git", ".jj", ".pi", ".codex", ".agents", ".ssh", ".aws", ".kube"]);
const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/** Freeze the public request before review. Credentials are references, never values. */
export function httpInspection(value: unknown): HttpInspection {
  const input: unknown = JSON.parse(JSON.stringify(value));
  if (!record(input) || Buffer.byteLength(JSON.stringify(input)) > 4096 ||
      Object.keys(input).some(key => !["url", "reason", "fields", "auth"].includes(key))) throw new Error("Invalid or oversized HTTP inspection request");
  if (typeof input.url !== "string" || input.url.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(input.url)) throw new Error("Expected one HTTP(S) URL");
  let url: URL;
  try { url = new URL(input.url); } catch { throw new Error("Invalid HTTP inspection URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname.endsWith(".") ||
      url.protocol === "http:" && !loopback.has(hostname(url))) throw new Error("Use HTTPS, or HTTP on loopback, without URL credentials, query, fragment or terminal DNS dot");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("A bounded reason without control characters is required");
  if (input.fields !== undefined && (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 12 ||
      input.fields.some(field => typeof field !== "string" || field.length > 128 || field.split(".").length > 4 ||
        field.split(".").some(part => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || sensitive.test(part) || ["constructor", "prototype"].includes(part))))) throw new Error("Select 1–12 non-secret scalar JSON fields, at most four path segments");
  if (input.auth !== undefined) {
    const auth = input.auth;
    if (!record(auth) || Object.keys(auth).some(key => !["kind", "file", "key", "username"].includes(key)) ||
        !["basic", "bearer"].includes(String(auth.kind)) || typeof auth.file !== "string" || auth.file.length > 1024 ||
        typeof auth.key !== "string" || !key.test(auth.key) ||
        (auth.kind === "basic" ? typeof auth.username !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}$/.test(auth.username) : auth.username !== undefined)) throw new Error("Expected a dotenv credential reference and a public username for Basic auth");
  }
  return { ...input, url: url.href } as unknown as HttpInspection;
}

function fileIdentity(file: string, agentDir: string): string {
  const rel = relative(realpathSync(agentDir), file);
  if (!isAbsolute(file) || resolve(file) !== file || realpathSync(file) !== file ||
      (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) ||
      file.split("/").some(part => protectedNames.has(part))) throw new Error("Expected an exact dotenv path outside protected credential or runtime storage");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error("Credential source must be a regular file of at most 64 KiB");
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs]);
}

/** Metadata only before approval. An exact outside-workspace file is part of the reviewed capability. */
export function credentialSource(request: HttpInspection, agentDir: string) {
  if (!request.auth) return undefined;
  const { file, key } = request.auth;
  const identity = fileIdentity(file, agentDir);
  const validate = () => {
    if (fileIdentity(file, agentDir) !== identity) throw new Error("Credential source changed during approval");
  };
  const read = () => {
    validate();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (JSON.stringify([stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs]) !== identity || !stat.isFile() || stat.nlink !== 1) throw new Error("Credential source changed before reading");
      const bytes = Buffer.alloc(65537);
      let size = 0, count: number;
      try {
        while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
        if (size > 65536) throw new Error("Credential source exceeds its limit");
        const values = parseEnv(bytes.subarray(0, size).toString("utf8"));
        const secret = Object.hasOwn(values, key) ? values[key] : undefined;
        validate();
        if (!secret || Buffer.byteLength(secret) > 8192 || /[\u0000-\u001f\u007f]/.test(secret)) throw new Error("Credential key absent, empty or invalid; values withheld");
        return secret;
      } finally { bytes.fill(0); }
    } finally { closeSync(fd); }
  };
  return { identity, validate, read };
}

/** Return only requested scalar fields; no raw response, cookies or credentials. */
export function projectHttpJson(body: string, fields: string[], secrets: string[]) {
  const data: unknown = JSON.parse(body);
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length > 2000 || rows.some(row => !record(row))) throw new Error("Expected a bounded JSON object or array of objects");
  const masks = [...new Set(secrets.filter(Boolean).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]))].sort((a, b) => b.length - a.length);
  const selected = rows.map(row => Object.fromEntries(fields.map(field => {
    let value: unknown = row;
    for (const part of field.split(".")) value = record(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    if (["number", "boolean"].includes(typeof value) && masks.some(mask => String(value).includes(mask))) value = "[REDACTED]";
    if (typeof value === "string") {
      for (const secret of masks) value = (value as string).replaceAll(secret, "[REDACTED]");
      value = redactAudit(value).value;
      if (typeof value === "string") value = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 512);
    }
    return [field, value === null || ["string", "number", "boolean"].includes(typeof value) ? value : null];
  })));
  if (Buffer.byteLength(JSON.stringify(selected)) > 256 * 1024) throw new Error("Selected HTTP response exceeds its output limit");
  return selected;
}

type Lookup = typeof lookup;
async function lookupAddress(host: string, resolveHost: Lookup, signal: AbortSignal): Promise<LookupAddress> {
  let abort = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  // The system resolver may finish later; cancellation must never dispatch a GET.
  try { return await Promise.race([resolveHost(host), canceled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** One direct, reviewed GET. Pin the resolved address, preserve Host/TLS identity, never redirect. */
export async function inspectHttp(request: HttpInspection, source: ReturnType<typeof credentialSource>, signal: AbortSignal,
  revalidate: () => void, resolveHost: Lookup = lookup) {
  const url = new URL(request.url), host = hostname(url);
  signal.throwIfAborted();
  const address = isIP(host) ? { address: host, family: isIP(host) } : await lookupAddress(host, resolveHost, signal);
  revalidate();
  signal.throwIfAborted();
  if (url.protocol === "http:" && !["127.0.0.1", "::1"].includes(address.address)) throw new Error("HTTP loopback name resolved outside loopback");
  let secret = source?.read(), authorization: string | undefined;
  if (request.auth && secret) authorization = request.auth.kind === "basic" ? `Basic ${Buffer.from(`${request.auth.username}:${secret}`).toString("base64")}` : `Bearer ${secret}`;
  try {
    revalidate();
    return await new Promise<Record<string, unknown>>((resolveResult, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const client = send({
        hostname: address.address, family: address.family, port: url.port || (url.protocol === "https:" ? 443 : 80),
        servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
        path: url.pathname, method: "GET", agent: false, signal,
        headers: { host: url.host, accept: "application/json", "accept-encoding": "identity", ...(authorization ? { authorization } : {}) },
      }, response => {
        const status = response.statusCode ?? 0;
        const result = { url: request.url, status, authenticatedRequest: !!authorization, authenticationVerified: false };
        if (!request.fields || status < 200 || status >= 300) {
          response.destroy();
          resolveResult({ ...result, body: "withheld", ...(status >= 300 && status < 400 ? { redirect: "refused" } : {}) });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) { response.destroy(); reject(new Error("HTTP response exceeds 1 MiB")); }
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const values = [secret ?? "", authorization ?? "", ...(request.auth?.kind === "basic" ? [`${request.auth.username}:${secret}`] : [])];
            resolveResult({ ...result, rows: projectHttpJson(Buffer.concat(chunks).toString("utf8"), request.fields!, values) });
          } catch { reject(new Error("Invalid or oversized selected JSON response; body withheld")); }
        });
      });
      client.once("error", reject);
      client.end();
    });
  } finally { secret = authorization = undefined; }
}
