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

test("one chunk carrying many complete frames whose total exceeds the cap parses every frame", () => {
  const reader = createJsonLineFrameReader();
  // The cap bounds an unterminated line, not a batch: a peer that coalesces many small frames into one
  // write must not be disconnected for it.
  const line = encodeJsonLineFrame({ ...request, params: { body: "z".repeat(256 * 1024) } }),
    count = Math.ceil(JSON_LINE_FRAME_MAX_BYTES / Buffer.byteLength(line)) + 2,
    chunk = line.repeat(count);
  assert.ok(Buffer.byteLength(chunk) > JSON_LINE_FRAME_MAX_BYTES, "fixture must exceed the cap in aggregate");
  const batch = reader.push(chunk);
  assert.equal(batch.error, undefined);
  assert.equal(batch.frames.length, count);
  // Complete frames followed by an over-cap unterminated tail: the frames are lost only with the tail.
  const tail = reader.push(`${line}${"x".repeat(JSON_LINE_FRAME_MAX_BYTES + 1)}`);
  assert.ok(tail.error, "an over-cap unterminated remainder must still surface an error");
  assert.deepEqual(reader.push(`${JSON.stringify(request)}\n`).frames, [request]);
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
