// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createScheduleV1,
  nextScheduleOccurrence,
  validateScheduleV1,
  type ScheduleV1,
} from "../src/domain/schedule.ts";

const actor = { principal: { personId: "person-schedule" }, executor: null } as const;

test("Schedule interval occurrences keep the creation anchor without fixed-delay drift", () => {
  const trigger = { kind: "interval" as const, everyMs: 60_000, anchorAt: "2026-08-26T10:00:00.000Z" };
  assert.equal(nextScheduleOccurrence(trigger, trigger.anchorAt), "2026-08-26T10:01:00.000Z");
  assert.equal(nextScheduleOccurrence(trigger, "2026-08-26T10:05:30.000Z"), "2026-08-26T10:06:00.000Z");
});

test("Schedule cron uses explicit IANA wall-clock semantics across both DST boundaries", () => {
  const spring = { kind: "cron" as const, expression: "30 2 * * *", timeZone: "America/New_York" };
  assert.equal(nextScheduleOccurrence(spring, "2026-03-07T07:30:00.000Z"), "2026-03-08T07:30:00.000Z");

  const fall = { kind: "cron" as const, expression: "30 1 * * *", timeZone: "America/New_York" },
    first = nextScheduleOccurrence(fall, "2026-10-31T05:30:00.000Z");
  assert.equal(first, "2026-11-01T05:30:00.000Z");
  assert.equal(nextScheduleOccurrence(fall, first), "2026-11-02T06:30:00.000Z");
});

test("Schedule rejects six-field cron, missing time zone, non-agent targets, and non-UTC instants", () => {
  const schedule = fixtureSchedule();
  for (const trigger of [
    { kind: "cron", expression: "0 30 2 * * *", timeZone: "UTC" },
    { kind: "cron", expression: "30 2 * * *" },
  ])
    assert.notDeepEqual(validateScheduleV1({ ...schedule, spec: { ...schedule.spec, trigger } }), []);
  assert.notDeepEqual(
    validateScheduleV1({
      ...schedule,
      spec: {
        ...schedule.spec,
        target: { kind: "squad", squadId: "squad-heartbeat", runtimeInstanceId: "runtime-local" },
      },
    }),
    [],
  );
  assert.notDeepEqual(validateScheduleV1({ ...schedule, createdAt: "2026-08-26T18:00:00+08:00" }), []);
});

test("Schedule creation trims authored text and starts with an empty projected run view", () => {
  const schedule = createScheduleV1({
    scheduleId: "schedule-heartbeat",
    name: "  Repository heartbeat  ",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-26T10:00:00.000Z" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: "  Check repository health.  ",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
  assert.equal(schedule.name, "Repository heartbeat");
  assert.equal(schedule.spec.mission, "Check repository health.");
  assert.deepEqual(schedule.status, {
    automaticEvaluatedThrough: "2026-08-26T10:00:00.000Z",
    activeRun: null,
    lastRun: null,
    missedCount: 0,
    lastMissedAt: null,
    lastMissedReason: null,
  });
});

function fixtureSchedule(): ScheduleV1 {
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
