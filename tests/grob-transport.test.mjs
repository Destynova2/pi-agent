import assert from "node:assert/strict";
import { test } from "node:test";
import { grobFetch, grobUrl, grobWebSearch } from "../lib/grob.ts";

test("Grob transport rejects remote origins and embedded credentials", async () => {
  for (const value of ["https://api.anthropic.com", "http://user:secret@localhost", "http://localhost/path", "http://localhost/?token=x"]) assert.throws(() => grobUrl(value));
  await assert.rejects(grobFetch("http://127.0.0.1:13456")("https://api.openai.com/v1/responses"), /non-proxy/);
});

test("web search uses Grob with no provider credential or executable", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async request => {
    calls.push(request);
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("x-api-key"), "grob");
    const body = await request.json();
    assert.equal(body.model, "websearch-model");
    assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
    return Response.json({ content: [{ type: "text", text: "Fixture source: https://example.com" }] });
  });
  assert.match(await grobWebSearch("fixture query"), /https:\/\/example.com/);
  assert.equal(calls.length, 1);
});

test("web search fails without a direct retry on proxy denial or empty output", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("denied", { status: 403 }); });
  await assert.rejects(grobWebSearch("fixture"), /HTTP 403.*no direct-provider fallback/);
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => Response.json({ content: [] }));
  await assert.rejects(grobWebSearch("fixture"), /no search result/);
});
