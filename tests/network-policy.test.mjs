import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NETWORK_HOSTS, networkHosts, networkSandboxArgs, normalizeHost, readNetworkPolicy, requireNetworkProxyVersion } from "../scripts/codex-network.mjs";
import { registerNetworkAccess } from "../extensions/tool-policy/network.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-network-test-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  const policy = value => writeFileSync(join(agent, "network-policy.json"), JSON.stringify(value));
  return { root, agent, cwd, policy };
}

test("network policies accept exact public DNS names only, fail closed and never trust project policies", () => {
  const f = fixture();
  try {
    assert.equal(normalizeHost("API.GitHub.com"), "api.github.com");
    for (const value of ["*", "*.github.com", "https://github.com", "github.com:443", "user@github.com", "localhost", "127.0.0.1", "127.1", "[::1]", "a.local", "a.internal", "a.test", "github.com.", " github.com", "github.com\n", "a..com", "bad'host.com"]) assert.throws(() => normalizeHost(value), undefined, value);
    writeFileSync(join(f.cwd, "network-policy.json"), '{"allow":["evil.example.com"]}');
    assert.deepEqual(readNetworkPolicy(f.agent).allow, [...DEFAULT_NETWORK_HOSTS]);
    f.policy({ allow: ["API.GitHub.com", "api.github.com"], deny: ["api.github.com"] });
    assert.deepEqual(networkHosts(f.agent, f.cwd), []);
    for (const value of [null, [], { allow: ["*"] }, { allow: [], unexpected: true }, { allow: "github.com" }]) {
      f.policy(value); assert.throws(() => readNetworkPolicy(f.agent));
    }
    rmSync(join(f.agent, "network-policy.json"));
    symlinkSync(join(f.cwd, "network-policy.json"), join(f.agent, "network-policy.json"));
    assert.throws(() => readNetworkPolicy(f.agent));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("grant files are host-owned, workspace-scoped, and explicit denies override approvals", () => {
  const f = fixture();
  try {
    f.policy({ allow: [], deny: ["blocked.example.com"] });
    mkdirSync(join(f.agent, "network-grants"));
    const path = join(f.agent, "network-grants/one.json");
    const grant = { cwd: f.cwd, hosts: ["extra.example.com", "blocked.example.com"] };
    writeFileSync(path, JSON.stringify(grant));
    assert.deepEqual(networkHosts(f.agent, f.cwd, path), ["extra.example.com"]);
    assert.throws(() => networkHosts(f.agent, f.root, path), /different workspace/);
    const forged = join(f.cwd, "forged.json");
    writeFileSync(forged, JSON.stringify(grant));
    assert.throws(() => networkHosts(f.agent, f.cwd, forged), /trusted grant directory/);
    rmSync(path); symlinkSync(forged, path);
    assert.throws(() => networkHosts(f.agent, f.cwd, path));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native proxy profile requires the feature, preserves filesystem restrictions and disables bypass channels", () => {
  const args = networkSandboxArgs("echo 'kept'; curl https://github.com", "/work/project", "/private/scratch", ["github.com"]);
  assert.deepEqual(args.slice(0, 5), ["sandbox", "-C", "/work/project", "-P", "pi"]);
  assert.ok(args.includes("features.network_proxy=true"));
  const profile = args.find(value => value.startsWith("permissions="));
  for (const required of ['extends=":workspace"', '":slash_tmp"="read"', '"/private/scratch"="write"', '".pi"="read"', '"github.com"="allow"', 'proxy_url="http://127.0.0.1:0"', "enable_socks5=false", "allow_upstream_proxy=false", "allow_local_binding=false"]) assert.ok(profile.includes(required), required);
  assert.equal(args.some(arg => arg.includes("sandbox_mode=")), false, "legacy sandbox settings must not override the profile");
  assert.equal(args.at(-1), "echo 'kept'; curl https://github.com");
  assert.throws(() => networkSandboxArgs("true", "/work", "/tmp/private", ["*"]));
  for (const version of ["codex-cli 0.155.1", "codex-cli 0.156.0", "codex-cli 1.0.0"]) requireNetworkProxyVersion(version);
  for (const version of ["codex-cli 0.146.0", "codex-cli 0.155.0", "unknown", "codex-cli 0.155.1-beta"]) assert.throws(() => requireNetworkProxyVersion(version));
});

test("private Git proxy scope must contain exactly the reviewed hostname", () => {
  for (const hosts of [[], ["other.example.com"], ["git.example.com", "github.com"]]) assert.throws(() => networkSandboxArgs("worker", "/work", "/private/tmp", hosts, [], [], "git.example.com"), /exactly its reviewed host/);
  const privateArgs = () => networkSandboxArgs("fixed-worker", "/work", "/private/tmp", ["git.example.com"], [], [], "git.example.com");
  if (process.platform !== "linux") {
    assert.throws(privateArgs, /PRIVATE_GIT_NETWORK_UNAVAILABLE/);
  } else {
    const profile = privateArgs().find(value => value.startsWith("permissions="));
    assert.match(profile, /allow_local_binding=true/);
    assert.match(profile, /domains=\{"git.example.com"="allow"\}/);
  }
});

function session(f, confirm = async () => true) {
  const handlers = new Map(); let tool; let calls = 0;
  const ctx = { cwd: f.cwd, hasUI: true, ui: { confirm: (...args) => { calls++; return confirm(...args); } } };
  registerNetworkAccess({ on: (event, handler) => handlers.set(event, handler), registerTool: definition => { tool = definition; } }, f.agent, () => {});
  handlers.get("session_start")({}, ctx);
  return { ctx, handlers, get calls() { return calls; },
    request: (hosts, signal) => tool.execute("id", { hosts, reason: "download dependency" }, signal, undefined, ctx),
    close: () => handlers.get("session_shutdown")(),
  };
}

test("automatic baseline, one approval per new host, no inherited/replayed grants, and baseline removal stays effective", async () => {
  const f = fixture(), old = process.env.PI_CODEX_NETWORK_GRANTS;
  f.policy({ allow: ["auto.example.com"] });
  const s = session(f);
  try {
    await s.request(["auto.example.com"]);
    assert.equal(s.calls, 0);
    await Promise.all([s.request(["extra.example.com"]), s.request(["extra.example.com"])]);
    assert.equal(s.calls, 1, "concurrent duplicates share the confirmed grant");
    const file = process.env.PI_CODEX_NETWORK_GRANTS;
    assert.deepEqual(networkHosts(f.agent, f.cwd, file), ["auto.example.com", "extra.example.com"]);
    f.policy({ allow: [] });
    await s.request(["second.example.com"]);
    assert.deepEqual(networkHosts(f.agent, f.cwd, file), ["extra.example.com", "second.example.com"]);
    const event = { systemPromptOptions: { sections: {} } };
    s.handlers.get("before_agent_start")(event, s.ctx);
    assert.match(event.systemPromptOptions.sections.network_access, /request_network_access/);
    s.close();
    assert.equal(process.env.PI_CODEX_NETWORK_GRANTS, undefined);
    assert.throws(() => readFileSync(file));
  } finally { s.close(); if (old === undefined) delete process.env.PI_CODEX_NETWORK_GRANTS; else process.env.PI_CODEX_NETWORK_GRANTS = old; rmSync(f.root, { recursive: true, force: true }); }
});

test("denied, explicitly forbidden and headless requests never obtain grants or repeat refusal prompts", async () => {
  const f = fixture(), old = process.env.PI_CODEX_NETWORK_GRANTS;
  f.policy({ allow: [], deny: ["blocked.example.com"] });
  const s = session(f, async () => false);
  try {
    await assert.rejects(s.request(["blocked.example.com"]), /explicitly denied/);
    assert.equal(s.calls, 0);
    await assert.rejects(s.request(["extra.example.com"]), /refused/);
    await assert.rejects(s.request(["extra.example.com"]), /refused earlier/);
    assert.equal(s.calls, 1);
    s.ctx.hasUI = false;
    await assert.rejects(s.request(["other.example.com"]), /No UI/);
    assert.equal(s.calls, 1);
    assert.equal(process.env.PI_CODEX_NETWORK_GRANTS, undefined);
  } finally { s.close(); if (old === undefined) delete process.env.PI_CODEX_NETWORK_GRANTS; else process.env.PI_CODEX_NETWORK_GRANTS = old; rmSync(f.root, { recursive: true, force: true }); }
});

test("abort, session replacement and a new explicit deny invalidate pending network approval", async () => {
  for (const mode of ["abort", "session", "deny"]) {
    const f = fixture(), old = process.env.PI_CODEX_NETWORK_GRANTS;
    f.policy({ allow: [] });
    let answer;
    const s = session(f, () => new Promise(resolve => { answer = resolve; }));
    try {
      const controller = new AbortController();
      const pending = s.request(["extra.example.com"], controller.signal);
      const rejected = assert.rejects(pending, /stale|aborted|policy changed/);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === "abort") controller.abort();
      if (mode === "session") s.handlers.get("session_start")({}, s.ctx);
      if (mode === "deny") f.policy({ allow: [], deny: ["extra.example.com"] });
      answer(true);
      await rejected;
      assert.equal(process.env.PI_CODEX_NETWORK_GRANTS, undefined);
    } finally { s.close(); if (old === undefined) delete process.env.PI_CODEX_NETWORK_GRANTS; else process.env.PI_CODEX_NETWORK_GRANTS = old; rmSync(f.root, { recursive: true, force: true }); }
  }
});
