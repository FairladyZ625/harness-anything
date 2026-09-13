// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonLineFrameReader,
  encodeJsonLineFrame,
  JSON_LINE_FRAME_MAX_BYTES,
} from "../src/transport/frame-codec.ts";

const request = { jsonrpc: "2.0" as const, method: "ping", params: {} };

test("an unterminated frame larger than the transport cap fails the read instead of buffering unboundedly", () => {
  const reader = createJsonLineFrameReader();
  const chunk = "x".repeat(64 * 1024);
  let batch = { frames: [] as unknown[], error: undefined as Error | undefined };
  for (let index = 0; index * chunk.length <= JSON_LINE_FRAME_MAX_BYTES; index += 1) batch = reader.push(chunk);

  assert.ok(batch.error, "an over-cap buffer must surface an error, not keep growing");
  assert.match(batch.error.message, /exceeds/u);
  assert.deepEqual(batch.frames, []);
  // The over-cap line is discarded, so a later well-formed frame still parses on the same reader.
  const next = reader.push(`${JSON.stringify(request)}\n`);
  assert.deepEqual(next.frames, [request]);
});

test("a frame just under the cap still parses across many chunks", () => {
  const reader = createJsonLineFrameReader();
  // A cap that rejected legitimate frames would break the largest payload the surface accepts today:
  // the entity content read hands back up to 2 MiB of UTF-8 inside one JSON string.
  const line = JSON.stringify({ ...request, params: { body: "y".repeat(2 * 1024 * 1024) } }),
    whole = `${line}\n`,
    chunkSize = 64 * 1024;
  assert.ok(Buffer.byteLength(whole) < JSON_LINE_FRAME_MAX_BYTES, "fixture must stay under the cap");
  let frames: readonly unknown[] = [];
  for (let offset = 0; offset < whole.length; offset += chunkSize)
    frames = reader.push(whole.slice(offset, offset + chunkSize)).frames;
  assert.equal(frames.length, 1);
});

test("encode frames stay newline-terminated JSON lines", () => {
  const encoded = encodeJsonLineFrame(request);
  assert.ok(encoded.endsWith("\n"));
  assert.deepEqual(JSON.parse(encoded), request);
});
