import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SEARCH_HOSTS, claudeSearchBinary, claudeSearchToken } from "../lib/claude-search.ts";
import { runConfined } from "../lib/confined.ts";

test("search relays only a valid default access token from one fixed keychain entry", { skip: process.platform !== "darwin" }, async t => {
  const agent = mkdtempSync(join(tmpdir(), "pi-search-consent-"));
  t.after(() => rmSync(agent, { recursive: true, force: true }));
  for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const value = process.env[name]; delete process.env[name];
    t.after(() => { if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  }
  const token = "sk-ant-oat01-fixture-access-token", refresh = "never-return-this-refresh-token";
  assert.equal(await claudeSearchToken(agent, undefined, async () => assert.fail("keychain access requires operator opt-in")), undefined);
  const config = join(agent, "web-search.json"), peer = join(agent, "peer.json");
  const noKeychain = async () => assert.fail("invalid or disabled consent must not read credentials");
  writeFileSync(config, '{"keychainBridge":false}', { mode: 0o600 });
  assert.equal(await claudeSearchToken(agent, undefined, noKeychain), undefined);
  for (const value of ['{}', '{"keychainBridge":"true"}', '{"keychainBridge":true,"extra":1}', 'null']) {
    writeFileSync(config, value);
    await assert.rejects(claudeSearchToken(agent, undefined, noKeychain), /Invalid web-search.json/);
  }
  writeFileSync(config, '{"keychainBridge":true}');
  chmodSync(config, 0o644);
  await assert.rejects(claudeSearchToken(agent, undefined, noKeychain), /Unsafe web-search.json/);
  chmodSync(config, 0o600);
  linkSync(config, peer);
  await assert.rejects(claudeSearchToken(agent, undefined, noKeychain), /Unsafe web-search.json/);
  rmSync(config);
  symlinkSync(peer, config);
  await assert.rejects(claudeSearchToken(agent, undefined, noKeychain), { code: "ELOOP" });
  rmSync(config); rmSync(peer);
  writeFileSync(config, '{"keychainBridge":true}', { mode: 0o600 });
  let captured, bytes;
  const execute = async (program, args, options) => {
    captured = { program, args, options };
    bytes = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt: Date.now() + 3600000 } }));
    options.onStdout(bytes);
    return "";
  };
  assert.equal(await claudeSearchToken(agent, undefined, execute), token);
  assert.equal(captured.program, "/usr/bin/security");
  assert.deepEqual(captured.args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  assert.equal(captured.options.timeoutMs, 5000); assert.equal(captured.options.maxBytes, 65536);
  assert.ok(bytes.every(byte => byte === 0)); assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (const raw of ["not-json", '{"claudeAiOauth":{}}', JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 1 } })]) {
    await assert.rejects(claudeSearchToken(agent, undefined, async (_p, _a, options) => { options.onStdout(Buffer.from(raw)); }), /WEB_SEARCH_AUTH_/);
  }
  await assert.rejects(claudeSearchToken(agent, undefined, async () => { throw new Error(refresh); }), error => {
    assert.match(error.message, /WEB_SEARCH_AUTH_UNAVAILABLE/); assert.doesNotMatch(error.message, new RegExp(refresh)); return true;
  });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  assert.equal(await claudeSearchToken(agent, undefined, async () => assert.fail("explicit authentication needs no keychain read")), undefined);
});

test("search pins an installed executable outside the project and respects explicit provider denial", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-boundaries-"))), cwd = join(root, "project"), agent = join(root, "agent"), bin = join(root, "bin");
  for (const dir of [cwd, agent, bin]) mkdirSync(dir);
  const oldPath = process.env.PATH, oldAgent = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, "claude"), "untrusted project executable", { mode: 0o700 });
  writeFileSync(join(bin, "claude"), "installed fixture", { mode: 0o700 });
  process.env.PATH = cwd;
  assert.throws(() => claudeSearchBinary(cwd), /UNTRUSTED_BINARY/);
  process.env.PATH = bin;
  assert.equal(claudeSearchBinary(cwd), join(bin, "claude"));
  process.env.PI_CODING_AGENT_DIR = agent;
  for (const host of CLAUDE_SEARCH_HOSTS) {
    writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: [], deny: [host] }));
    await assert.rejects(runConfined(cwd, "search", { query: "public search" }), /WEB_SEARCH_NETWORK_DENIED/);
  }
  await assert.rejects(runConfined(cwd, "search", { query: "x".repeat(16001) }), /bounded search query/);
});
