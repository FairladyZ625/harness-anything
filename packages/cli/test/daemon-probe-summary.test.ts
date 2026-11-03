// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeSilentSegments,
  deriveAvailability,
  readDaemonLogHistory,
  summarizeDurations,
  type LifecycleHistory,
} from "../src/daemon/probe/probe-log-history.ts";
import { parseSummaryArgs } from "../src/daemon/probe/probe-options.ts";
import { renderProbeSummary, runProbeSummary, summarizeProbeTimeline } from "../src/daemon/probe/probe-summary.ts";
import { createTimelineWriter } from "../src/daemon/probe/probe-timeline.ts";

const HOUR = 3_600_000;

function lifecycle(
  starts: readonly { readonly at: number; readonly pid: number }[],
  exits: readonly { readonly at: number; readonly pid: number }[],
): LifecycleHistory {
  const exitsByPid = new Map<number, number[]>();
  for (const exit of exits) exitsByPid.set(exit.pid, [...(exitsByPid.get(exit.pid) ?? []), exit.at]);
  return {
    files: 1,
    records: starts.length + exits.length,
    starts,
    exitsByPid,
    attachDurationsMs: [],
    attachFailed: 0,
    attachTimedOut: 0,
  };
}

test("availability derivation dates a missing exit by the pid's last conn activity", () => {
  const evidence = deriveAvailability(
    lifecycle(
      [
        { at: 0, pid: 1 },
        { at: 12 * 60_000, pid: 2 },
        { at: HOUR, pid: 3 },
      ],
      [{ at: 10 * 60_000, pid: 1 }],
    ),
    {
      files: 1,
      records: 4,
      requests: 4,
      firstAt: 0,
      lastAt: HOUR + 1,
      lastActivityByPid: new Map([
        [1, 5 * 60_000],
        [2, 30 * 60_000],
        [3, HOUR + 1],
      ]),
      activityMinutes: new Uint8Array(1),
    },
    { sinceMs: 0, untilMs: 2 * HOUR, currentPid: null, currentPidAlive: false },
  );
  assert.equal(evidence.starts, 3);
  assert.deepEqual(evidence.startsPerDay, { "1970-01-01": 3 });
  assert.equal(evidence.downtimeMs, 2 * 60_000 + 30 * 60_000);
  assert.deepEqual(
    evidence.downtime.map((segment) => segment.cause),
    ["exited", "unrecorded-stop"],
  );
  assert.equal(evidence.downtime[1]!.fromMs, 30 * 60_000);
  assert.equal(evidence.unobservedFromMs, HOUR + 1);
});

test("a live current pid covers the window end and is not unobserved", () => {
  const evidence = deriveAvailability(
    lifecycle([{ at: 0, pid: 7 }], []),
    {
      files: 0,
      records: 0,
      requests: 0,
      firstAt: null,
      lastAt: null,
      lastActivityByPid: new Map(),
      activityMinutes: new Uint8Array(1),
    },
    { sinceMs: 0, untilMs: HOUR, currentPid: 7, currentPidAlive: true },
  );
  assert.equal(evidence.unobservedFromMs, null);
  assert.equal(evidence.downtimeMs, 0);
});

test("silent segments are bounded by observed minutes and ranked by duration", () => {
  const activity = new Uint8Array(12);
  for (const minute of [0, 1, 4, 8, 9, 11]) activity[minute] = 1;
  const segments = computeSilentSegments(activity, 0, 2 * 60_000);
  assert.deepEqual(
    segments.map((segment) => [segment.fromMs / 60_000, segment.toMs / 60_000, segment.durationMs / 60_000]),
    [
      [5, 8, 3],
      [2, 4, 2],
    ],
  );
  assert.deepEqual(computeSilentSegments(new Uint8Array(5), 0, 60_000), []);
});

