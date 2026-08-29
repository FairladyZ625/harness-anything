// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileScheduleRunEvent,
  createScheduleV1,
  type CanonicalEventV1,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import { readScheduleRuns, validateScheduleRuns } from "../src/schedule-runs-read.ts";

const actor = { principal: { personId: "schedule-runs-test" }, executor: null } as const;

test("Schedule runs project claimed, settled, and each missed occurrence from canonical events", () => {
  const base = schedule(),
    active = {
      occurrenceId: "occurrence-1",
      kind: "scheduled" as const,
      scheduledFor: "2026-08-26T10:30:00.000Z",
      claimedAt: "2026-08-26T10:30:01.000Z",
      nodeId: "edge-a",
      assignmentId: "assignment-1",
      claimFence: "claim-1",
      attemptIndex: 0,
      dispatchId: "dispatch-1",
      runtimeSessionId: "runtime-1",
    },
    claimed = {
      ...base,
      status: { ...base.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: active },
    },
    settled: ScheduleV1 = {
      ...base,
      status: {
        ...base.status,
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
          dispatchId: active.dispatchId,
          runtimeSessionId: active.runtimeSessionId,
          detail: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
        },
      },
    },
    missed: ScheduleV1 = {
      ...settled,
      status: {
        ...settled.status,
        automaticEvaluatedThrough: "2026-08-26T11:30:00.000Z",
        missedCount: 2,
        lastMissedAt: "2026-08-26T11:30:00.000Z",
        lastMissedReason: "scheduler_unavailable",
      },
    },
    events: CanonicalEventV1[] = [
      runEvent(1, "schedule_occurrence_claimed", claimed),
      runEvent(2, "schedule_run_settled", settled),
      compileScheduleRunEvent({
        ...eventInput(3, "schedule_occurrences_missed", missed),
        missed: {
          from: "2026-08-26T11:00:00.000Z",
          to: "2026-08-26T11:30:00.000Z",
          count: 2,
          reason: "scheduler_unavailable",
        },
      }).event,
    ],
    result = readScheduleRuns(projection(events, base), base.scheduleId, 2);

  assert.deepEqual(validateScheduleRuns(result), []);
  assert.deepEqual(result.totals, { runs: 3, missed: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.runs.map(({ scheduledFor, outcome, missedReason }) => ({ scheduledFor, outcome, missedReason })),
    [
      {
        scheduledFor: "2026-08-26T11:30:00.000Z",
        outcome: "missed",
        missedReason: "scheduler_unavailable",
      },
      {
        scheduledFor: "2026-08-26T11:00:00.000Z",
        outcome: "missed",
        missedReason: "scheduler_unavailable",
      },
    ],
  );

  const complete = readScheduleRuns(projection(events, base), base.scheduleId);
  assert.equal(complete.runs[2]!.durationMs, 59_000);
  assert.equal(complete.runs[2]!.reportRef, `artifact:runtime-result/sha256/${"a".repeat(64)}`);
  assert.equal(complete.runs[2]!.nodeId, "edge-a");
});

test("Schedule runs reject missing schedules, invalid limits, and open wire shapes", () => {
  const base = schedule(),
    context = projection([], base);
  assert.throws(
    () => readScheduleRuns(context, base.scheduleId, 0),
    (error: unknown) => {
      return (error as { code?: string }).code === "invalid_command";
    },
  );
  assert.throws(
    () => readScheduleRuns(projection([], null), "missing"),
    (error: unknown) => {
      return (error as { code?: string }).code === "entity_not_found";
    },
  );
  assert.notDeepEqual(
    validateScheduleRuns({
      ...readScheduleRuns(context, base.scheduleId),
      accessToken: "not-a-wire-field",
    }),
    [],
  );
});

function schedule(): ScheduleV1 {
  return createScheduleV1({
    scheduleId: "schedule-history",
    name: "Schedule history",
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-26T10:00:00.000Z" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: "Project Schedule occurrences.",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
}

function eventInput<T extends "schedule_occurrence_claimed" | "schedule_run_settled" | "schedule_occurrences_missed">(
  revision: number,
  type: T,
  value: ScheduleV1,
) {
  return {
    type,
    schedule: value,
    eventId: `event-schedule-runs-${revision}`,
    opId: `op-schedule-runs-${revision}`,
    workspaceRevision: revision,
    actor,
    source: "local" as const,
    occurredAt: `2026-08-26T1${revision}:00:00.000Z`,
  };
}

function runEvent(
  revision: number,
  type: "schedule_occurrence_claimed" | "schedule_run_settled",
  value: ScheduleV1,
): CanonicalEventV1 {
  return compileScheduleRunEvent(eventInput(revision, type, value)).event;
}

function projection(events: readonly CanonicalEventV1[], value: ScheduleV1 | null) {
  return {
    projection: {
      getEntity: () => value,
      readCanonicalEvents: (afterRevision: number, limit: number) => ({
        status: "ready" as const,
        events: events.filter(({ workspaceRevision }) => workspaceRevision > afterRevision).slice(0, limit),
        watermark: events.at(-1)?.workspaceRevision ?? 0,
        sourceRevision: events.at(-1)?.workspaceRevision ?? 0,
      }),
    },
  };
}
