import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { readRequest } from "../lib/read-request.mjs";

test("request reader waits for delayed chunks and preserves split UTF-8", async () => {
  const expected = { body: "été".repeat(6000) }, bytes = Buffer.from(JSON.stringify(expected));
  const stream = Readable.from((async function* () {
    await delay(20);
    yield bytes.subarray(0, 10); // splits the first multibyte character
    await delay(20);
    yield bytes.subarray(10, 20000);
    await delay(20);
    yield bytes.subarray(20000);
  })());
  assert.deepEqual(await readRequest(stream), expected);
});

test("request reader bounds bytes while streaming and rejects malformed or non-object inputs", async () => {
  const tooLarge = Readable.from([Buffer.alloc(1024 * 1024), Buffer.from("é")]);
  await assert.rejects(readRequest(tooLarge), /exceeds 1 MiB/);
  assert.equal(tooLarge.destroyed, true);
  for (const value of ["{", "null", "[]", '"text"']) {
    await assert.rejects(readRequest(Readable.from([value])), /JSON|request object/);
  }
  const failed = Readable.from((async function* () { yield "{"; throw new Error("transport failed"); })());
  await assert.rejects(readRequest(failed), /transport failed/);
});
