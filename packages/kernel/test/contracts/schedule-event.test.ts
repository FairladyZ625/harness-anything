// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScheduleEventInputs,
  compileScheduleDeletedEvent,
  compileScheduleDefinitionEvent,
  compileScheduleRunEvent,
  scheduleEventWritePlan,
  validateCurrentScheduleEvent,
  type ScheduleEventV1,
} from "../../src/domain/schedule-event.ts";
import { getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";
import { createScheduleV1, nextScheduleOccurrence, type ScheduleV1 } from "../../src/domain/schedule.ts";
import { parseCanonicalEvent, serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  canonicalEventContentClaims,
} from "../../src/store/task-event-store.ts";

const actor = { principal: { personId: "person-schedule" }, executor: null } as const;

test("all Schedule definition and run events round-trip through the canonical parser", () => {
  const events = fixtureEvents();
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "schedule_created",
      "schedule_updated",
      "schedule_enabled",
      "schedule_disabled",
      "schedule_occurrence_claimed",
      "schedule_occurrence_dispatched",
      "schedule_occurrences_missed",
      "schedule_dispatch_failed",
      "schedule_run_settled",
      "schedule_deleted",
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
    const definitionEvent = ["schedule_created", "schedule_updated", "schedule_enabled", "schedule_disabled"].includes(
      event.type,
    );
    assert.equal(canonicalDocumentClaims(event).length, definitionEvent ? 1 : 0, event.type);
    assert.equal(canonicalEventContentClaims(event).length, definitionEvent ? 1 : 0, event.type);
    assert.equal(canonicalDocumentRetirements(event).length, event.type === "schedule_deleted" ? 1 : 0, event.type);
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

test("deletion evidence is bound to the exact declaration snapshot it retires", () => {
  const schedule = baseSchedule(),
    definition = compileScheduleDefinitionEvent(input(1, "schedule_created", schedule)),
    deleted = compileScheduleDeletedEvent({
      ...input(2, "schedule_deleted", schedule),
      baseBlobSha256: definition.blobs[0].sha256,
      reason: "retired",
    }).event;
  assert.equal(
    deleted.payload.declarationDocumentRetirement.baseBlobSha256,
    definition.event.payload.declarationDocumentClaim.sha256,
  );
  assert.throws(
    () => compileScheduleDeletedEvent({ ...input(2, "schedule_deleted", schedule), baseBlobSha256: "invalid" }),
    /deletion evidence/u,
  );
});

test("an update that resends the unchanged interval keeps the cadence anchor and next occurrence", () => {
  const draft = scheduleUpdateDraft({ name: "Renamed heartbeat", everyMs: 1_800_000 });
  if (draft.kind !== "schedule" || draft.result.kind !== "event") throw new Error("missing schedule_updated event");
  const updated = draft.result.bundle.event.payload.schedule;
  assert.equal(updated.name, "Renamed heartbeat");
  assert.deepEqual(updated.spec.trigger, baseSchedule().spec.trigger);
  assert.equal(nextScheduleOccurrence(updated.spec.trigger, "2026-08-26T11:45:00.000Z"), "2026-08-26T12:00:00.000Z");
});

test("an update that resends the unchanged interval and nothing else compiles to no-changes", () => {
  // GUI saves always resend the interval value; once the anchor is preserved, such an update
  // changes no definition field at all and must not emit a cadence-resetting event.
  const draft = scheduleUpdateDraft({ everyMs: 1_800_000 });
  if (draft.kind !== "schedule") throw new Error("missing schedule update draft");
  assert.deepEqual(draft.result, { kind: "no-changes", schedule: baseSchedule(), revision: 2 });
});

test("a real interval change re-anchors the cadence at the update instant", () => {
  const draft = scheduleUpdateDraft({ everyMs: 3_600_000 });
  if (draft.kind !== "schedule" || draft.result.kind !== "event") throw new Error("missing schedule_updated event");
  assert.deepEqual(draft.result.bundle.event.payload.schedule.spec.trigger, {
    kind: "interval",
    everyMs: 3_600_000,
    anchorAt: "2026-08-26T11:45:00.000Z",
  });
});

test("switching a cron schedule to an interval anchors at the update instant", () => {
  const draft = scheduleUpdateDraft({ everyMs: 1_800_000 }, cronSchedule());
  if (draft.kind !== "schedule" || draft.result.kind !== "event") throw new Error("missing schedule_updated event");
  assert.deepEqual(draft.result.bundle.event.payload.schedule.spec.trigger, {
    kind: "interval",
    everyMs: 1_800_000,
    anchorAt: "2026-08-26T11:45:00.000Z",
  });
});

function fixtureEvents(): readonly ScheduleEventV1[] {
  const base = baseSchedule(),
    active = {
      occurrenceId: "occurrence-1",
      kind: "scheduled" as const,
      scheduledFor: "2026-08-26T10:30:00.000Z",
      claimedAt: "2026-08-26T10:30:01.000Z",
      nodeId: "edge-a",
      claimFence: "revision-4",
      attemptIndex: 0,
    },
    last = {
      occurrenceId: active.occurrenceId,
      scheduledFor: active.scheduledFor,
      endedAt: "2026-08-26T10:31:00.000Z",
      outcome: "succeeded" as const,
      nodeId: active.nodeId,
      claimFence: active.claimFence,
      attemptIndex: active.attemptIndex,
      dispatchId: "dispatch-1",
      runtimeSessionId: "runtime-session-1",
    },
    definitionBundles = [
      compileScheduleDefinitionEvent(input(1, "schedule_created", base)),
      compileScheduleDefinitionEvent(
        input(2, "schedule_updated", { ...base, name: "Updated heartbeat", updatedAt: "2026-08-26T10:02:00.000Z" }),
      ),
      compileScheduleDefinitionEvent(input(3, "schedule_enabled", base)),
      compileScheduleDefinitionEvent(
        input(4, "schedule_disabled", { ...base, state: "paused", updatedAt: "2026-08-26T10:20:00.000Z" }),
      ),
    ],
    runEvents = [
      compileScheduleRunEvent(
        input(5, "schedule_occurrence_claimed", {
          ...base,
          status: { ...base.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: active },
        }),
      ).event,
      compileScheduleRunEvent(
        input(6, "schedule_occurrence_dispatched", {
          ...base,
          status: {
            ...base.status,
            automaticEvaluatedThrough: active.scheduledFor,
            activeRun: { ...active, dispatchId: "dispatch-1", runtimeSessionId: "runtime-session-1" },
          },
        }),
      ).event,
      compileScheduleRunEvent({
        ...input(7, "schedule_occurrences_missed", {
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
        input(8, "schedule_dispatch_failed", {
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
        input(9, "schedule_run_settled", {
          ...base,
          status: { ...base.status, automaticEvaluatedThrough: active.scheduledFor, activeRun: null, lastRun: last },
        }),
      ).event,
    ];
  const deleted = compileScheduleDeletedEvent({
    ...input(10, "schedule_deleted", base),
    baseBlobSha256: definitionBundles[0].blobs[0].sha256,
    reason: "retired by operator",
  }).event;
  return [...definitionBundles.map(({ event }) => event), ...runEvents, deleted];
}

function baseSchedule(): ScheduleV1 {
  return createScheduleV1({
    scheduleId: "schedule-heartbeat",
    name: "Repository heartbeat",
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-26T10:00:00.000Z" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: "Check repository health.",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
}

function cronSchedule(): ScheduleV1 {
  return createScheduleV1({
    scheduleId: "schedule-heartbeat",
    name: "Repository heartbeat",
    mode: "detect",
    spec: {
      trigger: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: "Check repository health.",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
}

function scheduleUpdateDraft(action: Readonly<Record<string, unknown>>, current: ScheduleV1 = baseSchedule()) {
  const compiler = getExecutableEntityAction("schedule-update")?.execution?.compile;
  assert.ok(compiler);
  return compiler({
    action,
    actor,
    source: "local",
    session: { kind: "unavailable", reason: "contract-test" },
    opId: "schedule-update-contract-test",
    occurredAt: "2026-08-26T11:45:00.000Z",
    workspaceRevision: 3,
    currentEntity: current,
    entityRevision: 2,
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
