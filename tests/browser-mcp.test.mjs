import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBrowserMcp, validateBrowserServer } from "../lib/browser-mcp.ts";

const image = `sha256:${"a".repeat(64)}`;
const definition = () => ({ command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--isolated"], network: true, browser: { image, localhostPorts: [8092] } });

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-browser-unit-")));
  const cwd = join(root, "project"), agent = join(root, "agent"), key = join(root, "key");
  mkdirSync(cwd); mkdirSync(agent); writeFileSync(key, "fixture", { mode: 0o600 });
  const old = process.env.PI_PODMAN_BIN; process.env.PI_PODMAN_BIN = process.execPath;
  t.after(() => { if (old === undefined) delete process.env.PI_PODMAN_BIN; else process.env.PI_PODMAN_BIN = old; rmSync(root, { recursive: true, force: true }); });
  const calls = [], server = definition(); let create, metadata = `${image} 0.0.83`;
  const execute = async (_program, args, options) => {
    calls.push({ args, options });
    if (args[0] === "system") return JSON.stringify([{ Default: true, URI: "ssh://root@127.0.0.1:6000/run/podman.sock", Identity: key }]);
    const operation = args[6];
    if (operation === "image") return metadata;
    if (operation === "create") { await create?.(); return "b".repeat(64); }
    assert.equal(operation, "rm"); return "";
  };
  return { calls, server, key, prepare: signal => prepareBrowserMcp(server, cwd, agent, signal, execute), set create(value) { create = value; }, set metadata(value) { metadata = value; } };
}

test("browser profile rejects arbitrary commands, flags, environment, mutable tags and unbounded relays", () => {
  for (const browser of [null, [], {}, { image: "localhost/browser:latest" }, { image, mount: "/" }, { image, localhostPorts: [80] }, { image, localhostPorts: [65536] }, { image, localhostPorts: [8092, 8092] }, { image, localhostPorts: ["8092"] }, { image, localhostPorts: "8092" }, { image, localhostPorts: Array.from({ length: 17 }, (_, i) => 8092 + i) }]) {
    assert.throws(() => validateBrowserServer({ ...definition(), browser }));
  }
  for (const override of [{ command: "sh" }, { args: ["-y", "@playwright/mcp@latest"] }, { env: { TOKEN: "secret" } }, { network: false }]) {
    assert.throws(() => validateBrowserServer({ ...definition(), ...override }));
  }
  validateBrowserServer(definition());
  validateBrowserServer({ ...definition(), network: false, browser: { image }, args: [...definition().args, "--headless"] });
});

test("discovery never creates a browser; denied launch and invalid images remain inert", async t => {
  const f = fixture(t), browser = await f.prepare();
  await assert.rejects(browser.start(() => { throw new Error("denied"); }), /denied/);
  assert.equal(f.calls.length, 2);
  for (const value of ["", `${image} 0.0.82`, `${"c".repeat(64)} 0.0.83`]) {
    f.metadata = value; await assert.rejects(f.prepare(), /reviewed Playwright/);
  }
  assert.ok(f.calls.every(call => !call.args.includes("create")));
});

test("browser freezes its network and ports, clears host credentials, and removes only its owned container once", async t => {
  const f = fixture(t), browser = await f.prepare();
  f.server.browser.localhostPorts.push(9999); f.server.network = false;
  const rpc = await browser.start(() => {});
  const create = f.calls[2];
  assert.equal(create.args[6], "create");
  assert.ok(create.args.includes("--network=bridge"));
  assert.deepEqual(create.args.slice(-2), ["/opt/pi-browser/entrypoint.mjs", "8092"]);
  assert.equal(create.options.env.CONTAINER_HOST, undefined);
  const name = create.args[create.args.indexOf("--name") + 1];
  assert.match(name, /^pi-mcp-browser-/);
  await rpc.shutdown(); await rpc.shutdown();
  assert.deepEqual(f.calls.at(-1).args.slice(6), ["rm", "--force", "--ignore", name]);
  assert.equal(f.calls.length, 4);
});

test("canceled or revoked launch cleans the created container without reusing the canceled signal", async t => {
  for (const cancel of [true, false]) {
    const f = fixture(t), controller = new AbortController(); let granted = true;
    f.create = () => { if (cancel) controller.abort(); else granted = false; };
    const browser = await f.prepare(controller.signal);
    await assert.rejects(browser.start(() => { if (!granted) throw new Error("revoked"); }));
    assert.equal(f.calls.at(-1).args[6], "rm");
    assert.equal(f.calls.at(-1).options.signal, undefined);
  }
});

test("changed Podman identity and delegated sessions cannot launch", async t => {
  const f = fixture(t), browser = await f.prepare();
  writeFileSync(f.key, "replacement");
  await assert.rejects(browser.start(() => {}), /identity changed/);
  assert.equal(f.calls.length, 2);
  const old = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.prepare(), /parent session/); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = old; }
  assert.equal(f.calls.length, 2);
});
