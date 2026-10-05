import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlFetch } from "../core.ts";

// Requires host loopback access; never disable a sandbox proxy to make this pass.
test("fetch without LLM: redirect and HTML over real HTTP", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "file:///etc/passwd" }); response.end(); }
    else { response.end("<!doctype html><html><script>untrusted()</script><p>Hello</p></html>"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal(await curlFetch(url), "Hello");
    await assert.rejects(curlFetch(`${url}/redirect`));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("exact web reads issue one GET, do not follow redirects or load curlrc, and distinguish HTTP 403", async () => {
  const requests: { path: string | undefined; method: string | undefined; cookie: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, cookie: request.headers.cookie, authorization: request.headers.authorization });
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/never" }); response.end(); }
    else if (request.url === "/forbidden") { response.writeHead(403); response.end("Login required? This untrusted body must not supply the diagnostic."); }
    else response.end("exact body");
  });
  const home = await mkdtemp(join(tmpdir(), "pi-web-curlrc-"));
  const previous = process.env.CURL_HOME;
  process.env.CURL_HOME = home;
  await writeFile(join(home, ".curlrc"), 'header = "Cookie: secret"\nheader = "Authorization: secret"\nrequest = "POST"\n');
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(await curlFetch(`${base}/exact`, undefined, false), "exact body");
    await assert.rejects(curlFetch(`${base}/redirect`, undefined, false), /WEB_REDIRECT/);
    await assert.rejects(curlFetch(`${base}/forbidden`, undefined, false), /WEB_HTTP_FORBIDDEN/);
    assert.deepEqual(requests.map(item => item.path), ["/exact", "/redirect", "/forbidden"]);
    for (const request of requests) assert.deepEqual({ ...request, path: undefined }, { path: undefined, method: "GET", cookie: undefined, authorization: undefined });
  } finally {
    if (previous === undefined) delete process.env.CURL_HOME; else process.env.CURL_HOME = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
