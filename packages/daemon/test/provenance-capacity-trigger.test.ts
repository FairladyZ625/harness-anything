// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyProvenanceCapacitySample,
  createProvenanceCapacityTelemetryTrigger,
  readProvenanceLedgerScale
} from "../src/observability/provenance-capacity-trigger.ts";
import { provenanceCapacityLogDisposition } from "../src/observability/provenance-capacity-log.ts";
import type { RepoWriteTelemetryFrame } from "../src/runtime/repo-write-protocol.ts";

test("real task-complete traffic reports history cost and terminal writer headroom", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger({ writerDeadlineMs: 30_000 });
  const frames = [
    telemetry("compile-task-witness", 100, { stage: "document-produce", state: "start" }),
    telemetry("authority-publication-proof", 200, { stage: "history-start", pathCount: 20 }),
    telemetry("authority-publication-proof", 2_600, { stage: "history-done", pathCount: 20 }),
    telemetry("authority-publication-proof", 4_000, { stage: "history-start", pathCount: 1 }),
    telemetry("authority-publication-proof", 4_800, { stage: "history-done", pathCount: 1 }),
    telemetry("authority-publication-proof", 5_000, { stage: "history-start", pathCount: 20 }),
    telemetry("authority-publication-proof", 7_000, { stage: "history-done", pathCount: 20 }),
    telemetry("authority-publication-proof", 8_000, { stage: "history-start", pathCount: 1 }),
    telemetry("authority-publication-proof", 8_700, { stage: "history-done", pathCount: 1 }),
    telemetry("authority-event-published", 16_000),
    telemetry("child-execution-returned", 16_927),
    telemetry("child-terminal-response", 27_058)
  ];

  const signals = frames.map((frame) => trigger.observe(frame)).filter((signal) => signal !== null);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], {
    schema: "provenance-capacity-signal/v1",
    requestId: "writer:1",
    status: "alert",
    source: "production-task-complete",
    sampleClass: "warm",
    proofHistoryMs: 5_900,
    historyScanCount: 4,
    historyPathCounts: [20, 1, 20, 1],
    writerExecutionMs: 16_927,
    writerTerminalMs: 27_058,
    writerDeadlineMs: 30_000,
    headroomMs: 2_942,
    headroomRatio: 0.0981,
    alertThresholdRatio: 0.3333
  });
});

test("the first request on a writer connection is informational even when its cold start crosses the threshold", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger({ writerDeadlineMs: 30_000 });
  const frame = (
    phase: RepoWriteTelemetryFrame["phase"],
    elapsedMs: number,
    details?: RepoWriteTelemetryFrame["details"]
  ) => telemetry(phase, elapsedMs, details, "582:1", 582);
  trigger.observe(frame("compile-task-witness", 10, {
    stage: "document-produce", state: "start"
  }));
  for (let index = 0; index < 4; index += 1) {
    trigger.observe(frame("authority-publication-proof", 100 + index * 100, {
      stage: "history-start", pathCount: index % 2 === 0 ? 19 : 1
    }));
    trigger.observe(frame("authority-publication-proof", 150 + index * 100, {
      stage: "history-done", pathCount: index % 2 === 0 ? 19 : 1
    }));
  }
  trigger.observe(frame("authority-event-published", 16_000));
  trigger.observe(frame("child-execution-returned", 16_927));

  const signal = trigger.observe(frame("child-terminal-response", 27_058));
  assert.equal(signal?.status, "cold-start");
  assert.equal(signal?.sampleClass, "cold-start");
  assert.equal(signal?.headroomRatio, 0.0981);
});

test("writer connection sequence classifies the observed production sample ids", () => {
  assert.equal(classifyProvenanceCapacitySample("582:1", 582), "cold-start");
  assert.equal(classifyProvenanceCapacitySample("582:67", 582), "warm");
  assert.equal(classifyProvenanceCapacitySample("582:92", 582), "warm");
  assert.equal(classifyProvenanceCapacitySample("582:103", 582), "warm");
  assert.equal(classifyProvenanceCapacitySample("582:1", 583), "warm");
});

test("cold-start capacity samples stay informational instead of emitting an alert", () => {
  assert.deepEqual(provenanceCapacityLogDisposition("cold-start"), {
    level: "info",
    event: "provenance.capacity.cold-start"
  });
  assert.deepEqual(provenanceCapacityLogDisposition("alert"), {
    level: "warn",
    event: "provenance.capacity.alert"
  });
});

