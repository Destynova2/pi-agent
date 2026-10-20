import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialSource, httpInspection, inspectHttp } from "../lib/http-inspection.ts";

test("native HTTP inspection transmits referenced Basic/Bearer auth only to the approved endpoint and never follows redirects", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-http-native-"))), agent = join(root, "agent"), file = join(root, ".env");
  mkdirSync(agent); writeFileSync(file, "PASSWORD=fixture-private-password\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, host: req.headers.host });
    if (req.url === "/redirect") return res.writeHead(307, { location: "/trap" }).end("private redirect body");
    if (req.url === "/denied") return res.writeHead(401).end("fixture-private-password");
    if (req.url === "/hang") return;
    if (req.url === "/large") return res.end("x".repeat(1024 * 1024 + 1));
    res.setHeader("set-cookie", "session=private-cookie");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ name: "docker-quay", format: "docker", type: "proxy",
      attributes: { proxy: { remoteUrl: "https://quay.io" } }, echo: "fixture-private-password", private: "must-not-return" }]));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let validated = 0;
  const run = (path, auth, fields, signal = AbortSignal.timeout(3000)) => {
    const request = httpInspection({ url: `${origin}${path}`, reason: "Inspect synthetic fixture", ...(auth ? { auth } : {}), ...(fields ? { fields } : {}) });
    return inspectHttp(request, credentialSource(request, agent), signal, () => { validated++; });
  };
  const basic = { kind: "basic", username: "admin", file, key: "PASSWORD" };
  const response = await run("/repositories", basic, ["name", "format", "type", "attributes.proxy.remoteUrl", "echo"]);
  assert.equal(calls[0].authorization, `Basic ${Buffer.from("admin:fixture-private-password").toString("base64")}`);
  assert.equal(calls[0].host, new URL(origin).host);
  assert.equal(response.rows[0].name, "docker-quay");
  assert.equal(response.rows[0]["attributes.proxy.remoteUrl"], "https://quay.io/");
  assert.doesNotMatch(JSON.stringify(response), /fixture-private-password|private-cookie|must-not-return/);
  assert.equal(response.authenticationVerified, false, "a successful public route does not prove password validity");
  const bearer = await run("/status", { kind: "bearer", file, key: "PASSWORD" });
  assert.equal(calls.at(-1).authorization, "Bearer fixture-private-password");
  assert.equal(bearer.status, 200); assert.equal(bearer.body, "withheld");
  const denied = await run("/denied", basic);
  assert.equal(denied.status, 401); assert.doesNotMatch(JSON.stringify(denied), /fixture-private-password/);
  const before = calls.length, redirect = await run("/redirect", basic, ["name"]);
  assert.equal(redirect.status, 307); assert.equal(redirect.redirect, "refused"); assert.equal(calls.length, before + 1);
  await assert.rejects(run("/large", undefined, ["name"]), /exceeds/);
  await assert.rejects(run("/hang", undefined, undefined, AbortSignal.timeout(30)), /abort/i);
  assert.ok(validated > 0);
});

test("HTTP localhost cannot resolve to an external address even after approval", async () => {
  const request = httpInspection({ url: "http://localhost:8081/", reason: "Synthetic DNS validation" });
  await assert.rejects(inspectHttp(request, undefined, AbortSignal.timeout(1000), () => {},
    async () => ({ address: "192.0.2.1", family: 4 })), /outside loopback/);
});

test("DNS cancellation or stale approval stops dispatch before credentials are read", async () => {
  const request = httpInspection({ url: "https://api.example.com/", reason: "Synthetic DNS cancellation" });
  let finish, reads = 0, checks = 0;
  const resolution = new Promise(resolve => { finish = resolve; }), controller = new AbortController();
  const source = { read() { reads++; return "fixture-secret"; } };
  const pending = inspectHttp(request, source, controller.signal, () => { checks++; }, () => resolution);
  const stopped = assert.rejects(pending, /cancelled/);
  controller.abort(new Error("cancelled")); await stopped;
  finish({ address: "127.0.0.1", family: 4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.equal(checks, 0);
  await assert.rejects(inspectHttp(request, source, AbortSignal.timeout(1000), () => { throw new Error("stale"); },
    async () => ({ address: "127.0.0.1", family: 4 })), /stale/);
  assert.equal(reads, 0);
});

test("HTTPS rejects an untrusted certificate before sending credentials even with a permissive TLS environment", async t => {
  // Public test-only key and self-signed certificate; never use them for a service.
  const key = readFileSync(new URL("./fixtures/http-inspection/untrusted-key.pem", import.meta.url));
  const cert = readFileSync(new URL("./fixtures/http-inspection/untrusted-cert.pem", import.meta.url));
  let requests = 0;
  const server = createHttpsServer({ key, cert }, (_req, res) => { requests++; res.end("{}"); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; });
  const request = httpInspection({ url: `https://localhost:${server.address().port}/`, reason: "Reject untrusted TLS",
    auth: { kind: "bearer", file: "/fixture/.env", key: "PASSWORD" } });
  await assert.rejects(inspectHttp(request, { read: () => "fixture-private-password" }, AbortSignal.timeout(3000), () => {},
    async () => ({ address: "127.0.0.1", family: 4 })), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.equal(requests, 0);
});