test("duration summaries use nearest-rank percentiles and keep max", () => {
  assert.deepEqual(summarizeDurations([]), { count: 0, p50Ms: null, p95Ms: null, maxMs: null });
  assert.deepEqual(summarizeDurations([100, 200, 300, 400]), {
    count: 4,
    p50Ms: 300,
    p95Ms: 400,
    maxMs: 400,
  });
});

test("log history streams both conn generations and derives starts, attach, and downtime", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-probe-logs-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const logDir = path.join(userRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const lifecycleLines = [
    record("process_start", "2026-11-03T00:00:00.000Z", 100),
    record("process_exit", "2026-11-03T00:10:00.000Z", 100),
    record("process_start", "2026-11-03T00:12:00.000Z", 200),
    record("process_start", "2026-11-03T01:00:00.000Z", 300),
    record("repo_attach_completed", "2026-11-03T00:01:00.000Z", 100, { durationMs: 1_000 }),
    record("repo_attach_completed", "2026-11-03T00:02:00.000Z", 100, { durationMs: 3_000 }),
    record("repo_attach_completed", "2026-11-03T01:02:00.000Z", 300, { durationMs: 2_000 }),
    record("repo_attach_failed", "2026-11-03T01:03:00.000Z", 300),
    record("repo_attach_timed_out", "2026-11-03T01:04:00.000Z", 300, { durationMs: 60_000 }),
  ];
  writeFileSync(path.join(logDir, "daemon-default-lifecycle.jsonl"), lifecycleLines.join("\n") + "\n");
  const connBase = [
    connRecord("2026-11-03T00:30:00.000Z", 200),
    connRecord("2026-11-03T01:01:00.000Z", 300),
    connRecord("2026-11-03T01:02:00.000Z", 300),
  ];
  const connOld = [connRecord("2026-11-03T00:05:00.000Z", 100), connRecord("2026-11-03T00:20:00.000Z", 200)];
  writeFileSync(path.join(logDir, "daemon-default-conn-20261103.jsonl"), connBase.join("\n") + "\n");
  writeFileSync(path.join(logDir, "daemon-default-conn-20261103.jsonl.1"), connOld.join("\n") + "\n");
  const sinceMs = Date.parse("2026-11-03T00:00:00.000Z"),
    untilMs = Date.parse("2026-11-03T02:00:00.000Z"),
    history = await readDaemonLogHistory({
      userRoot,
      daemonId: "default",
      sinceMs,
      untilMs,
      minSilenceMs: 300_000,
      currentPid: null,
      currentPidAlive: false,
    });
  assert.equal(history.conn.files, 2);
  assert.equal(history.conn.records, 5);
  assert.equal(history.conn.requests, 5);
  assert.equal(history.evidence.starts, 3);
  assert.deepEqual(history.evidence.attach, { count: 3, p50Ms: 2_000, p95Ms: 3_000, maxMs: 3_000 });
  assert.equal(history.evidence.attachFailed, 1);
  assert.equal(history.evidence.attachTimedOut, 1);
  assert.deepEqual(
    history.evidence.downtime.map((segment) => [segment.cause, segment.durationMs]),
    [
      ["exited", 2 * 60_000],
      ["unrecorded-stop", 30 * 60_000],
    ],
  );
  assert.equal(history.evidence.unobservedFromMs, Date.parse("2026-11-03T01:02:00.000Z"));
  assert.equal(history.silent[0]!.durationMs, 30 * 60_000);
});

test("timeline summary separates slow and down segments", () => {
  const summary = summarizeProbeTimeline(
    [
      { at: 0, state: "up", latencyMs: 10 },
      { at: 5_000, state: "up", latencyMs: 12 },
      { at: 10_000, state: "slow", latencyMs: 2_000 },
      { at: 15_000, state: "down", latencyMs: 100 },
      { at: 20_000, state: "down", latencyMs: 100 },
      { at: 25_000, state: "up", latencyMs: 11 },
    ],
    [{ atMs: 15_000, reason: "unresponsive", files: ["scene.txt"] }],
    0,
    30_000,
  );
  assert.equal(summary.status, "observed");
  assert.equal(summary.samples, 6);
  assert.equal(summary.availabilityPercent, 66.67);
  assert.equal(summary.healthyPercent, 50);
  assert.deepEqual(
    summary.slowSegments.map((segment) => segment.durationMs),
    [5_000],
  );
  assert.deepEqual(
    summary.downSegments.map((segment) => segment.durationMs),
    [10_000],
  );
  assert.equal(summary.captures.length, 1);
});

