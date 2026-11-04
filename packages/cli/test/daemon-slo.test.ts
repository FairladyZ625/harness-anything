// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, ReadStream, rmSync, writeFileSync } from "node:fs";
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

function fixtureRaw(connLines: readonly string[], probeLines: readonly string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-slo-raw-")),
    dir = path.join(root, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "daemon-test-daemon-conn-20260101.jsonl"), connLines.join("\n") + "\n");
  if (probeLines.length > 0)
    writeFileSync(path.join(dir, "daemon-test-daemon-probe-20260101.jsonl"), probeLines.join("\n") + "\n");
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
      slowLimit: 200,
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
      slowLimit: 200,
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

test("daily p99 comes from a bounded all-day histogram, not the last retained samples", async () => {
  const records = [
    ...Array.from({ length: 10_000 }, () => request({ durationMs: 10_000 })),
    ...Array.from({ length: 20_000 }, () => request({ durationMs: 1 })),
  ];
  const root = fixture(records);
  try {
    const receipt = await runDaemonSlo({
      day: "20260101",
      thresholdMs: 60_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
      slowLimit: 200,
    });
    const requests = receipt.requests as Record<string, unknown>;
    const method = (requests.byMethod as Record<string, unknown>[])[0]!;
    assert.equal(requests.count, 30_000);
    assert.equal(method.maxMs, 10_000);
    assert.ok(Number(method.p99Ms) >= 9_900, JSON.stringify(method));
    assert.equal(method.p99LowerMs, 10_000);
    assert.equal(method.p99Exact, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the over-threshold list reports truncation and honors --slow-limit", async () => {
  const root = fixture([
    request({ durationMs: 1_100 }),
    request({ durationMs: 2_000 }),
    request({ durationMs: 3_000 }),
  ]);
  try {
    const receipt = await runDaemonSlo({
      day: "20260101",
      thresholdMs: 1_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
      slowLimit: 2,
    });
    const over = (receipt.requests as Record<string, unknown>).overThreshold as Record<string, unknown>;
    assert.equal(over.count, 3);
    assert.equal(over.retained, 2);
    assert.equal(over.truncated, true);
    assert.equal((over.requests as Record<string, unknown>[])[0]!.durationMs, 3_000);
    assert.match(renderDaemonSlo(receipt), /showing=2 truncated=true slowLimit=2/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminated corrupt line fails the report with file and line; a trailing partial line is reported", async () => {
  const corrupt = fixtureRaw([
    JSON.stringify(request({ durationMs: 10 })),
    "{not json",
    JSON.stringify(request({ durationMs: 20 })),
  ]);
  try {
    await assert.rejects(
      runDaemonSlo({
        day: "20260101",
        thresholdMs: 1_000,
        userRoot: corrupt,
        daemonId: "test-daemon",
        json: false,
        slowLimit: 200,
      }),
      /daemon-test-daemon-conn-20260101\.jsonl:2/u,
    );
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }
  const root = mkdtempSync(path.join(tmpdir(), "ha-slo-partial-")),
    dir = path.join(root, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "daemon-test-daemon-conn-20260101.jsonl"),
    `${JSON.stringify(request({ durationMs: 10 }))}
{"schema":"daemon-conn-log/v1","event":"request","method":"half`,
  );
  try {
    const receipt = await runDaemonSlo({
      day: "20260101",
      thresholdMs: 1_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
      slowLimit: 200,
    });
    const read = (receipt.requests as Record<string, unknown>).read as Record<string, unknown>;
    assert.deepEqual(read.incompleteLines, [2]);
    assert.equal((receipt.requests as Record<string, unknown>).count, 1);
    assert.match(renderDaemonSlo(receipt), /incompleteLines=1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-ENOENT access error is surfaced instead of being reported as a missing log", async () => {
  const root = fixture([request()]),
    file = path.join(root, "logs", "daemon-test-daemon-conn-20260101.jsonl");
  chmodSync(file, 0o000);
  try {
    await assert.rejects(
      runDaemonSlo({
        day: "20260101",
        thresholdMs: 1_000,
        userRoot: root,
        daemonId: "test-daemon",
        json: false,
        slowLimit: 200,
      }),
      /EACCES|permission denied/iu,
    );
  } finally {
    chmodSync(file, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-chunk SLO logs keep bounded listeners and close on EOF or a corrupt line", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-slo-chunks-")),
    dir = path.join(root, "logs"),
    lines = Array.from({ length: 4_000 }, () => JSON.stringify(request({ detail: "x".repeat(800) })));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "daemon-test-daemon-conn-20260101.jsonl"),
    emit = ReadStream.prototype.emit,
    read = ReadStream.prototype.read;
  let chunks = 0,
    maxListeners = 0,
    closed = Promise.withResolvers<void>();
  const streams = new Set<ReadStream>();
  t.mock.method(ReadStream.prototype, "read", function (this: ReadStream, ...args: unknown[]) {
    const chunk = Reflect.apply(read, this, args);
    if (String(this.path) === file) {
      streams.add(this);
      if (chunk !== null) chunks += 1;
      for (const event of this.eventNames()) maxListeners = Math.max(maxListeners, this.listenerCount(event));
    }
    return chunk;
  });
  t.mock.method(ReadStream.prototype, "emit", function (this: ReadStream, event: string | symbol, ...args: unknown[]) {
    if (String(this.path) === file && event === "close") closed.resolve();
    return Reflect.apply(emit, this, [event, ...args]);
  });
  try {
    const options = {
      day: "20260101",
      thresholdMs: 1_000,
      userRoot: root,
      daemonId: "test-daemon",
      json: false,
      slowLimit: 200,
    };
    writeFileSync(file, `${lines.join("\n")}\n`);
    const receipt = await runDaemonSlo(options);
    await closed.promise;
    assert.equal((receipt.requests as Record<string, unknown>).count, lines.length);
    assert.ok(chunks >= 40, `read ${chunks} chunks`);
    assert.ok(maxListeners <= 2, `max listeners per event: ${maxListeners}`);
    assert.ok([...streams].every((stream) => stream.destroyed && stream.closed));
    chunks = maxListeners = 0;
    closed = Promise.withResolvers<void>();
    writeFileSync(file, `${lines.join("\n")}\n{broken}\n`);
    await assert.rejects(runDaemonSlo(options), /jsonl:4001/u);
    await closed.promise;
    assert.ok(chunks >= 40, `read ${chunks} chunks before corrupt line`);
    assert.ok(maxListeners <= 2, `max listeners per event on error: ${maxListeners}`);
    assert.ok([...streams].every((stream) => stream.destroyed && stream.closed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SLO options default to today's UTC day and validate thresholds", () => {
  const options = parseDaemonSloOptions([], "/tmp/u", "d");
  assert.match(options.day, /^\d{8}$/u);
  assert.equal(options.thresholdMs, 1_000);
  assert.equal(parseDaemonSloOptions(["daemon", "slo", "--threshold", "2s"], "/tmp/u", "d").thresholdMs, 2_000);
  assert.equal(parseDaemonSloOptions(["daemon", "slo", "--slow-limit", "7"], "/tmp/u", "d").slowLimit, 7);
  assert.throws(
    () => parseDaemonSloOptions(["daemon", "slo", "--slow-limit", "0"], "/tmp/u", "d"),
    /Invalid --slow-limit/u,
  );
  assert.throws(() => parseDaemonSloOptions(["daemon", "slo", "--day", "2026-01-01"], "/tmp/u", "d"), /Invalid --day/u);
  assert.deepEqual(dayWindow("20260101", Date.parse("2026-01-01T12:00:00Z")), {
    sinceMs: Date.parse("2026-01-01T00:00:00Z"),
    untilMs: Date.parse("2026-01-01T12:00:00Z"),
  });
});
