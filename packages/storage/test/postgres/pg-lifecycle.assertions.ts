import assert from "node:assert/strict";
import type { TaskProjection } from "@harness-anything/kernel";
import type { AgentRuntimeEventV1, DispatchLifecycleEvent } from "@harness-anything/kernel";
import { canonicalEventWritePlan } from "@harness-anything/kernel";
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

export async function appendDispatchLifecycleFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
  repoId: string,
): Promise<void> {
  const actor = event.actor,
    fence = { ownerId: "node-lifecycle", epoch: 7 } as const,
    lifecycle = (
      type: DispatchLifecycleEvent["type"],
      overrides: Record<string, unknown> = {},
    ): DispatchLifecycleEvent =>
      ({
        schema: "dispatch-lifecycle-event/v1",
        source: "center",
        eventId: `storage-lifecycle-${String(overrides.eventId ?? type)}`,
        repoId,
        attemptGroupId: "storage-lifecycle-group",
        dispatchId: "storage-lifecycle-dispatch",
        expectedGroupVersion: 0,
        ownerFence: fence,
        type,
        ...(type === "dispatch_admitted"
          ? {
              instanceId: "storage-lifecycle-instance",
              runtimeSessionId: "storage-lifecycle-session",
              reservationId: "storage-lifecycle-reservation",
              capacityLimit: 2,
            }
          : {}),
        ...overrides,
      }) as DispatchLifecycleEvent,
    appendObservation = async (lifecycleEvent: DispatchLifecycleEvent, eventId: string): Promise<void> => {
      const value: AgentRuntimeEventV1 = {
        schema: "agent-runtime-event/v1",
        eventId,
        workspaceRevision: revision(),
        opId: eventId,
        type: "runtime_dispatch_lifecycle_observed",
        actor,
        source: "local",
        occurredAt: "2026-11-08T00:00:00.000Z",
        payload: {
          runtimeSessionId: lifecycleEvent.runtimeSessionId ?? "storage-lifecycle-session",
          lifecycle: lifecycleEvent,
        },
      };
      await append({ event: value, plan: canonicalEventWritePlan(value, "agent-runtime/v1", eventId), blobs: [] });
    };
  await appendObservation(lifecycle("dispatch_admitted"), "storage-lifecycle-admitted");
  await appendObservation(
    lifecycle("process_started", { eventId: "started", expectedGroupVersion: 1 }),
    "storage-lifecycle-started",
  );
  await appendObservation(
    lifecycle("process_exit", { eventId: "exit", expectedGroupVersion: 2 }),
    "storage-lifecycle-exit",
  );
  await appendObservation(
    lifecycle("process_stop_proven", {
      eventId: "stopped",
      expectedGroupVersion: 3,
      proof: "proven_stopped",
    }),
    "storage-lifecycle-stopped",
  );
  await appendObservation(
    lifecycle("settlement_committed", {
      eventId: "closed",
      expectedGroupVersion: 4,
      outcome: "succeeded",
    }),
    "storage-lifecycle-closed",
  );
  await appendObservation(
    lifecycle("dispatch_admitted", {
      eventId: "active-admitted",
      attemptGroupId: "storage-lifecycle-active-group",
      dispatchId: "storage-lifecycle-active-dispatch",
      runtimeSessionId: "storage-lifecycle-active-session",
      reservationId: "storage-lifecycle-active-reservation",
      instanceId: "storage-lifecycle-active-instance",
    }),
    "storage-lifecycle-active-admitted",
  );
}

export async function assertDispatchLifecycleParity(
  source: PgTaskProjectionSource,
  sqlite: TaskProjection,
): Promise<void> {
  const group = await source.readDispatchLifecycle({ by: "group", attemptGroupId: "storage-lifecycle-group" });
  assert.equal(group.status, "ready");
  assert.deepEqual(group, sqlite.readDispatchLifecycle!({ by: "group", attemptGroupId: "storage-lifecycle-group" }));
  assert.deepEqual(
    await source.readDispatchLifecycle({ by: "dispatch", dispatchIds: ["storage-lifecycle-dispatch"] }),
    sqlite.readDispatchLifecycle!({ by: "dispatch", dispatchIds: ["storage-lifecycle-dispatch"] }),
  );
  assert.deepEqual(
    await source.readDispatchLifecycle({ by: "session", runtimeSessionId: "storage-lifecycle-active-session" }),
    sqlite.readDispatchLifecycle!({ by: "session", runtimeSessionId: "storage-lifecycle-active-session" }),
  );
  const page = await source.readDispatchLifecycle({ by: "active", limit: 1 });
  assert.deepEqual(page, sqlite.readDispatchLifecycle!({ by: "active", limit: 1 }));
  assert.equal(page.rows[0]?.dispatchId, "storage-lifecycle-active-dispatch");
}

export function assertDispatchLifecycleParitySync(source: TaskProjection, sqlite: TaskProjection): void {
  const group = source.readDispatchLifecycle!({ by: "group", attemptGroupId: "storage-lifecycle-group" });
  assert.equal(group.status, "ready");
  assert.deepEqual(group, sqlite.readDispatchLifecycle!({ by: "group", attemptGroupId: "storage-lifecycle-group" }));
  assert.deepEqual(
    source.readDispatchLifecycle!({ by: "dispatch", dispatchIds: ["storage-lifecycle-dispatch"] }),
    sqlite.readDispatchLifecycle!({ by: "dispatch", dispatchIds: ["storage-lifecycle-dispatch"] }),
  );
  assert.deepEqual(
    source.readDispatchLifecycle!({ by: "session", runtimeSessionId: "storage-lifecycle-active-session" }),
    sqlite.readDispatchLifecycle!({ by: "session", runtimeSessionId: "storage-lifecycle-active-session" }),
  );
  const page = source.readDispatchLifecycle!({ by: "active", limit: 1 });
  assert.deepEqual(page, sqlite.readDispatchLifecycle!({ by: "active", limit: 1 }));
  assert.equal(page.rows[0]?.dispatchId, "storage-lifecycle-active-dispatch");
}
