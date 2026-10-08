import { readFileSync } from "node:fs";
import { ciDetailMeasurement, sha256Bytes } from "@harness-anything/kernel";
import { readCiObservatory } from "../../../packages/daemon/src/ci-observatory-read.ts";

// Deterministic presentation data from the production read service, not UI-derived verdicts.
// Actual center/two-edge transport and independent cache publication are tested in ci-rerun-fleet.
export function ciPresentationSource() {
  const sample = JSON.parse(
    readFileSync(
      new URL("../../../packages/kernel/fixtures/canonical-events/ci-run-observation-v4/job.json", import.meta.url),
      "utf8",
    ),
  );
  const blobs = new Map();
  const events = [];
  for (const [index, [runId, attempt, status]] of [
    [202, 1, "failed"],
    [101, 1, "failed"],
    [101, 2, "passed"],
  ].entries()) {
    const detail = {
      schema: "ci-run-detail/v1",
      tests: [
        {
          ...sample.payload.failedTests[0],
          testKey: "fixture-test",
          name: "CI diagnostic fixture",
          file: "fixture.test.ts",
          suite: ["fixture"],
          status,
          failureSummary: status === "failed" ? "Expected result to equal 42" : undefined,
          failureLocation: status === "failed" ? { file: "fixture.test.ts", line: 27, column: 5 } : null,
          error:
            status === "failed"
              ? {
                  message: "Expected result to equal 42",
                  stack: "Full assertion stack at fixture.test.ts:27:5",
                  cause: { message: "Fixture cause" },
                }
              : undefined,
        },
      ],
      fileOutcomes:
        runId === 202
          ? [
              {
                file: "timeout.test.ts",
                outcome: "timeout",
                elapsedMs: 810000,
                limitMs: 810000,
                lastActiveTest: "watchdog fixture",
                reason: "watchdog deadline",
                stallSummary: "last active file exceeded deadline",
              },
            ]
          : [],
      diagnostics: runId === 202 ? [{ message: "watchdog diagnostic" }] : [],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(detail)),
      sha256 = sha256Bytes(bytes);
    blobs.set(sha256, bytes);
    events.push({
      ...sample,
      eventId: `event-presentation-${runId}-${attempt}`,
      workspaceRevision: index + 1,
      opId: `op-presentation-${runId}-${attempt}`,
      payload: {
        ...sample.payload,
        ...ciDetailMeasurement(detail),
        identity: {
          ...sample.payload.identity,
          databaseRunId: String(runId),
          runAttempt: attempt,
          jobExecutionId: `${runId}${attempt}`,
          jobKey: "fixture-job",
        },
        run: { ...sample.payload.run, runId: `${runId}.${attempt}`, job: "fixture-job", branch: "main" },
        detailRef: { ...sample.payload.detailRef, sha256, decodedBytes: bytes.length, encodedBytes: bytes.length },
      },
    });
  }
  for (const event of [...events]) {
    const identity = event.payload.identity;
    events.push({
      ...event,
      eventId: `${event.eventId}-inventory`,
      opId: `${event.opId}-inventory`,
      workspaceRevision: events.length + 1,
      payload: {
        ...event.payload,
        scope: "attempt",
        identity: { ...identity, jobExecutionId: null, jobKey: null },
        verification: null,
        testSummary: null,
        failedTests: [],
        fileOutcomes: [],
        shardDurations: [],
        detailRef: null,
        measurementCoverage: {
          status: "no-test-artifact",
          missingReason: "attempt-inventory",
          startedFileCount: null,
          completedFileCount: null,
        },
        attemptInventory: {
          jobs: [{ jobExecutionId: identity.jobExecutionId, name: event.payload.run.job, conclusion: "success" }],
          missingArtifactJobIds: [],
        },
      },
    });
  }
  const importer = {
    scheduleId: "builtin-ci-observe",
    spec: { target: { kind: "builtin", builtinId: "ci-observe" } },
    status: {
      activeRun: {
        occurrenceId: "occurrence-present",
        nodeId: "center",
        claimFence: "fence-present",
        kind: "scheduled",
        scheduledFor: "2026-10-09T00:00:00Z",
        claimedAt: "2026-10-09T00:00:00Z",
        attemptIndex: 1,
      },
      lastRun: {
        occurrenceId: "occurrence-failed",
        nodeId: "center",
        claimFence: "fence-old",
        outcome: "failed",
        detail: "claim_fence_expired",
        scheduledFor: "2026-10-08T00:00:00Z",
        endedAt: "2026-10-08T00:01:00Z",
        attemptIndex: 1,
      },
      ciObserve: {
        workflow: "rewrite-ci",
        workflowIndex: 0,
        scanPass: 2,
        nextPage: 3,
        nextRunId: null,
        nextAttempt: 1,
        pending: [{ runId: 202, attempt: 1, workflow: "rewrite-ci" }],
        unavailable: [{ runId: 99, attempt: 1, reason: "provider-artifact-unavailable" }],
        lastCompletedScanAt: null,
        error: "HTTP 401: provider authentication failed",
        retryAt: null,
      },
    },
  };
  return { events, blobs, importer };
}

export function ciPresentationFixture({ cached = false, includeDetails = false } = {}) {
  const { events, blobs, importer } = ciPresentationSource();
  return readCiObservatory({
    rootDir: "presentation-fixture",
    includeDetails,
    projection: {
      readCiRunObservations: () => ({ status: "ready", events, watermark: 42, sourceRevision: 42 }),
      listEntities: () => [{ value: importer }],
    },
    readContentBlob: cached ? (digest) => blobs.get(digest) ?? null : undefined,
  });
}
