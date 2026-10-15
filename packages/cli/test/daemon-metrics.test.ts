// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { requestWindowMetrics } from "../src/daemon/metrics-summary.ts";
import { readMetricsHistory, renderDaemonMetrics } from "../src/daemon/metrics.ts";
import { runDaemonControl } from "../src/daemon/control.ts";
import type { ObserveTailResult } from "@harness-anything/daemon/internal/protocol/daemon-protocol-gui-types";

const until = Date.parse("2026-10-03T12:00:00Z");
const list = (stats: ReturnType<typeof requestWindowMetrics>) => {
  const entry = stats.latency.byCommand.find((candidate) => candidate.command === "task-list");
  assert.ok(entry, "task-list latency entry");
  return entry;
};
const row = (durationMs: unknown, overrides = {}) => ({
  schema: "daemon-request-log/v1",
  at: "2026-10-03T11:59:00Z",
  method: "repo.tasks.list",
  command: "task-list",
  durationMs,
  serviceMs: durationMs,
  dispatchDelayMs: 2,
  ...overrides,
});

test("window latency uses every eligible sample and nearest-rank P95, excluding parked awaits", () => {
  const records = Array.from({ length: 20 }, (_, i) => row(i + 1));
  const stats = requestWindowMetrics(
    [
      ...records,
      row(900_000, { method: "repo.agentRuntime.sessions.await" }),
      row(800_000, { method: "repo.task.read", command: "task-ci", wait: true }),
      row(80, { at: "2026-10-03T10:00:00Z" }),
      row(90, { at: "2026-10-03T12:00:01Z" }),
    ],
    until - 3_600_000,
    until,
  );
  assert.equal(stats.requestCount, 22);
  assert.equal(stats.excludedAwaitRequests, 2);
  assert.equal(list(stats).durationMs.sampleCount, 20);
  assert.equal(list(stats).durationMs.p95Ms, 19);
  assert.equal(list(stats).durationMs.p50Ms, 10);
  assert.equal(list(stats).durationMs.maxMs, 20);
  assert.equal(list(stats).durationMs.lowSample, false);
  assert.equal(stats.coverage.leadingUnobservedMs, 3_540_000);
  assert.equal(stats.coverage.continuity, "unknown");
});

test("commands sharing one RPC method keep separate latency; provider-backed task-ci never pools with local reads", () => {
  const stats = requestWindowMetrics(
    [
      ...Array.from({ length: 20 }, (_, i) => row(20 + i, { method: "repo.task.read", command: "task-show" })),
      ...Array.from({ length: 5 }, (_, i) => row(4_000 + i * 1_000, { method: "repo.task.read", command: "task-ci" })),
      row(30, { command: undefined }),
    ],
    until - 3_600_000,
    until,
  );
  const byCommand = new Map(stats.latency.byCommand.map((entry) => [entry.command, entry]));
  assert.deepEqual([...byCommand.keys()], ["task-show", "task-ci", "<no command>"]);
  assert.equal(byCommand.get("task-show")!.method, "repo.task.read");
  assert.equal(byCommand.get("task-show")!.serviceMs.sampleCount, 20);
  assert.equal(byCommand.get("task-show")!.serviceMs.p95Ms, 38);
  assert.equal(byCommand.get("task-show")!.serviceMs.maxMs, 39);
  assert.equal(byCommand.get("task-ci")!.method, "repo.task.read");
  assert.equal(byCommand.get("task-ci")!.serviceMs.p50Ms, 6_000);
  assert.equal(byCommand.get("<no command>")!.serviceMs.sampleCount, 1);
  assert.equal("durationMs" in stats.latency, false, "no method-pooled aggregate remains beside byCommand");
});

