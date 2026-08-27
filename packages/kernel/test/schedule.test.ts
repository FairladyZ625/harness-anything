// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createScheduleV1,
  nextScheduleOccurrence,
  updateScheduleV1,
  validateScheduleV1,
  type ScheduleV1,
} from "../src/domain/schedule.ts";

const actor = { principal: { personId: "person-schedule" }, executor: null } as const;

test("Schedule interval occurrences keep the creation anchor without fixed-delay drift", () => {
  const trigger = { kind: "interval" as const, everyMs: 60_000, anchorAt: "2026-08-26T10:00:00.000Z" };
  assert.equal(nextScheduleOccurrence(trigger, trigger.anchorAt), "2026-08-26T10:01:00.000Z");
  assert.equal(nextScheduleOccurrence(trigger, "2026-08-26T10:05:30.000Z"), "2026-08-26T10:06:00.000Z");
});

test("Schedule rejects deferred trigger kinds, non-agent targets, and non-UTC instants", () => {
  const schedule = fixtureSchedule();
  assert.notDeepEqual(
    validateScheduleV1({
      ...schedule,
      spec: {
        ...schedule.spec,
        trigger: { kind: "cron", expression: "0 8 * * *", timeZone: "Asia/Taipei" },
      },
    }),
    [],
  );
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

test("Schedule update replaces the complete declaration while retaining projected run evidence", () => {
  const original = fixtureSchedule(),
    withHistory: ScheduleV1 = {
      ...original,
      status: {
        ...original.status,
        missedCount: 2,
        lastMissedAt: "2026-08-26T10:30:00.000Z",
        lastMissedReason: "scheduler_unavailable",
      },
    },
    updated = updateScheduleV1({
      schedule: withHistory,
      name: "  Daily health  ",
      spec: {
        trigger: { kind: "interval", everyMs: 3_600_000, anchorAt: "2026-08-26T11:00:00.000Z" },
        target: {
          kind: "agent",
          agentId: "reviewer",
          runtimeInstanceId: "runtime-review",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          cwd: "packages/kernel",
        },
        mission: "  Review repository health.  ",
      },
      occurredAt: "2026-08-26T11:00:00.000Z",
    });
  assert.equal(updated.name, "Daily health");
  assert.equal(updated.spec.mission, "Review repository health.");
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.updatedAt, "2026-08-26T11:00:00.000Z");
  assert.deepEqual(updated.status, withHistory.status);
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
