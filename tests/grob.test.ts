// Offline: a loopback HTTP stub stands in for Grob; no provider call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { discoverModels, grobModel, isHealthy, TIER_IDS } from "../extensions/grob/index.ts";

async function withStub(models: string[], run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === "/health") return res.writeHead(200).end("ok");
    if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models.map(id => ({ id })) }));
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { server.close(); }
}

test("model metadata follows the id family", () => {
  assert.equal(grobModel("default-model").contextWindow, 128_000);
  assert.deepEqual(grobModel("claude-fable-5-1").input, ["text", "image"]);
  assert.equal(grobModel("claude-haiku-4-5").contextWindow, 200_000);
  assert.equal(grobModel("gpt-6-astra").contextWindow, 272_000);
  assert.equal(grobModel("think-model").cost.output, 0);
});

test("discovery keeps the logical tiers and adds what Grob advertises", async () => {
  await withStub(["default-model", "claude-fable-5-1", "gpt-6-astra"], async (url) => {
    const ids = (await discoverModels(url)).map(m => m.id);
    assert.deepEqual(ids, [...TIER_IDS, "claude-fable-5-1", "gpt-6-astra"]);
    assert.equal(await isHealthy(url), true);
  });
});

test("proxy down: tiers only, health false, no throw", async () => {
  const dead = "http://127.0.0.1:1";
  assert.deepEqual((await discoverModels(dead)).map(m => m.id), TIER_IDS);
  assert.equal(await isHealthy(dead), false);
});
