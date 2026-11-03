// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { extractTrafficModel, replaySchedule, summarizeRequests } from "./center-model.mjs";

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
