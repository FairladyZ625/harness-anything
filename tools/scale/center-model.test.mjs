// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTrafficModel, replaySchedule, summarizeRequests } from "./center-model.mjs";
import { runCenterBenchmark, markdownReport, defaultTrafficModel } from "./center-bench.mjs";
import { syntheticParams } from "./center-replay.mjs";
import { validateDaemonRpcCall } from "../../packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts";
import { measureCenter } from "./center-campaign.mjs";
import { daemonHelloParams } from "../../packages/daemon/src/client/daemon-hello.ts";

const log = (at, method, command = method, conn = "1") => ({
  schema: "daemon-conn-log/v1",
  event: "request",
  at: new Date(at).toISOString(),
  method,
  command,
  conn,
  pid: 123,
  repoId: "private-repo",
  actor: "private-actor",
});

test("traffic extraction preserves request composition, sorted arrival offsets and connection identity without private fields", () => {
  const model = extractTrafficModel([
    log(1100, "repo.tasks.list", "task-list"),
    log(1000, "protocol.hello"),
    log(1200, "repo.task.run", "fact-record"),
    { schema: "daemon-conn-log/v1", event: "conn_open" },
    log(2000, "observe.tail", "observe.tail", "2"),
  ]);
  assert.deepEqual(model.methods, { "protocol.hello": 1, "repo.tasks.list": 1, "repo.task.run": 1, "observe.tail": 1 });
  assert.equal(model.classes.write, 1);
  assert.equal(model.classes.read, 2);
  assert.deepEqual(model.arrivalIntervalsMs, [100, 100, 800]);
  assert.deepEqual(
    model.requests.map((row) => row.offsetMs),
    [0, 100, 200, 1000],
  );
  assert.equal(model.connections, 2);
  assert.doesNotMatch(JSON.stringify(model), /private-repo|private-actor|"pid"|"conn"/u);
});

test("one-times replay keeps every method and arrival interval, while N nodes multiply the same trace", () => {
  const model = extractTrafficModel([log(1000, "repo.tasks.list"), log(1100, "repo.task.run", "fact-record")]);
  const one = [...replaySchedule(model, { nodes: 1 })];
  assert.deepEqual(
    one.map(({ offsetMs }) => offsetMs),
    [0, 100],
  );
  assert.deepEqual(
    one.map(({ method }) => method),
    ["repo.tasks.list", "repo.task.run"],
  );
  const many = [...replaySchedule(model, { nodes: 1000 })];
  assert.equal(many.length, 2000);
  assert.equal(new Set(many.map(({ node }) => node)).size, 1000);
  assert.equal(many.filter(({ command }) => command === "fact-record").length, 1000);
  assert.throws(() => extractTrafficModel([log(0, "not-a-method")]), /unclassified/u);
});

test("write classification includes arbiter commands and typed duplicate method declarations", () => {
  const model = extractTrafficModel([
    log(1000, "repo.agentRuntime.spawn", "agent-run"),
    log(1001, "repo.task.run", "task-review-execution"),
  ]);
  assert.equal(model.classes.write, 2);
  assert.equal(model.classes.control, 0);
});

test("calibration bindings satisfy the real RPC validator, including session selectors", () => {
  const fixture = {
    repoId: "center-bench",
    ledger: {
      sampleTasks: ["task_bench"],
      sampleRuntimeSessions: ["runtime_bench"],
      sampleDocuments: [{ path: "context/center-bench/doc-0.json" }],
    },
  };
  assert.deepEqual(
    syntheticParams({ method: "protocol.hello" }, fixture),
    daemonHelloParams({ reportStaleBuild: true }),
    "replay hello carries the loaded installation's build identity",
  );
  for (const row of defaultTrafficModel().requests)
    assert.deepEqual(
      validateDaemonRpcCall({ method: row.method, params: syntheticParams(row, fixture) }),
      [],
      row.method,
    );
});

