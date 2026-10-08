// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import {
  ciDetailMeasurement,
  sha256Bytes,
  type CiRunDetail,
  type CiRunObservationEventV4,
} from "@harness-anything/kernel";
import sample from "../../kernel/fixtures/canonical-events/ci-run-observation-v4/job.json" with { type: "json" };
import { readCiObservatory, validateCiObservatoryRead } from "../src/ci-observatory-read.ts";

const detail: CiRunDetail = {
  schema: "ci-run-detail/v1",
  tests: [{ ...sample.payload.failedTests[0]!, error: { message: "full failure", stack: "fixture full stack" } }],
  fileOutcomes: sample.payload.fileOutcomes,
  diagnostics: [{ reason: "watchdog fixture" }],
};
const bytes = new TextEncoder().encode(JSON.stringify(detail));
const event = {
  ...sample,
  ...{
    payload: {
      ...sample.payload,
      ...ciDetailMeasurement(detail),
      detailRef: {
        ...sample.payload.detailRef,
        sha256: sha256Bytes(bytes),
        decodedBytes: bytes.length,
        encodedBytes: bytes.length,
      },
    },
  },
} as CiRunObservationEventV4;
const schedule = {
  scheduleId: "builtin-ci-observe",
  spec: { target: { kind: "builtin", builtinId: "ci-observe" } },
  status: {
    activeRun: { occurrenceId: "occurrence-fixture", nodeId: "center", claimFence: "fence-fixture" },
    lastRun: {
      occurrenceId: "old",
      nodeId: "center",
      claimFence: "old-fence",
      outcome: "failed",
      detail: "claim_fence_expired",
    },
    ciObserve: {
      workflow: "rewrite-ci",
      workflowIndex: 0,
      scanPass: 1,
      nextPage: 2,
      nextRunId: null,
      nextAttempt: 1,
      lastCompletedScanAt: null,
      retryAt: null,
      error: "HTTP 401",
      pending: [{ runId: 123, attempt: 1, workflow: "rewrite-ci" }],
      unavailable: [],
    },
  },
};
const projection = {
  readCiRunObservations: () => ({ status: "ready", events: [event], watermark: 42, sourceRevision: 42 }),
  listEntities: () => [{ value: schedule }],
} as never;

test("shared observatory preserves hot evidence, event identity and center importer at one cut", () => {
  const result = readCiObservatory({ rootDir: "unused", projection });
  assert.equal(result.runs[0]!.eventId, event.eventId);
  assert.deepEqual(result.runs[0]!.identity, event.payload.identity);
  assert.deepEqual(result.runs[0]!.failedTests, event.payload.failedTests);
  assert.deepEqual(result.runs[0]!.fileOutcomes, event.payload.fileOutcomes);
  assert.equal(result.runs[0]!.detailAvailability, "not_cached");
  assert.equal(result.runs[0]!.detail, null);
  assert.equal(result.importer!.activeRun!.claimFence, "fence-fixture");
  assert.equal(result.importer!.lastRun!.detail, "claim_fence_expired");
  assert.equal(result.importer!.progress!.error, "HTTP 401");
  assert.equal(result.statisticsAvailability, "pending");
  assert.equal(result.tests.length, 0);
  assert.equal(result.sourceRevision, 42);
  assert.deepEqual(validateCiObservatoryRead(result), []);
});

test("cached details stay out of hot response until explicitly requested", () => {
  const input = { rootDir: "unused", projection, readContentBlob: () => bytes };
  const hot = readCiObservatory(input);
  assert.equal(hot.runs[0]!.detailAvailability, "ready");
  assert.equal(hot.runs[0]!.detail, null);
  const cold = readCiObservatory({ ...input, includeDetails: true });
  assert.deepEqual(cold.runs[0]!.detail, detail);
  assert.equal(cold.sourceRevision, hot.sourceRevision);
  assert.equal(validateCiObservatoryRead({ ...cold, importer: { activeRun: "invalid" } }).length, 1);
  assert.equal(
    validateCiObservatoryRead({ ...cold, runs: [{ ...cold.runs[0], detailAvailability: "pretend-ready" }] }).length,
    1,
  );
});

test("workflow without test artifact preserves verdict independently; cancelled is not a failed test run", () => {
  for (const [conclusion, pass] of [
    ["success", true],
    ["failure", false],
    ["cancelled", null],
    ["skipped", null],
  ] as const) {
    const workflow = {
      ...event,
      payload: {
        ...event.payload,
        scope: "workflow",
        testSummary: null,
        failedTests: [],
        fileOutcomes: [],
        detailRef: null,
        measurementCoverage: {
          status: "no-test-artifact",
          missingReason: "no-test-artifact",
          startedFileCount: null,
          completedFileCount: null,
        },
        verification: { conclusion },
        identity: { ...event.payload.identity, jobExecutionId: null, jobKey: null },
      },
    };
    const result = readCiObservatory({
      rootDir: "unused",
      projection: {
        listEntities: () => [],
        readCiRunObservations: () => ({ status: "ready", events: [workflow], watermark: 42, sourceRevision: 42 }),
      } as never,
    });
    assert.equal(result.runs[0]!.pass, pass);
    assert.equal(result.runs[0]!.testCount, null);
    assert.equal(result.runs[0]!.detailAvailability, "unavailable");
    assert.deepEqual(result.runs[0]!.failedTests, []);
  }
});
