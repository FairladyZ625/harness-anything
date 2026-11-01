import assert from "node:assert/strict";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reduceTaskEvent,
  type TaskEventV1,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { LeaseV1, TaskProjection } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import type { PgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";

export async function appendLeaseReplayFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<readonly { taskId: string; executionId: string; version: number }[]> {
  const cases = [];
  for (const kind of ["submit", "release", "renew-release", "amend", "retire-active", "retire-submitted"] as const) {
    const taskId = "task-lease-" + kind,
      executionId = "execution-lease-" + kind,
      fixture = lifecycleFixture({ taskId, executionId }),
      events: TaskEventV1[] = [];
    const record = async (value: TaskEventV1) => {
      const event = {
        ...value,
        eventId: taskId + "-" + revision(),
        opId: taskId + "-op-" + revision(),
        workspaceRevision: revision(),
      };
      await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      events.push(event);
    };
    for (const value of fixture.events.slice(0, ["submit", "amend", "retire-submitted"].includes(kind) ? 3 : 2))
      await record(value);
    const start = events[1]!;
    assert.equal(start.type, "execution_started");
    if (start.type !== "execution_started") throw new Error("lease fixture requires canonical start");
    let lease = start.payload.lease;
    if (kind === "renew-release") {
      lease = { ...lease, version: lease.version + 1, expiresAt: "2026-08-11T02:00:00.000Z" };
      await record({
        ...start,
        type: "lease_renewed",
        occurredAt: "2026-08-11T00:02:00.000Z",
        payload: {
          task: start.payload.task,
          execution: start.payload.execution,
          lease,
          previousHolder: { taskId, executionId, actor: lease.actor, source: lease.source },
          documentClaims: [],
          leaseExpiresAt: lease.expiresAt,
          reason: "same_principal_reconnect",
        },
      });
    }
    if (kind === "release" || kind === "renew-release") {
      await record({
        ...start,
        type: "lease_released",
        occurredAt: "2026-08-11T00:03:00.000Z",
        payload: {
          task: start.payload.task,
          execution: start.payload.execution,
          releasedLease: lease,
          documentClaims: [],
          mutation: { command: "release", reason: "canonical parity", fields: ["lease"] },
        },
      });
    }
    if (kind === "amend" || kind.startsWith("retire-")) {
      const snapshot = events.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
      const submitted = events.find((event) => event.type === "execution_submitted");
      const intent =
        kind === "amend"
          ? {
              type: "SubmitExecution" as const,
              taskId,
              executionId,
              amend: true,
              submission: { ...submitted!.payload.execution.submission!, commitSha: "b".repeat(40) },
            }
          : { type: "RetireCompletionGeneration" as const, taskId, executionId, sourceGeneration: 2 as const };
      const command = {
        ...normalizeTaskLifecycleCommand(
          { workspaceId: "workspace-1", actor: start.actor, source: start.source, expectedRevision: snapshot.revision },
          intent,
        ),
        eventId: taskId + "-transition",
        workspaceRevision: revision(),
        occurredAt: "2026-08-11T00:04:00.000Z",
      };
      const result =
        kind === "amend"
          ? applyTransition(
              snapshot,
              command as Parameters<typeof applyTransition>[1],
              { actorBinding: start.actor, leaseVersion: null, sessionDisposition: "complete" } as never,
            )
          : applyTransition(snapshot, command as Parameters<typeof applyTransition>[1], {} as never);
      await record(result.event);
    }
    cases.push({ taskId, executionId, version: lease.version + (kind === "retire-submitted" ? 2 : 1) });
  }
  return cases;
}

export function canonicalLeaseOracle(
  sqlite: TaskProjection,
  cases: readonly { taskId: string; executionId: string; version: number }[],
): readonly LeaseV1[] {
  return cases.map(({ taskId, executionId, version }) => {
    const lease = sqlite.currentLease(taskId, "2026-08-11T00:30:00.000Z");
    assert.ok(lease, "SQLite canonical lease " + taskId);
    assert.equal(lease.phase, "released");
    assert.equal(lease.version, version);
    assert.deepEqual(sqlite.currentLeaseForExecution(executionId), lease);
    assert.equal(sqlite.read(taskId).snapshot.lease, null, "domain snapshot remains unleased");
    return lease;
  });
}

export async function assertCanonicalLeaseReads(
  pg: PgTaskProjectionSource,
  expected: readonly LeaseV1[],
): Promise<void> {
  for (const lease of expected) {
    for (const now of ["2026-08-11T00:30:00.000Z", lease.expiresAt, "2026-08-11T03:00:00.000Z"]) {
      assert.deepEqual(await pg.currentLease(lease.taskId, now), lease, "canonical task lease " + lease.taskId);
      assert.deepEqual(
        await pg.currentLeaseForExecution(lease.executionId, now),
        lease,
        "canonical execution lease " + lease.executionId,
      );
    }
    assert.equal((await pg.readSnapshot(lease.taskId))?.lease, null, "domain snapshot remains unleased");
  }
}
