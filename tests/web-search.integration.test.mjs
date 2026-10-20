import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfined } from "../lib/confined.ts";

test("web_search sends only its query to Grob and never executes a project Claude binary", { timeout: 15000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-search-grob-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const marker = join(root, "outside"); writeFileSync(marker, "unchanged");
  writeFileSync(join(cwd, "claude"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');\n`, { mode: 0o700 });
  for (const [key, value] of Object.entries({ PATH: cwd, PI_CODING_AGENT_DIR: agent, CLAUDE_CODE_OAUTH_TOKEN: "private-fixture" })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let count = 0, denied = false;
  const server = createServer(async (req, res) => {
    count++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, "/v1/messages"); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-api-key"], "grob"); assert.equal(body.model, "websearch-model");
    assert.doesNotMatch(JSON.stringify(body), /private-fixture/);
    if (denied) return res.writeHead(403).end("private server diagnostic");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: [{ type: "text", text: "Fixture https://example.com" }] }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const previous = process.env.GROB_URL; process.env.GROB_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env.GROB_URL; else process.env.GROB_URL = previous; });
  assert.match(await runConfined(cwd, "search", { query: "fixture" }), /https:\/\/example.com/);
  denied = true;
  await assert.rejects(runConfined(cwd, "search", { query: "fixture denial" }), /HTTP 403/);
  assert.equal(count, 2); assert.equal(readFileSync(marker, "utf8"), "unchanged");
});
