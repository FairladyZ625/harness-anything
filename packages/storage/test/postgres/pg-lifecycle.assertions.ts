import assert from "node:assert/strict";
import type { TaskProjection } from "@harness-anything/kernel";
import { closeoutReadiness } from "@harness-anything/kernel/internal/domain/closeout-readiness.ts";
import { taskBoardPlacement } from "@harness-anything/kernel/internal/domain/task-board-projection.ts";
import { compileCompletionGateWitness } from "@harness-anything/kernel/internal/domain/completion-gate-publication.ts";
import { completionEvidenceBasis } from "@harness-anything/kernel/internal/domain/completion-evidence.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import type { PgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { event } from "../store/task-event-store.fixtures.ts";

export async function appendGatedLifecycleFixture(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
  source: PgTaskProjectionSource,
): Promise<void> {
  const gated = lifecycleFixture({
    taskId: "task-gated-parity",
    executionId: "execution-gated-parity",
    complete: false,
    gates: [
      {
        gateId: "signoff",
        appliesTo: "code",
        witness: {
          kind: "manual",
          adapterId: "manual-attest",
          adapterOptions: {},
          predicateType: "human/v1",
          resultSchema: { type: "object" },
        },
      },
    ],
  });
  for (const value of gated.events) {
    const current = {
      ...value,
      eventId: `pg-gated-${value.eventId}`,
      opId: `pg-gated-${value.opId}`,
      workspaceRevision: revision(),
    };
    await append({ event: current, plan: taskLifecycleWritePlan(current), blobs: [] });
  }
  const gatedSnapshot = (await source.readSnapshot("task-gated-parity"))!,
    gatedExecution = gatedSnapshot.executions[0]!;
  await append(
    compileCompletionGateWitness({
      snapshot: gatedSnapshot,
      taskId: gatedSnapshot.task!.taskId,
      executionId: gatedExecution.executionId,
      gateId: "signoff",
      result: "pass",
      receiptId: "pg-signoff",
      checkerId: "manual-attest",
      commitSha: gatedExecution.submission!.commitSha,
      iteration: gatedExecution.iteration,
      reviewGate: true,
      actor: event.actor,
      source: "local",
      opId: "pg-signoff",
      eventId: "pg-signoff",
      workspaceRevision: revision(),
      occurredAt: "2026-08-11T00:05:00.000Z",
      packagePath: null,
      currentDocuments: [],
      evidence: {
        schema: "completion-evidence/v1",
        checkerId: "manual-attest",
        gateId: "signoff",
        result: "pass",
        observed: true,
        basis: completionEvidenceBasis(gatedExecution),
        subjects: [],
        predicateType: "human/v1",
        predicate: {},
        diagnostic: "canonical signoff parity",
        provenance: { source: "human", adapterId: "manual-attest", runId: "pg-signoff", rawResult: "pass" },
      },
    }),
  );
}

export async function assertLifecycleParity(
  source: PgTaskProjectionSource,
  sqlite: TaskProjection,
  taskId: string,
): Promise<void> {
  const snapshot = await source.readSnapshot(taskId),
    oracle = sqlite.read(taskId).snapshot;
  assert.ok(snapshot);
  assert.deepEqual(snapshot, oracle);
  assert.deepEqual(snapshot.gateWitnesses, oracle.gateWitnesses);
  assert.deepEqual(snapshot.reviews, oracle.reviews);
  assert.deepEqual(snapshot.consents, oracle.consents);
  assert.deepEqual(closeoutReadiness(snapshot), closeoutReadiness(oracle));
  const boardInput = (value: typeof snapshot) => ({
    snapshot: value,
    blockingState: "clear" as const,
    packageDisposition: value.task?.packageDisposition ?? "active",
    origin: "native" as const,
    closeoutReadiness: closeoutReadiness(value).readiness,
  });
  assert.deepEqual(taskBoardPlacement(boardInput(snapshot)), taskBoardPlacement(boardInput(oracle)));
}