test("execution timing alone does not hide a terminal flush that crosses the relative threshold", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger({ writerDeadlineMs: 30_000 });
  assert.equal(trigger.observe(telemetry("compile-task-witness", 10, {
    stage: "document-produce", state: "start"
  })), null);
  observeHistoryPairs(trigger, 20);
  assert.equal(trigger.observe(telemetry("authority-event-published", 15_000)), null);
  assert.equal(trigger.observe(telemetry("child-execution-returned", 15_500)), null);

  const signal = trigger.observe(telemetry("child-terminal-response", 20_000));
  assert.equal(signal?.status, "alert");
  assert.equal(signal?.writerExecutionMs, 15_500);
  assert.equal(signal?.writerTerminalMs, 20_000);
  assert.equal(signal?.headroomRatio, 0.3333);
});

test("dry-runs and unrelated writes do not masquerade as real-traffic capacity observations", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger();
  trigger.observe(telemetry("compile-task-witness", 10, {
    stage: "document-produce", state: "start"
  }));
  trigger.observe(telemetry("authority-publication-proof", 20, {
    stage: "history-start", pathCount: 1
  }));
  trigger.observe(telemetry("authority-publication-proof", 40, {
    stage: "history-done", pathCount: 1
  }));
  assert.equal(trigger.observe(telemetry("child-terminal-response", 25_000)), null);

  const unrelated = createProvenanceCapacityTelemetryTrigger();
  assert.equal(unrelated.observe(telemetry("authority-event-published", 21_000)), null);
  assert.equal(unrelated.observe(telemetry("child-terminal-response", 25_000)), null);
});

test("incomplete history telemetry is visible as measurement failure", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger();
  trigger.observe(telemetry("compile-task-witness", 10, {
    stage: "document-produce", state: "start"
  }));
  trigger.observe(telemetry("authority-publication-proof", 20, {
    stage: "history-start", pathCount: 2
  }));
  trigger.observe(telemetry("authority-publication-proof", 40, {
    stage: "history-done", pathCount: 1
  }));
  trigger.observe(telemetry("authority-event-published", 100));
  const signal = trigger.observe(telemetry("child-terminal-response", 1_000));

  assert.equal(signal?.status, "measurement-failed");
  assert.equal(signal?.proofHistoryMs, null);
});

test("fewer than four valid history pairs cannot report a healthy measurement", () => {
  const trigger = createProvenanceCapacityTelemetryTrigger();
  trigger.observe(telemetry("compile-task-witness", 10, {
    stage: "document-produce", state: "start"
  }));
  trigger.observe(telemetry("authority-publication-proof", 20, {
    stage: "history-start", pathCount: 1
  }));
  trigger.observe(telemetry("authority-publication-proof", 40, {
    stage: "history-done", pathCount: 1
  }));
  trigger.observe(telemetry("authority-event-published", 100));

  assert.equal(trigger.observe(telemetry("child-terminal-response", 1_000))?.status, "measurement-failed");
});

test("ledger scale reports first-parent and total commit counts from real Git objects", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provenance-capacity-"));
  try {
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Harness Test");
    git(root, "config", "user.email", "harness@example.invalid");
    writeFileSync(path.join(root, "one.txt"), "one\n", "utf8");
    git(root, "add", "one.txt");
    git(root, "commit", "--quiet", "-m", "one");
    writeFileSync(path.join(root, "two.txt"), "two\n", "utf8");
    git(root, "add", "two.txt");
    git(root, "commit", "--quiet", "-m", "two");

    const scale = await readProvenanceLedgerScale(root);
    assert.match(scale.ledgerHead, /^[a-f0-9]{40}$/u);
    assert.equal(scale.firstParentCommitCount, 2);
    assert.equal(scale.totalCommitCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function telemetry(
  phase: RepoWriteTelemetryFrame["phase"],
  elapsedMs: number,
  details?: RepoWriteTelemetryFrame["details"],
  requestId = "writer:1",
  generation = 1
): RepoWriteTelemetryFrame {
  return {
    protocol: "harness-repo-write-ipc/v1",
    repoId: "canonical",
    generation,
    kind: "telemetry",
    requestId,
    phase,
    elapsedMs,
    ...(details ? { details } : {})
  };
}

function observeHistoryPairs(
  trigger: ReturnType<typeof createProvenanceCapacityTelemetryTrigger>,
  startElapsedMs: number
): void {
  for (let index = 0; index < 4; index += 1) {
    const start = startElapsedMs + index * 100;
    assert.equal(trigger.observe(telemetry("authority-publication-proof", start, {
      stage: "history-start", pathCount: index % 2 === 0 ? 20 : 1
    })), null);
    assert.equal(trigger.observe(telemetry("authority-publication-proof", start + 50, {
      stage: "history-done", pathCount: index % 2 === 0 ? 20 : 1
    })), null);
  }
}

function git(root: string, ...args: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
