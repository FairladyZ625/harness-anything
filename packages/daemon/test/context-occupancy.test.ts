// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDispatchContextOccupancy, occupancyOfStreamRecord } from "../src/context-occupancy.ts";
import { dispatchStreamPath } from "../src/dispatch-stream.ts";

const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa";

function streamRoot(lines: readonly string[]): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-context-occupancy-"));
  mkdirSync(path.dirname(dispatchStreamPath(rootDir, dispatchId)), { recursive: true });
  writeFileSync(
    dispatchStreamPath(rootDir, dispatchId),
    `${[
      JSON.stringify({
        schema: "runtime-dispatch-stream/v1",
        kind: "dispatch",
        dispatchId,
        taskId: "task-a",
        executionId: "execution-a",
        runtimeSessionId: "runtime_a",
        instanceId: "instance-a",
        startedAt: "2026-10-21T00:00:00.000Z",
        eventStreamRef: `dispatch-stream/${dispatchId}`,
      }),
      ...lines,
    ].join("\n")}\n`,
    "utf8",
  );
  return rootDir;
}

const acpUsage = (used: number, size: number): string =>
  JSON.stringify({
    schema: "runtime-dispatch-stream/v1",
    kind: "provider_event",
    occurredAt: "2026-10-21T00:01:00.000Z",
    event: {
      sessionId: "provider-session",
      type: "acp.update",
      update: { sessionUpdate: "usage_update", used, size },
      usage: { used, context_size: size },
    },
  });

/** Non-usage provider output of exactly `bytes` so a stream can be padded to a chosen size. */
function filler(occurredAt: string, bytes: number): string {
  const base = JSON.stringify({
    schema: "runtime-dispatch-stream/v1",
    kind: "provider_event",
    occurredAt,
    event: { type: "assistant", text: "" },
  });
  return base.replace('"text":""', `"text":"${"x".repeat(bytes - Buffer.byteLength(base))}"`);
}

/** Stream whose newest usage frame straddles the 64 KiB chunk edge the backward probe reads.
 * Older genuine frames sit before it, which is what a buggy scan falls back to. */
function straddlingStream(newest: string, older: readonly string[]): string {
  const chunkBytes = 64 * 1024,
    before = [filler("2026-10-21T00:02:00.000Z", 3_000), ...older];
  // Pad until EOF - 64 KiB lands 20 bytes inside the newest frame, so its tail opens the chunk.
  for (let pads = 0; pads < 4_000; pads += 1) {
    const lines = [...before, newest, ...Array.from({ length: pads }, () => filler("2026-10-21T00:03:00.000Z", 200))],
      head = Buffer.byteLength([...before].join("\n") + "\n"),
      edge = Buffer.byteLength(lines.join("\n") + "\n") - chunkBytes;
    if (edge > head + 20 && edge < head + Buffer.byteLength(newest) - 20) return streamRoot(lines);
  }
  throw new Error("could not place the chunk edge inside the newest frame");
}

test("ACP usage_update frames report the fill the provider measured, not a cumulative total", () => {
  const rootDir = streamRoot([acpUsage(9_603, 1_000_000), acpUsage(243_138, 1_000_000)]);
  try {
    // Latest frame wins: the session's fill fell or rose with its own reported numbers.
    assert.deepEqual(readDispatchContextOccupancy(rootDir, dispatchId), {
      usedTokens: 243_138,
      windowTokens: 1_000_000,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a stream whose provider reports no window yields no occupancy instead of a default", () => {
  const rootDir = streamRoot([
    JSON.stringify({
      schema: "runtime-dispatch-stream/v1",
      kind: "provider_event",
      occurredAt: "2026-10-21T00:01:00.000Z",
      event: { type: "assistant", message: { usage: { input_tokens: 1_200, output_tokens: 30 } } },
    }),
  ]);
  try {
    assert.equal(readDispatchContextOccupancy(rootDir, dispatchId), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a window that is missing, zero or negative never becomes a denominator", () => {
  assert.equal(occupancyOfStreamRecord({ raw: { used: 12 } }), null);
  assert.equal(occupancyOfStreamRecord({ raw: { used: 12, context_size: 0 } }), null);
  assert.equal(occupancyOfStreamRecord({ raw: { used: 12, context_size: -1 } }), null);
  assert.equal(occupancyOfStreamRecord({ raw: { used: -1, context_size: 1_000 } }), null);
});

test("codex and zcode result projections report their own window", () => {
  assert.deepEqual(
    occupancyOfStreamRecord({
      raw: { projection: { status: "idle", turnCount: 1, contextUsed: 298_492, contextWindow: 200_000 } },
    }),
    { usedTokens: 298_492, windowTokens: 200_000 },
  );
});

test("the settled runtime_metrics record carries occupancy through its raw usage", () => {
  assert.deepEqual(
    occupancyOfStreamRecord({
      kind: "runtime_metrics",
      raw: { used: 516_976, context_size: 1_000_000, input: 40_100, output: 8_200 },
    }),
    { usedTokens: 516_976, windowTokens: 1_000_000 },
  );
});

test("a torn or foreign line never fabricates a reading", () => {
  // A record cut mid-write (the writer died between bytes) sits ahead of a valid frame.
  const rootDir = streamRoot(['{"kind":"provider_event","event":{"type":"acp.upda', acpUsage(5_000, 200_000)]);
  try {
    const occupancy = readDispatchContextOccupancy(rootDir, dispatchId);
    assert.deepEqual(occupancy, { usedTokens: 5_000, windowTokens: 200_000 });
    assert.equal(readDispatchContextOccupancy(rootDir, "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb"), null);
    assert.equal(readDispatchContextOccupancy(rootDir, "dispatch-not-an-id"), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the newest usage frame wins when it straddles a backward-probe chunk edge", () => {
  // The reader walks the tail in 64 KiB chunks. The newest frame started in an older chunk, so
  // its tail opens this chunk: reading that tail as a line (or skipping it) falls back to the
  // older frame and reports stale fill.
  const rootDir = straddlingStream(acpUsage(243_138, 1_000_000), [acpUsage(1_000, 1_000_000)]);
  try {
    assert.deepEqual(readDispatchContextOccupancy(rootDir, dispatchId), {
      usedTokens: 243_138,
      windowTokens: 1_000_000,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
