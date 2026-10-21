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