test("missing timings are unknown with a separate denominator; zero is a valid sample", () => {
  const stats = requestWindowMetrics(
    [
      row(0, { serviceMs: undefined, dispatchDelayMs: undefined }),
      row(null, { serviceMs: -1, dispatchDelayMs: "2" }),
      row(Number.NaN, { serviceMs: Number.POSITIVE_INFINITY }),
    ],
    until - 3_600_000,
    until,
  );
  assert.equal(stats.requestCount, 3);
  assert.equal(list(stats).durationMs.sampleCount, 1);
  assert.equal(list(stats).durationMs.missingCount, 2);
  assert.equal(list(stats).durationMs.p95Ms, 0);
  assert.equal(list(stats).durationMs.lowSample, true);
  assert.equal(list(stats).serviceMs.p95Ms, null);
  assert.equal(list(stats).dispatchDelayMs.sampleCount, 1);
  const empty = requestWindowMetrics([], until - 3_600_000, until);
  assert.equal(empty.coverage.firstObservedAt, null);
  assert.deepEqual(empty.latency.byCommand, []);
});

test("rotation timestamps and silent intervals describe observed coverage without proving retention", () => {
  const stats = requestWindowMetrics(
    [
      row(1, { at: "2026-10-03T08:00:00Z" }),
      row(2, { at: "2026-10-03T11:00:00Z" }),
      row(3, { schema: "other/v1" }),
      row(4, { at: "invalid" }),
    ],
    until - 86_400_000,
    until,
  );
  assert.equal(stats.requestCount, 2);
  assert.equal(stats.coverage.observedSpanMs, 10_800_000);
  assert.deepEqual(stats.coverage.silentIntervals, [
    {
      from: "2026-10-03T08:00:00.000Z",
      to: "2026-10-03T11:00:00.000Z",
      durationMs: 10_800_000,
    },
  ]);
});

const page = (overrides = {}): ObserveTailResult => ({
  schema: "daemon.observe-tail/v3",
  ok: true,
  repoId: "metrics",
  mode: "local",
  kind: "repo-log",
  direction: "history",
  status: "ready",
  items: [],
  historyCursor: null,
  liveCursor: null,
  sourceCursor: null,
  done: true,
  ...overrides,
});

test("history terminates on done even with a cursor; each retained page counts once", async () => {
  const cursor = { kind: "repo-log" as const, fileId: "retained", offset: 64 };
  let calls = 0;
  const result = await readMetricsHistory(async (requested) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(requested, undefined);
      return page({ items: [row(2)], historyCursor: cursor, done: false });
    }
    assert.deepEqual(requested, cursor);
    return page({ items: [row(1)], historyCursor: { ...cursor, offset: 0 } });
  });
  assert.equal(calls, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.history.retainedHistoryExhausted, true);
});

test("history gap, unavailable source and stalled cursor do not produce successful metrics", async () => {
  for (const rejected of [
    page({ status: "gap", done: false, gap: { reason: "cursor-file-not-retained", requestedFileId: "old" } }),
    page({
      status: "unavailable",
      done: false,
      unavailable: { reason: "center-request-log-not-wired", centerRevision: null },
    }),
    page({ done: false }),
  ])
    await assert.rejects(
      readMetricsHistory(async () => rejected),
      { code: "service_rejected" },
    );
});

test("native control rejects unsupported and missing window arguments before daemon contact", async () => {
  for (const args of [["--window"], ["--window", "bogus"], ["--unknown"], ["extra"]]) {
    let receipt: Record<string, unknown> = {};
    assert.equal(
      await runDaemonControl(["daemon", "metrics", ...args, "--json"], (value) => {
        receipt = value;
      }),
      1,
    );
    assert.equal(receipt.code, "invalid_field");
  }
});

test("text metrics exposes the window, unknown coverage, latency denominator and low sample", () => {
  const text = renderDaemonMetrics({
    schema: "daemon-request-metrics/v1",
    ok: true,
    command: "daemon-metrics",
    repoId: "fixture",
    window: "1h",
    source: "repo-log",
    history: { pages: 1, retainedHistoryExhausted: true, sourceCursor: null },
    ...requestWindowMetrics([row(0)], until - 3_600_000, until),
  });
  assert.match(text, /fixture 1h/);
  assert.match(text, /task-list \(repo\.tasks\.list\)/);
  assert.match(text, /continuity=unknown/);
  assert.match(text, /n=1, missing=0, P50=0ms, P95=0ms/);
  assert.match(text, /low sample/);
  assert.match(text, /not CLI end-to-end/);
});
