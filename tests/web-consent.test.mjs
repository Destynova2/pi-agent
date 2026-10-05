import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserWebUrls } from "../lib/web-consent.ts";
import { publicWebUrl } from "../scripts/codex-network.mjs";
import web from "../extensions/web/index.ts";

test("public read URLs forbid credentials, private literals, non-web protocols and custom ports", () => {
  assert.equal(publicWebUrl("https://EXAMPLE.com:443/article?a=1#section"), "https://example.com/article?a=1");
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://u:p@example.com", "https://localhost", "http://127.0.0.1", "http://127.1", "http://2130706433", "http://[::1]", "http://metadata.google.internal", "https://example.com:8443", "https://example.com/\n", "https://example.com\\@evil.com", "https://example.com/has space"]) {
    assert.throws(() => publicWebUrl(url), undefined, url);
  }
});

test("consent binds human input, exact path/query and workspace without following alternate representations", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-consent-")));
  mkdirSync(join(root, "other"));
  const urls = new UserWebUrls();
  const url = "https://www.reddit.com/r/ollama/comments/123/title/";
  try {
    for (const source of ["extension", "tool", "unknown"]) {
      urls.remember(url, source, root);
      assert.equal(urls.includes(url, root), false);
    }
    urls.remember(url, "interactive", root, true);
    assert.equal(urls.includes(url, root), false);
    urls.remember(`[post](${url}) fait le`, "interactive", root);
    assert.equal(urls.includes(url, root), true);
    assert.equal(urls.includes(url + "#heading", root), true, "fragments are not sent over HTTP");
    for (const changed of [url + ".json", url + "?upload=secret", url.replace("www.", "old."), "http://www.reddit.com/r/ollama/comments/123/title/"]) {
      assert.equal(urls.includes(changed, root), false, changed);
    }
    assert.equal(urls.includes(url, join(root, "other")), false);
    urls.clear(); assert.equal(urls.includes(url, root), false);
    urls.remember(`<${url}>`, "rpc", root); assert.equal(urls.includes(url, root), true);
    urls.remember("https://example.com/new", "interactive", join(root, "other"));
    assert.equal(urls.includes(url, root), false, "workspace replacement clears previous grants");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("URL punctuation, repeated links and input limits never grant a different destination", () => {
  const cwd = process.cwd();
  for (const url of ["https://example.com/report?title=l'article", "https://example.com/name)", "https://example.com/name]", "https://example.com/name(part)"]) {
    for (const input of [url, `[post](${url})`, `'${url}'`]) {
      const urls = new UserWebUrls();
      urls.remember(input, "interactive", cwd);
      assert.equal(urls.includes(url, cwd), true, input);
      assert.equal(urls.includes("https://example.com/name", cwd), false);
      assert.equal(urls.includes("https://example.com/report?title=l", cwd), false);
    }
  }
  const urls = new UserWebUrls();
  for (let i = 0; i < 64; i++) urls.remember(`https://example.com/${i}`, "interactive", cwd);
  urls.remember("https://example.com/63", "interactive", cwd);
  assert.equal(urls.includes("https://example.com/0", cwd), true, "a duplicate does not evict another URL");
  urls.remember("https://example.com/64", "interactive", cwd);
  assert.equal(urls.includes("https://example.com/0", cwd), false, "a new URL still respects the 64-entry bound");
  const prefix = " ".repeat(128 * 1024 - "https://example.com/truncated".length);
  urls.remember(prefix + "https://example.com/truncated-suffix", "interactive", cwd);
  assert.equal(urls.includes("https://example.com/truncated", cwd), false);
});

test("web tool rejects an unapproved alternate URL before network execution or a dialog", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-tool-")));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const handlers = new Map(), tools = new Map();
  const ctx = { cwd: root, ui: { confirm() { assert.fail("No redundant approval dialog"); } } };
  try {
    web({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand() {} });
    await handlers.get("session_start")({}, ctx);
    const url = "https://www.reddit.com/r/ollama/comments/123/title/";
    handlers.get("input")({ text: url, source: "interactive" }, ctx);
    await assert.rejects(tools.get("web_fetch").execute("read", { url: url + ".json" }, undefined, undefined, ctx), /WEB_URL_NOT_AUTHORIZED/);
    for (const event of ["session_before_switch", "session_before_tree", "session_before_fork"]) {
      handlers.get("input")({ text: url, source: "interactive" }, ctx);
      await handlers.get(event)({}, ctx);
      await assert.rejects(tools.get("web_fetch").execute("read", { url }, undefined, undefined, ctx), /WEB_URL_NOT_AUTHORIZED/);
    }
    await handlers.get("session_shutdown")();
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
