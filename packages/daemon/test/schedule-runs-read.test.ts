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
  assert.deepEqual(result.totals, { runs: 3, missed: 2, failed: 0 });
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

test("Schedule runs project occurrence outputs, attempt, failure detail, and report text", () => {
  const base = schedule(),
    sha = "b".repeat(64),
    settled: ScheduleV1 = {
      ...base,
      status: {
        ...base.status,
        activeRun: null,
        lastRun: {
          occurrenceId: "occurrence-out",
          scheduledFor: "2026-08-26T09:00:00.000Z",
          endedAt: "2026-08-26T09:02:00.000Z",
          outcome: "failed",
          nodeId: "local",
          assignmentId: null,
          claimFence: "claim-out",
          attemptIndex: 2,
          dispatchId: "dispatch-out",
          runtimeSessionId: "runtime-out",
          detail: `artifact:runtime-result/sha256/${sha}`,
        },
      },
    },
    events: CanonicalEventV1[] = [
      runEvent(1, "schedule_occurrence_claimed", {
        ...base,
        status: {
          ...base.status,
          automaticEvaluatedThrough: "2026-08-26T09:00:00.000Z",
          activeRun: {
            occurrenceId: "occurrence-out",
            kind: "scheduled",
            scheduledFor: "2026-08-26T09:00:00.000Z",
            claimedAt: "2026-08-26T09:00:01.000Z",
            nodeId: "local",
            assignmentId: null,
            claimFence: "claim-out",
            attemptIndex: 2,
          },
        },
      }),
      runEvent(2, "schedule_run_settled", settled),
      authoredEvent(3, "fact-event/v1", "fact_recorded", { factId: "F-OUT1" }),
      authoredEvent(4, "decision-event/v1", "decision_proposed", { decisionId: "dec_out" }),
      authoredEvent(5, "task-event/v1", "task_created", { taskId: "task_out" }),
      // Same kinds authored by another session (or a human) must not leak into this occurrence.
      {
        ...authoredEvent(6, "fact-event/v1", "fact_recorded", { factId: "F-OTHER" }),
        actor: { principal: { personId: "someone-else" }, executor: null },
      },
    ],
    report = "# Report\n\nProbe outcome: failed step `sessions`.\n",
    result = readScheduleRuns(
      {
        projection: projection(events, base).projection,
        store: { readContentBlob: (hash) => (hash === sha ? Buffer.from(report, "utf8") : null) },
      },
      base.scheduleId,
    );

  assert.deepEqual(validateScheduleRuns(result), []);
  const row = result.runs[0]!;
  assert.equal(row.occurrenceId, "occurrence-out");
  assert.equal(row.outcome, "failed");
  assert.equal(row.attemptIndex, 2);
  assert.equal(row.reportRef, `artifact:runtime-result/sha256/${sha}`);
  assert.equal(row.reportText, report);
  assert.deepEqual(row.outputs, { facts: ["F-OUT1"], decisions: ["dec_out"], tasks: ["task_out"] });

  // A failure whose detail is a reason (not the report ref) keeps it as detail.
  const reasonSettled: ScheduleV1 = {
      ...settled,
      status: {
        ...settled.status,
        lastRun: { ...settled.status.lastRun!, detail: "cwd /missing does not exist" },
      },
    },
    reasonEvents = [events[0]!, runEvent(2, "schedule_run_settled", reasonSettled)],
    reasonResult = readScheduleRuns(projection(reasonEvents, base), base.scheduleId);
  assert.equal(reasonResult.runs[0]!.reportRef, null);
  assert.equal(reasonResult.runs[0]!.reportText, null);
  assert.equal(reasonResult.runs[0]!.detail, "cwd /missing does not exist");
  assert.deepEqual(reasonResult.runs[0]!.outputs, { facts: [], decisions: [], tasks: [] });
  assert.equal(reasonResult.totals.failed, 1);
});

function authoredEvent(
  revision: number,
  schema: "fact-event/v1" | "decision-event/v1" | "task-event/v1",
  type: string,
  ids: Readonly<Record<string, string>>,
): CanonicalEventV1 {
  return {
    schema,
    eventId: `event-outputs-${revision}`,
    workspaceRevision: revision,
    opId: `op-outputs-${revision}`,
    type,
    actor: {
      principal: { personId: "schedule-runs-test" },
      executor: { kind: "agent", id: "runtime-session:runtime-out" },
    },
    source: "local",
    occurredAt: `2026-08-26T09:00:${String(revision).padStart(2, "0")}.000Z`,
    payload: {},
    ...ids,
  } as unknown as CanonicalEventV1;
}

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
