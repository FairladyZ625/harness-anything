// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  compileScheduleDefinitionEvent,
  compileScheduleDeletedEvent,
  compileScheduleRunEvent,
} from "../../src/domain/schedule-event.ts";
import { createScheduleV1, type ScheduleV1 } from "../../src/domain/schedule.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const actor = { principal: { personId: "person-schedule" }, executor: null } as const;

test("Schedule definition and run view share one canonical stream and rebuild exactly without an additional schema bump", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    assert.equal(taskProjectionSchemaVersion, 13);
    const eventStore = makeTaskEventStore({ repoId: "schedule-projection", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      schedule = baseSchedule(),
      active = {
        occurrenceId: "occurrence-1",
        kind: "scheduled" as const,
        scheduledFor: "2026-08-26T10:30:00.000Z",
        claimedAt: "2026-08-26T10:30:01.000Z",
        nodeId: "edge-a",
        assignmentId: "assignment-1",
        claimFence: "revision-2",
        attemptIndex: 0,
      },
      created = compileScheduleDefinitionEvent(input(1, "schedule_created", schedule)),
      claimed = compileScheduleRunEvent(
        input(2, "schedule_occurrence_claimed", {
          ...schedule,
          status: { ...schedule.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: active },
        }),
      ),
      dispatched = compileScheduleRunEvent(
        input(3, "schedule_occurrence_dispatched", {
          ...schedule,
          status: {
            ...schedule.status,
            automaticEvaluatedThrough: active.scheduledFor,
            activeRun: { ...active, dispatchId: "dispatch-1", runtimeSessionId: "runtime-session-1" },
          },
        }),
      ),
      settledSchedule: ScheduleV1 = {
        ...schedule,
        status: {
          ...schedule.status,
          automaticEvaluatedThrough: active.scheduledFor,
          activeRun: null,
          lastRun: {
            occurrenceId: active.occurrenceId,
            scheduledFor: active.scheduledFor,
            endedAt: "2026-08-26T10:31:00.000Z",
            outcome: "succeeded",
            nodeId: active.nodeId,
            assignmentId: active.assignmentId,
            claimFence: active.claimFence,
            attemptIndex: active.attemptIndex,
            dispatchId: "dispatch-1",
            runtimeSessionId: "runtime-session-1",
          },
        },
      },
      settled = compileScheduleRunEvent(input(4, "schedule_run_settled", settledSchedule));

    for (const bundle of [created, claimed, dispatched, settled] as readonly CanonicalWriteBundle[]) {
      eventStore.append(bundle);
      assert.deepEqual(projection.apply(bundle.event, bundle.plan).metrics, {
        sqliteTransactions: 1,
        reducedItems: 1,
      });
    }

    const definition = projection.readDocument("schedules/schedule-heartbeat.json").document,
      row = projection.getEntity("schedule", "schedule-heartbeat"),
      digest = projection.readStateDigest();
    assert.ok(definition);
    assert.equal(definition.body, created.blobs[0].body);
    assert.equal(Object.hasOwn(JSON.parse(definition.body) as object, "status"), false);
    assert.deepEqual(row?.value, settledSchedule);
    assert.deepEqual(
      row === null
        ? null
        : { kind: row.kind, id: row.id, ownerId: row.ownerId, workspaceRevision: row.workspaceRevision },
      { kind: "schedule", id: "schedule-heartbeat", ownerId: null, workspaceRevision: 4 },
    );

    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 4);
    assert.deepEqual(projection.readDocument("schedules/schedule-heartbeat.json").document, definition);
    assert.deepEqual(projection.getEntity("schedule", "schedule-heartbeat"), row);
    assert.equal(projection.readStateDigest(), digest);
    assert.equal(eventStore.read().revision, 4);

    const deleted = compileScheduleDeletedEvent({
      ...input(5, "schedule_deleted", settledSchedule),
      baseBlobSha256: created.blobs[0].sha256,
      reason: "No longer required",
    });
    eventStore.append(deleted);
    projection.apply(deleted.event, deleted.plan);
    assert.equal(projection.readDocument("schedules/schedule-heartbeat.json").document, null);
    assert.equal(projection.getEntity("schedule", "schedule-heartbeat"), null);
    assert.deepEqual(
      eventStore.read().events.map(({ type }) => type),
      [
        "schedule_created",
        "schedule_occurrence_claimed",
        "schedule_occurrence_dispatched",
        "schedule_run_settled",
        "schedule_deleted",
      ],
    );
    const rebuiltAfterDelete = projection.rebuild();
    assert.equal(rebuiltAfterDelete.watermark, 5);
    assert.equal(projection.readDocument("schedules/schedule-heartbeat.json").document, null);
    assert.equal(projection.getEntity("schedule", "schedule-heartbeat"), null);
  });
});

function baseSchedule(): ScheduleV1 {
  return createScheduleV1({
    scheduleId: "schedule-heartbeat",
    name: "Repository heartbeat",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-26T10:00:00.000Z" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: "Check repository health.",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
}

function input<T extends string>(revision: number, type: T, schedule: ScheduleV1) {
  return {
    type,
    schedule,
    eventId: `event-schedule-${revision}`,
    opId: `op-schedule-${revision}`,
    workspaceRevision: revision,
    actor,
    source: "local" as const,
    occurredAt: `2026-08-26T10:${String(revision).padStart(2, "0")}:00.000Z`,
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Schedule Projection Test");
  git(rootDir, "config", "user.email", "schedule-projection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