test("reports distinguish failed requests and generator lag from successful read/write latency", () => {
  const result = summarizeRequests(
    [
      { kind: "read", ok: true, serviceMs: 10, latencyMs: 15, scheduledMs: 0, startedMs: 5, endedMs: 15 },
      { kind: "write", ok: true, serviceMs: 20, latencyMs: 25, scheduledMs: 0, startedMs: 5, endedMs: 25 },
      { kind: "read", ok: false, code: "daemon_closed", latencyMs: 100, scheduledMs: 10, startedMs: 15, endedMs: 110 },
      { kind: "read", ok: false, code: "daemon_closed", latencyMs: 100, scheduledMs: 20, startedMs: 25, endedMs: 120 },
    ],
    200,
  );
  assert.ok(Math.abs(result.read.p99Ms - 15) < 0.02, "HDR percentile has three significant figures");
  assert.ok(Math.abs(result.write.p50Ms - 25) < 0.03);
  assert.equal(result.errorRate, 0.5);
  assert.equal(result.failureExposureMs, 110);
  assert.ok(Math.abs(result.generatorLag.p99Ms - 5) < 0.01);
  assert.equal(result.successfulRequestsPerSecond, 10);
});

test("setup rejection leaves a machine report with unmeasured capacity instead of losing the run", async () => {
  const report = await runCenterBenchmark({ nodes: [1], scale: 0 });
  assert.match(report.setupError.message, /scale/u);
  assert.equal(report.ledger, null);
  assert.equal(report.attachMs, null);
  assert.deepEqual(report.capacity, []);
  assert.deepEqual(report.faults, []);
  assert.match(markdownReport(report), /not measured because setup did not complete/u);
  const unknown = await runCenterBenchmark({ nodes: [1], scenarios: ["unknown-fault"] });
  assert.match(unknown.setupError.message, /unknown fault scenario/u);
  assert.equal(unknown.ledger, null);
});

test("failed measurement controls and faults retain independent diagnostics and unavailable probes", async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-center-failed-control-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = {
    endpoint: path.join(scratch, "missing.sock"),
    repoId: "center-bench",
    request: async () => {
      throw Object.assign(new Error("closed IPC"), { code: "ERR_IPC_CHANNEL_CLOSED" });
    },
    diagnostics: async () => ({ heartbeatAgeMs: 7, state: "running" }),
  };
  let called = false;
  const control = await measureCenter(
    fixture,
    async () => {
      called = true;
    },
    { captureError: true },
  );
  assert.equal(called, false);
  assert.equal(control.error.code, "ERR_IPC_CHANNEL_CLOSED");
  assert.ok(control.productDiagnostics.length >= 2);
  assert.equal(control.productDiagnostics[0].heartbeatAgeMs, 7);
  assert.ok(control.probes.some((row) => !row.ok));
  assert.ok(Number.isFinite(control.unavailableMs));
  fixture.request = async () => ({ cpuPercent: 1, rssBytes: 123 });
  const fault = await measureCenter(
    fixture,
    async () => {
      throw Object.assign(new Error("fault injection failed"), { code: "injected_fault" });
    },
    { captureError: true },
  );
  assert.equal(fault.error.code, "injected_fault");
  assert.ok(fault.daemonSamples.length > 0);
  assert.ok(fault.productDiagnostics.length >= 2);
});

// Projection bytes must be comparable to canonical document.value_json, not content + event bytes.
test("projected row accounting counts JSON escaping and replaces rewritten rows", async () => {
  const { projectedBodyBytes, projectedRowBytes, documentShapeTracker } = await import("./center-shape.mjs");
  const body = '漢字😀"\\\n\t\u0000';
  const claim = {
    path: "context/test.json",
    sha256: "a".repeat(64),
    size: Buffer.byteLength(body),
    mediaType: "application/json",
    policyId: "opaque-textual/v1",
  };
  const actual = Buffer.byteLength(
    JSON.stringify({
      path: claim.path,
      blobSha256: claim.sha256,
      body,
      size: claim.size,
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: 9,
    }),
  );
  assert.equal(projectedRowBytes(claim, 9, projectedBodyBytes(body)), actual);
  const tracker = documentShapeTracker();
  for (const revision of [8, 9])
    tracker.accept({
      event: {
        type: "documents_written",
        workspaceRevision: revision,
        payload: { changes: [{ path: claim.path, candidate: claim, policyId: claim.policyId }] },
      },
      blobs: revision === 8 ? [{ ...claim, body }] : [],
    });
  assert.equal(tracker.bytes, actual);
});
