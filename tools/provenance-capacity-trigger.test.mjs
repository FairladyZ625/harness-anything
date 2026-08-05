// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProvenanceCapacityReport,
  summarizeRequestEntries
} from "./provenance-capacity-trigger.mjs";

test("historical production dry-run is explicitly labeled and uses its request performance duration", () => {
  const entries = [
    telemetryEntry(1, "compile-task-witness", 100, { stage: "document-produce", state: "start" }),
    telemetryEntry(2, "authority-publication-proof", 200, { stage: "history-start", pathCount: 20 }),
    telemetryEntry(3, "authority-publication-proof", 2_600, { stage: "history-done", pathCount: 20 }),
    telemetryEntry(4, "authority-publication-proof", 3_000, { stage: "history-start", pathCount: 1 }),
    telemetryEntry(5, "authority-publication-proof", 3_800, { stage: "history-done", pathCount: 1 }),
    telemetryEntry(6, "authority-publication-proof", 4_000, { stage: "history-start", pathCount: 20 }),
    telemetryEntry(7, "authority-publication-proof", 6_000, { stage: "history-done", pathCount: 20 }),
    telemetryEntry(8, "authority-publication-proof", 7_000, { stage: "history-start", pathCount: 1 }),
    telemetryEntry(9, "authority-publication-proof", 7_700, { stage: "history-done", pathCount: 1 }),
    performanceEntry(10, 14_560.21)
  ];

  const report = summarizeRequestEntries(entries, {
    requestId: "writer:dry",
    repoId: "canonical",
    includeDryRun: true,
    writerDeadlineMs: 30_000
  });
  assert.equal(report.status, "ok");
  assert.equal(report.source, "production-dry-run");
  assert.equal(report.proofHistoryMs, 5_900);
  assert.equal(report.writerTerminalMs, 14_560.21);
  assert.equal(report.headroomMs, 15_439.79);
  assert.deepEqual(report.historyPathCounts, [20, 1, 20, 1]);
});

test("real completion report uses child-terminal-response and crosses the relative alarm", () => {
  const entries = [
    telemetryEntry(1, "compile-task-witness", 100, { stage: "document-produce", state: "start" }, "writer:real"),
    telemetryEntry(2, "authority-publication-proof", 200, { stage: "history-start", pathCount: 1 }, "writer:real"),
    telemetryEntry(3, "authority-publication-proof", 1_000, { stage: "history-done", pathCount: 1 }, "writer:real"),
    telemetryEntry(4, "authority-publication-proof", 1_100, { stage: "history-start", pathCount: 1 }, "writer:real"),
    telemetryEntry(5, "authority-publication-proof", 1_200, { stage: "history-done", pathCount: 1 }, "writer:real"),
    telemetryEntry(6, "authority-publication-proof", 1_300, { stage: "history-start", pathCount: 1 }, "writer:real"),
    telemetryEntry(7, "authority-publication-proof", 1_400, { stage: "history-done", pathCount: 1 }, "writer:real"),
    telemetryEntry(8, "authority-publication-proof", 1_500, { stage: "history-start", pathCount: 1 }, "writer:real"),
    telemetryEntry(9, "authority-publication-proof", 1_600, { stage: "history-done", pathCount: 1 }, "writer:real"),
    telemetryEntry(10, "authority-event-published", 16_000, undefined, "writer:real"),
    telemetryEntry(11, "child-execution-returned", 16_927, undefined, "writer:real"),
    telemetryEntry(12, "child-terminal-response", 27_058, undefined, "writer:real"),
    performanceEntry(13, 27_059)
  ];
  const report = summarizeRequestEntries(entries, {
    requestId: "writer:real",
    repoId: "canonical",
    writerDeadlineMs: 30_000
  });

  assert.equal(report.status, "alert");
  assert.equal(report.source, "production-task-complete");
  assert.equal(report.writerExecutionMs, 16_927);
  assert.equal(report.writerTerminalMs, 27_058);
  assert.equal(report.headroomRatio, 0.0981);
});

test("text report exposes both commit-count vocabularies and the temporal measurement anchor", () => {
  const output = formatProvenanceCapacityReport({
    schema: "provenance-capacity-report/v1",
    status: "ok",
    source: "production-dry-run",
    requestId: "writer:1",
    proofObservedAt: "2026-08-05T19:08:27.347Z",
    ledgerHeadNow: "a".repeat(40),
    firstParentCommitCountNow: 16_270,
    totalCommitCountNow: 25_280,
    proofHistoryMs: 5_986.157,
    historyScanCount: 4,
    historyPathCounts: [20, 1, 20, 1],
    writerExecutionMs: 14_560.21,
    writerTerminalMs: 14_560.21,
    writerDeadlineMs: 30_000,
    headroomMs: 15_439.79,
    headroomRatio: 0.5147,
    alertThresholdRatio: 0.3333
  });

  assert.match(output, /firstParentCommitsNow=16270/u);
  assert.match(output, /totalCommitsNow=25280/u);
  assert.match(output, /proofHistoryMs=5986\.157/u);
  assert.match(output, /headroomMs=15439\.79/u);
});

function telemetryEntry(sequence, phase, elapsedMs, details, requestId = "writer:dry") {
  return {
    schema: "daemon-log-entry/v1",
    timestamp: new Date(Date.UTC(2026, 7, 5, 19, 8, sequence)).toISOString(),
    sequence,
    repoId: "canonical",
    requestId,
    event: "repo-write.request.telemetry",
    message: JSON.stringify({
      schema: "repo-write-request-telemetry/v1",
      requestId,
      phase,
      elapsedMs,
      ...(details ? { details } : {})
    })
  };
}

function performanceEntry(sequence, writerMs) {
  return {
    schema: "daemon-log-entry/v1",
    timestamp: new Date(Date.UTC(2026, 7, 5, 19, 9, sequence)).toISOString(),
    sequence,
    repoId: "canonical",
    event: "request.performance",
    message: JSON.stringify({
      schema: "daemon-request-performance/v1",
      method: "repo.command.run",
      phasesMs: { "repo-write-child": writerMs }
    })
  };
}