test("summary reports unobserved rather than zero availability without samples", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-probe-empty-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  mkdirSync(path.join(userRoot, "logs"), { recursive: true });
  const options = parseSummaryArgs(["daemon", "probe", "summary", "--day", "19700101"]);
  assert.equal(options.ok, true);
  if (!options.ok) return;
  const result = await runProbeSummary({ options: options.value, userRoot, daemonId: "default" });
  assert.equal(result.probe.status, "unobserved");
  assert.equal(result.probe.availabilityPercent, null);
  const text = renderProbeSummary(result);
  assert.match(text, /unobserved \(no samples in window; availability is unknown, not 0%\)/u);
  assert.match(text, /logs: starts=0/u);
});

test("summary renders observed availability, captures, and the offline log view", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-probe-summary-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const logDir = path.join(userRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const start = Date.parse("2026-11-03T00:00:00.000Z");
  writeFileSync(
    path.join(logDir, "daemon-default-lifecycle.jsonl"),
    [
      record("process_start", "2026-11-03T00:00:00.000Z", 100),
      record("process_exit", "2026-11-03T00:10:00.000Z", 100),
      record("process_start", "2026-11-03T00:12:00.000Z", 200),
      record("repo_attach_completed", "2026-11-03T00:13:00.000Z", 200, { durationMs: 4_000 }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    path.join(logDir, "daemon-default-conn-20261103.jsonl"),
    [connRecord("2026-11-03T00:13:00.000Z", 200), connRecord("2026-11-03T00:40:00.000Z", 200)].join("\n") + "\n",
  );
  const writer = createTimelineWriter({ dir: logDir, daemonId: "default", keptDays: 7, now: () => new Date(start) });
  await writer.append({ kind: "sample", at: "2026-11-03T00:00:00.000Z", state: "up", latencyMs: 10 });
  await writer.append({ kind: "sample", at: "2026-11-03T00:05:00.000Z", state: "down", latencyMs: 2_000 });
  await writer.append({
    kind: "capture",
    at: "2026-11-03T00:05:00.000Z",
    reason: "unresponsive",
    files: ["/tmp/scene.sample.txt"],
  });
  await writer.append({ kind: "sample", at: "2026-11-03T00:10:00.000Z", state: "up", latencyMs: 12 });
  await writer.close();
  const options = parseSummaryArgs(["daemon", "probe", "summary", "--day", "20261103"]);
  assert.equal(options.ok, true);
  if (!options.ok) return;
  const result = await runProbeSummary({ options: options.value, userRoot, daemonId: "default" });
  assert.equal(result.probe.status, "observed");
  assert.equal(result.probe.samples, 3);
  assert.equal(result.probe.down, 1);
  assert.equal(result.probe.captures.length, 1);
  assert.equal(result.logs.evidence.starts, 2);
  assert.equal(result.logs.evidence.downtime.length, 1);
  const text = renderProbeSummary(result);
  assert.match(text, /availability=66\.67%/u);
  assert.match(text, /captures=1/u);
  assert.match(text, /cause=exited/u);
  assert.match(text, /scene\.sample\.txt/u);
});

function record(event: string, at: string, pid: number, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ schema: "daemon-lifecycle/v1", daemonId: "default", at, pid, event, ...extra });
}

function connRecord(at: string, pid: number): string {
  return JSON.stringify({ schema: "daemon-conn-log/v1", daemonId: "default", at, pid, event: "request" });
}
