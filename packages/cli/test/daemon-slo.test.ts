// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dayWindow, parseDaemonSloOptions, renderDaemonSlo, runDaemonSlo } from "../src/daemon/slo.ts";

function fixture(records: readonly unknown[], probe: readonly unknown[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-slo-")),
    dir = path.join(root, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "daemon-test-daemon-conn-20260101.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  if (probe.length > 0)
    writeFileSync(
      path.join(dir, "daemon-test-daemon-probe-20260101.jsonl"),
      probe.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  return root;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema: "daemon-conn-log/v1",
    event: "request",
    at: "2026-01-01T01:00:00.000Z",
    method: "repo.task.run",
    durationMs: 100,
    dispatchDelayMs: 5,
    serviceMs: 95,
    ok: true,
    code: null,
    requestBytes: 120,
    replyBytes: 240,
    nodeId: "node-7",
    traceId: "a".repeat(32),
    ...overrides,
  };
}

test("daily SLO derives availability only from the probe timeline and reports it unobserved without samples", async () => {
  const root = fixture([request()]);
  try {
    const receipt = await runDaemonSlo({
      day: "20260101",
      thresholdMs: 1_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
    });
    const availability = receipt.availability as Record<string, unknown>;
    assert.equal(availability.source, "daemon-probe/v1");
    assert.equal(availability.status, "unobserved");
    assert.equal(availability.availabilityPercent, null);
    assert.equal((receipt.requests as Record<string, unknown>).count, 1);
    assert.match(renderDaemonSlo(receipt), /availability source=daemon-probe\/v1 status=unobserved/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daily SLO counts per-method p99, errors, bytes and bounded over-threshold requests", async () => {
  const root = fixture(
    [
      request({ method: "repo.task.run", durationMs: 100 }),
      request({ method: "repo.task.run", durationMs: 300 }),
      request({ method: "repo.task.run", durationMs: 3_000, ok: false, code: "timeout" }),
      request({ method: "daemon.status", durationMs: 10, traceId: undefined }),
    ],
    [
      { schema: "daemon-probe/v1", kind: "sample", at: "2026-01-01T00:00:00.000Z", state: "up" },
      { schema: "daemon-probe/v1", kind: "sample", at: "2026-01-01T00:00:05.000Z", state: "down" },
      { schema: "daemon-probe/v1", kind: "sample", at: "2026-01-01T00:00:10.000Z", state: "up" },
      { schema: "daemon-probe/v1", kind: "sample", at: "2026-01-01T00:00:15.000Z", state: "slow" },
    ],
  );
  try {
    const receipt = await runDaemonSlo({
      day: "20260101",
      thresholdMs: 1_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
    });
    const requests = receipt.requests as Record<string, unknown>;
    assert.equal(requests.count, 4);
    assert.equal(requests.errors, 1);
    assert.deepEqual(requests.bytes, { request: 480, reply: 960 });
    assert.deepEqual(requests.traceCoverage, { spans: 3, sampled: 4, percent: 75 });
    const byMethod = requests.byMethod as Record<string, unknown>[];
    assert.deepEqual(
      byMethod.map((row) => [row.method, row.count, row.errors, row.p99Ms]),
      [
        ["repo.task.run", 3, 1, 3_000],
        ["daemon.status", 1, 0, 10],
      ],
    );
    const over = requests.overThreshold as Record<string, unknown>;
    assert.equal(over.count, 1);
    assert.equal((over.requests as Record<string, unknown>[])[0]!.method, "repo.task.run");
    const availability = receipt.availability as Record<string, unknown>;
    assert.equal(availability.status, "observed");
    assert.deepEqual(
      [availability.samples, availability.up, availability.slow, availability.down, availability.availabilityPercent],
      [4, 2, 1, 1, 75],
    );
    assert.equal((availability.downtimeSegments as Record<string, unknown>[])[0]!.durationMs, 5_000);
    assert.match(renderDaemonSlo(receipt), /over threshold >= 1000ms: 1 request/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SLO options default to today's UTC day and validate thresholds", () => {
  const options = parseDaemonSloOptions([], "/tmp/u", "d");
  assert.match(options.day, /^\d{8}$/u);
  assert.equal(options.thresholdMs, 1_000);
  assert.equal(parseDaemonSloOptions(["daemon", "slo", "--threshold", "2s"], "/tmp/u", "d").thresholdMs, 2_000);
  assert.throws(() => parseDaemonSloOptions(["daemon", "slo", "--day", "2026-01-01"], "/tmp/u", "d"), /Invalid --day/u);
  assert.deepEqual(dayWindow("20260101", Date.parse("2026-01-01T12:00:00Z")), {
    sinceMs: Date.parse("2026-01-01T00:00:00Z"),
    untilMs: Date.parse("2026-01-01T12:00:00Z"),
  });
});
