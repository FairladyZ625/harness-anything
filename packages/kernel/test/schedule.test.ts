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

test("Schedule cron occurrences preserve daily wall-clock time in the declared timezone", () => {
  const trigger = { kind: "cron" as const, expression: "30 2 * * *", timezone: "Asia/Taipei" };
  assert.equal(nextScheduleOccurrence(trigger, "2026-08-26T18:29:00.000Z"), "2026-08-26T18:30:00.000Z");
  assert.equal(nextScheduleOccurrence(trigger, "2026-08-26T18:30:00.000Z"), "2026-08-27T18:30:00.000Z");
});

test("Schedule validates cron, mode, squad placeholders, and UTC instants", () => {
  const schedule = fixtureSchedule();
  assert.notDeepEqual(
    validateScheduleV1({
      ...schedule,
      spec: {
        ...schedule.spec,
        trigger: { kind: "cron", expression: "not cron", timezone: "Asia/Taipei" },
      },
    }),
    [],
  );
  assert.deepEqual(
    validateScheduleV1({
      ...schedule,
      spec: {
        ...schedule.spec,
        target: { kind: "squad", squadId: "squad-heartbeat" },
      },
    }),
    [],
  );
  assert.notDeepEqual(validateScheduleV1({ ...schedule, mode: "observe" }), []);
  assert.notDeepEqual(validateScheduleV1({ ...schedule, createdAt: "2026-08-26T18:00:00+08:00" }), []);
});

test("Schedule creation trims authored text and starts with an empty projected run view", () => {
  const schedule = createScheduleV1({
    scheduleId: "schedule-heartbeat",
    name: "  Repository heartbeat  ",
    mode: "detect",
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

test("Schedule writable roots are read-side tolerated on remediate schedules only", () => {
  // The write path that produced spec.writableRoots is retired; recorded events still replay
  // into projections that re-validate strictly, so the recorded shape must stay acceptable.
  const legacy = {
    ...fixtureSchedule(),
    mode: "remediate" as const,
    spec: {
      ...fixtureSchedule().spec,
      writableRoots: ["tmp/harness-backup", ".harness/restore-drills"],
    },
  };
  assert.deepEqual(validateScheduleV1(legacy), []);
  assert.notDeepEqual(validateScheduleV1({ ...legacy, mode: "detect" }), []);
  assert.notDeepEqual(
    validateScheduleV1({
      ...legacy,
      spec: { ...legacy.spec, writableRoots: ["../escape", "tmp/harness-backup"] },
    }),
    [],
  );
  assert.notDeepEqual(
    validateScheduleV1({
      ...legacy,
      spec: { ...legacy.spec, writableRoots: ["tmp//harness-backup", "tmp/harness-backup"] },
    }),
    [],
  );
});

test("Schedule builtin targets carry a builtin id and bounded retention params", () => {
  const builtin = createScheduleV1({
    scheduleId: "builtin-ledger-backup",
    name: "Ledger backup",
    mode: "detect",
    spec: {
      trigger: { kind: "cron", expression: "17 3 * * *", timezone: "UTC" },
      target: { kind: "builtin", builtinId: "ledger-backup", params: { keepDays: 3, keepMonthly: true } },
      mission: "System ledger backup.",
    },
    actor,
    occurredAt: "2026-09-19T00:00:00.000Z",
  });
  assert.deepEqual(validateScheduleV1(builtin), []);
  assert.deepEqual(
    validateScheduleV1({
      ...builtin,
      spec: {
        ...builtin.spec,
        target: { kind: "builtin", builtinId: "ledger-backup" },
      },
    }),
    [],
  );
  for (const params of [{ keepDays: 0 }, { keepDays: 3.5 }, { keepDays: 3, keepMonthly: "yes" }, { other: 1 }])
    assert.notDeepEqual(
      validateScheduleV1({
        ...builtin,
        spec: { ...builtin.spec, target: { kind: "builtin", builtinId: "ledger-backup", params } },
      }),
      [],
      JSON.stringify(params),
    );
  assert.notDeepEqual(
    validateScheduleV1({
      ...builtin,
      spec: { ...builtin.spec, target: { kind: "builtin", builtinId: "", params: {} } },
    }),
    [],
  );
});

test("an unconfigured system preset is valid only while paused", () => {
  const schedule = createScheduleV1({
    scheduleId: "builtin-nightly-reckoning",
    name: "Nightly reckoning",
    state: "paused",
    mode: "detect",
    systemPresetId: "nightly-reckoning",
    spec: {
      trigger: { kind: "cron", expression: "30 23 * * *", timezone: "UTC" },
      target: { kind: "agent-unconfigured" },
      mission: "Review recent friction.",
    },
    actor,
    occurredAt: "2026-08-26T10:00:00.000Z",
  });
  assert.deepEqual(validateScheduleV1(schedule), []);
  assert.notDeepEqual(validateScheduleV1({ ...schedule, state: "armed" }), []);
});

function fixtureSchedule(): ScheduleV1 {
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
