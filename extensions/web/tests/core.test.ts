import { test } from "node:test";
import assert from "node:assert/strict";
import { curlFetch, webSearch } from "../core.ts";

test("fetch rejects unsupported protocols and credentials before any network request", async () => {
  await assert.rejects(curlFetch("file:///etc/passwd"), /HTTP/);
  await assert.rejects(curlFetch("https://user:password@example.com"), /credentials/);
});

test("legacy search entry routes to Grob without starting Claude or accepting provider errors", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async request => {
    calls++;
    assert.equal(new URL(request.url).hostname, "127.0.0.1");
    assert.equal(request.redirect, "error");
    const body = await request.json();
    assert.deepEqual(body.tools.map(tool => tool.name), ["web_search"]);
    return new Response("api_key=fixture-do-not-print", { status: 401 });
  });
  await assert.rejects(webSearch("fixture"), error => {
    assert.match(error.message, /WEB_SEARCH_GROB_ERROR: HTTP 401/);
    assert.doesNotMatch(error.message, /fixture-do-not-print/);
    return true;
  });
  assert.equal(calls, 1);
});
