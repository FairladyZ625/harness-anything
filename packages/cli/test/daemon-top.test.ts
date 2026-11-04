// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonTopOptions, parseInterval, renderDaemonTop, topReceipt } from "../src/daemon/top.ts";

test("daemon top accepts millisecond and second intervals and rejects zero or junk", () => {
  assert.equal(parseInterval("1s"), 1_000);
  assert.equal(parseInterval("500ms"), 500);
  assert.equal(parseInterval("250"), 250);
  assert.throws(() => parseInterval("0"), /Invalid --interval/u);
  assert.throws(() => parseInterval("soon"), /Invalid --interval/u);
  const options = parseDaemonTopOptions(["daemon", "top", "--once", "--interval", "2s", "--json"], "/tmp/u", "d");
  assert.deepEqual(
    { intervalMs: options.intervalMs, once: options.once, json: options.json, daemonId: options.daemonId },
    { intervalMs: 2_000, once: true, json: true, daemonId: "d" },
  );
});

test("daemon top renders per-second rate, method percentiles, queues, nodes and in-flight work", () => {
  const text = renderDaemonTop({
    daemonId: "default",
    state: "running",
    stalled: false,
    heartbeatAgeMs: 12,
    inFlight: [
      {
        method: "repo.task.run",
        repoId: "repo-a",
        phase: "write-queue",
        elapsedMs: 2_500,
        traceId: "abc",
      },
    ],
    trace: {
      requestsPerSecond: { last1s: 4, last5s: 3.2, last60s: 1.5 },
      completed: 90,
      droppedCompletions: 2,
      errors: 2,
      inFlight: 1,
      byMethod: [{ method: "repo.task.run", count: 10, p50Ms: 8, p99Ms: 400, maxMs: 900, errors: 1 }],
      byNode: [{ nodeId: "node-7", requests: 8 }],
      writeQueues: [{ repoId: "repo-a", queueDepth: 3, ageMs: 800 }],
      slowest: [{ method: "repo.task.run", durationMs: 900, at: "2026-11-04T01:00:00Z", ok: false, nodeId: "node-7" }],
      slowThresholdMs: 500,
    },
  });
  assert.match(text, /rps 1s=4 5s=3\.2 60s=1\.5 completed=90 errors=2/u);
  assert.match(text, /repo\.task\.run 10 8 400 900 1/u);
  assert.match(text, /trace samples dropped=2; rates and percentiles are incomplete/u);
  assert.match(text, /repo-a 3 800/u);
  assert.match(text, /node-7 8/u);
  assert.match(text, /repo\.task\.run 900ms/u);
  assert.match(text, /write-queue 2500 abc/u);
});

test("the machine receipt names daemon-top even when the diagnostics snapshot says daemon-status", () => {
  const receipt = topReceipt(
    { command: "daemon-status", ok: true, daemonId: "default" },
    { intervalMs: 1_000, once: true, json: true, userRoot: "/tmp/u", daemonId: "default" },
  );
  assert.equal(receipt.schema, "daemon-top/v1");
  assert.equal(receipt.command, "daemon-top");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.daemonId, "default");
});

test("daemon top reports an old build's trace as unavailable instead of inventing numbers", () => {
  const text = renderDaemonTop({ daemonId: "old", state: "running", heartbeatAgeMs: 3, inFlight: [] });
  assert.match(text, /trace: unavailable/u);
  assert.doesNotMatch(text, /rps/u);
});
