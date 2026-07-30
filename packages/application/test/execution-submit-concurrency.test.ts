// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionSagaService,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeTaskHolderService,
  taskHolderActor,
  type ExecutionRecord
} from "../src/index.ts";
import {
  writeContentAddressedBlobWithDisposition,
  writeSessionEntity,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const primarySessionId = "codex-submit-race-primary";
const principal = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);

test("concurrent submitters from one active snapshot admit one distinct submission without lost update", async () => {
  const { results, submissions, stored, indexBody, restartedPublication } = await runConcurrentSubmissions("alpha", "beta");

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === "rejected").length, 1, JSON.stringify(results));
  const winner = results.findIndex((result) => result.status === "fulfilled");
  assert.equal(stored.submission?.completion_claim, submissions[winner]!.completionClaim);
  assert.match(indexBody, /^  status: in_review$/mu);
  assert.equal(restartedPublication, "committed");
});

test("concurrent byte-identical submissions are idempotent after the winning CAS publication", async () => {
  const { results, submissions, stored, restartedPublication } = await runConcurrentSubmissions("same", "same");

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2, JSON.stringify(results));
  assert.equal(stored.submission?.completion_claim, submissions[0]!.completionClaim);
  assert.equal(restartedPublication, "committed");
});

async function runConcurrentSubmissions(left: string, right: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-submit-race-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-submit-race`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "active"), "utf8");
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const initialCoordinator = makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "initial")
    });
    const initialSaga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: makeCoordinatedExecutionAuthoredStore({
        rootInput: rootDir,
        coordinator: initialCoordinator,
        artifactStore: makeMarkdownArtifactStore({ rootDir })
      }),
      generateExecutionId: () => executionId,
      now: () => "2026-07-30T00:00:00.000Z"
    });
    await initialSaga.claim({
      taskId,
      principal,
      primarySession: {
        runtime: "codex",
        sessionId: primarySessionId,
        source: "runtime",
        detectedAt: "2026-07-30T00:00:00.000Z"
      }
    });
    writeFinalizedSession(rootDir, initialCoordinator);

    const bothReadyToPublish = barrier(2);
    const saga = (executor: string) => {
      const journaled = makeJournaledWriteCoordinator({
        rootDir,
        attribution: writeAttribution("alice", executor)
      });
      const coordinator: WriteCoordinator = {
        ...journaled,
        enqueue: (op) => op.kind === "doc_write"
          ? Effect.promise(() => bothReadyToPublish()).pipe(Effect.flatMap(() => journaled.enqueue(op)))
          : journaled.enqueue(op)
      };
      return makeExecutionSagaService({
        taskHolderService: makeTaskHolderService({ rootInput: rootDir }),
        authoredStore: makeCoordinatedExecutionAuthoredStore({
          rootInput: rootDir,
          coordinator,
          artifactStore: makeMarkdownArtifactStore({ rootDir })
        }),
        now: () => "2026-07-30T00:01:00.000Z"
      });
    };
    const submissions = [submission(left), submission(right)];
    const results = await Promise.allSettled([
      saga("submit-alpha").submitForReview({ taskId, executionId, principal, submission: submissions[0]! }),
      saga("submit-beta").submitForReview({ taskId, executionId, principal, submission: submissions[1]! })
    ]);

    const stored = JSON.parse(readFileSync(
      path.join(taskRoot, "executions", `${executionId}.md`),
      "utf8"
    )) as ExecutionRecord;
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const restartedStore = makeCoordinatedExecutionAuthoredStore({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({
        rootDir,
        attribution: writeAttribution("alice", "restart-query")
      }),
      artifactStore: makeMarkdownArtifactStore({ rootDir })
    });
    const restartedPublication = await restartedStore.submitPublicationState({
      taskId,
      executionId,
      submittedAt: "2026-07-30T00:01:00.000Z",
      submission: submissions[winner]!
    });
    return {
      results,
      submissions,
      stored,
      indexBody: readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"),
      restartedPublication
    };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function submission(label: string) {
  return {
    completionClaim: `submission ${label}`,
    deliverables: [label],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    evidence: []
  };
}

function writeFinalizedSession(rootDir: string, coordinator: WriteCoordinator): void {
  const bodyRef = writeContentAddressedBlobWithDisposition(
    rootDir,
    "# finalized concurrent submit session\n",
    "text/markdown; charset=utf-8"
  );
  Effect.runSync(writeSessionEntity(coordinator, rootDir, {
    schema: "session-entity/v1",
    sessionId: primarySessionId,
    lifecycle: "sealed",
    archiveStatus: "complete",
    runtime: "codex",
    source: "runtime",
    detectedAt: "2026-07-30T00:00:00.000Z",
    exportedAt: "2026-07-30T00:00:01.000Z",
    bodyRef: { store: "authored-cas/v1", ...bodyRef },
    snapshot: {
      capturedAt: "2026-07-30T00:00:01.000Z",
      completeness: "complete",
      captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "test", passed: true, findings: [] }
    }
  }));
}

function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    waiting += 1;
    if (waiting === count) release();
    await ready;
  };
}
