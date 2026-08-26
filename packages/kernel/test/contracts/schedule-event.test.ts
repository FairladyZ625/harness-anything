// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScheduleEventInputs,
  compileScheduleDefinitionEvent,
  compileScheduleRunEvent,
  scheduleEventWritePlan,
  validateCurrentScheduleEvent,
  type ScheduleEventV1,
} from "../../src/domain/schedule-event.ts";
import { createScheduleV1, type ScheduleV1 } from "../../src/domain/schedule.ts";
import { parseCanonicalEvent, serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { canonicalDocumentClaims, canonicalEventContentClaims } from "../../src/store/task-event-store.ts";

const actor = { principal: { personId: "person-schedule" }, executor: null } as const;

test("all Schedule definition and run events round-trip through the canonical parser", () => {
  const events = fixtureEvents();
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "schedule_created",
      "schedule_enabled",
      "schedule_disabled",
      "schedule_occurrence_claimed",
      "schedule_occurrence_dispatched",
      "schedule_occurrences_missed",
      "schedule_dispatch_failed",
      "schedule_run_settled",
    ],
  );
  for (const event of events) {
    assert.deepEqual(validateCurrentScheduleEvent(event), [], event.type);
    assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event, event.type);
  }
});

test("definition events declare one document claim while run evidence declares none", () => {
  const events = fixtureEvents();
  for (const event of events) {
    const definitionEvent = ["schedule_created", "schedule_enabled", "schedule_disabled"].includes(event.type);
    assert.equal(canonicalDocumentClaims(event).length, definitionEvent ? 1 : 0, event.type);
    assert.equal(canonicalEventContentClaims(event).length, definitionEvent ? 1 : 0, event.type);
  }

  const created = compileScheduleDefinitionEvent(input(1, "schedule_created", baseSchedule()));
  assert.equal(Object.hasOwn(JSON.parse(created.blobs[0].body) as object, "status"), false);
  assertScheduleEventInputs(created.event, created.plan, created.blobs);
});

test("definition claim rejects a run-view field even when its hash and write plan are internally consistent", () => {
  const compiled = compileScheduleDefinitionEvent(input(1, "schedule_created", baseSchedule())),
    value = JSON.parse(compiled.blobs[0].body) as Readonly<Record<string, unknown>>,
    body = `${JSON.stringify({ ...value, status: compiled.event.payload.schedule.status }, null, 2)}\n`,
    claim = {
      ...compiled.event.payload.declarationDocumentClaim,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
    },
    event: ScheduleEventV1 = {
      ...compiled.event,
      payload: { ...compiled.event.payload, declarationDocumentClaim: claim },
    };
  assert.throws(
    () =>
      assertScheduleEventInputs(event, scheduleEventWritePlan(event), [
        { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body },
      ]),
    /only the exact definition facet/u,
  );
});

test("definition transition events must carry the state required by the named transition", () => {
  const paused = { ...baseSchedule(), state: "paused" as const };
  assert.throws(() => compileScheduleDefinitionEvent(input(1, "schedule_enabled", paused)), /definition event state/u);
});

function fixtureEvents(): readonly ScheduleEventV1[] {
  const base = baseSchedule(),
    active = {
      occurrenceId: "occurrence-1",
      kind: "scheduled" as const,
      scheduledFor: "2026-08-26T10:30:00.000Z",
      claimedAt: "2026-08-26T10:30:01.000Z",
      nodeId: "edge-a",
      assignmentId: "assignment-1",
      claimFence: "revision-4",
      attemptIndex: 0,
    },
    last = {
      occurrenceId: active.occurrenceId,
      scheduledFor: active.scheduledFor,
      endedAt: "2026-08-26T10:31:00.000Z",
      outcome: "succeeded" as const,
      nodeId: active.nodeId,
      assignmentId: active.assignmentId,
      claimFence: active.claimFence,
      attemptIndex: active.attemptIndex,
      dispatchId: "dispatch-1",
      runtimeSessionId: "runtime-session-1",
    },
    definitionEvents = [
      compileScheduleDefinitionEvent(input(1, "schedule_created", base)).event,
      compileScheduleDefinitionEvent(input(2, "schedule_enabled", base)).event,
      compileScheduleDefinitionEvent(
        input(3, "schedule_disabled", { ...base, state: "paused", updatedAt: "2026-08-26T10:20:00.000Z" }),
      ).event,
    ],
    runEvents = [
      compileScheduleRunEvent(
        input(4, "schedule_occurrence_claimed", {
          ...base,
          status: { ...base.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: active },
        }),
      ).event,
      compileScheduleRunEvent(
        input(5, "schedule_occurrence_dispatched", {
          ...base,
          status: {
            ...base.status,
            automaticEvaluatedThrough: active.scheduledFor,
            activeRun: { ...active, dispatchId: "dispatch-1", runtimeSessionId: "runtime-session-1" },
          },
        }),
      ).event,
      compileScheduleRunEvent({
        ...input(6, "schedule_occurrences_missed", {
          ...base,
          status: {
            ...base.status,
            automaticEvaluatedThrough: "2026-08-26T11:30:00.000Z",
            missedCount: 2,
            lastMissedAt: "2026-08-26T11:30:00.000Z",
            lastMissedReason: "scheduler_unavailable",
          },
        }),
        missed: {
          from: "2026-08-26T11:00:00.000Z",
          to: "2026-08-26T11:30:00.000Z",
          count: 2,
          reason: "scheduler_unavailable",
        },
      }).event,
      compileScheduleRunEvent(
        input(7, "schedule_dispatch_failed", {
          ...base,
          status: {
            ...base.status,
            automaticEvaluatedThrough: active.scheduledFor,
            activeRun: null,
            lastRun: { ...last, outcome: "failed", detail: "runtime instance unavailable" },
          },
        }),
      ).event,
      compileScheduleRunEvent(
        input(8, "schedule_run_settled", {
          ...base,
          status: { ...base.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: null, lastRun: last },
        }),
      ).event,
    ];
  return [...definitionEvents, ...runEvents];
}

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

function input<T extends ScheduleEventV1["type"]>(revision: number, type: T, schedule: ScheduleV1) {
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
