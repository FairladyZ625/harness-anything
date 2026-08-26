// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { parseScheduleDuration, renderScheduleList } from "../src/cli/thin-command-schedule.ts";

test("Schedule CLI exposes five interval-only commands with a closed mission input", () => {
  const created = parseThinCommand([
    "schedule",
    "create",
    "e2e-probe",
    "--name",
    "E2E probe",
    "--every",
    "30m",
    "--agent",
    "probe-agent",
    "--instance",
    "codex-probe",
    "--mission",
    "Run the probe",
    "--disabled",
    "--idempotency-key",
    "seed-e2e-probe",
  ]);
  assert.equal(created.ok, true);
  if (created.ok)
    assert.deepEqual(created.command.action, {
      kind: "schedule-create",
      scheduleId: "e2e-probe",
      name: "E2E probe",
      everyMs: 1_800_000,
      agentId: "probe-agent",
      runtimeInstanceId: "codex-probe",
      mission: "Run the probe",
      disabled: true,
      idempotencyKey: "seed-e2e-probe",
    });
  for (const verb of ["enable", "disable", "run-now"] as const) {
    const parsed = parseThinCommand(["schedule", verb, "e2e-probe"]);
    assert.equal(parsed.ok, true, verb);
    if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: `schedule-${verb}`, scheduleId: "e2e-probe" });
  }
  assert.equal(parseThinCommand(["schedule", "list"]).ok, true);
  const listWithOption = parseThinCommand(["schedule", "list", "--unknown"]);
  assert.equal(listWithOption.ok, false);
  if (!listWithOption.ok) assert.match(listWithOption.nextAction, /takes no options/u);
  assert.equal(parseScheduleDuration("60s"), 60_000);
  assert.equal(parseScheduleDuration("1m"), 60_000);
  assert.equal(parseScheduleDuration("2h"), 7_200_000);
  assert.equal(parseScheduleDuration("1d"), 86_400_000);
});

test("Schedule CLI rejects cron, sub-minute intervals, and ambiguous missions", () => {
  const base = [
    "schedule",
    "create",
    "probe",
    "--name",
    "Probe",
    "--every",
    "5m",
    "--agent",
    "agent",
    "--instance",
    "instance",
  ];
  assert.equal(parseThinCommand([...base, "--mission", "one", "--mission-file", "mission.md"]).ok, false);
  assert.equal(parseThinCommand([...base, "--cron", "* * * * *", "--mission", "one"]).ok, false);
  assert.equal(parseThinCommand([...base, "--timezone", "UTC", "--mission", "one"]).ok, false);
  assert.equal(parseThinCommand([...base.slice(0, 6), "30s", ...base.slice(7), "--mission", "one"]).ok, false);
});

test("Schedule list human renderer shows state, next occurrence, and single-flight state", () => {
  assert.equal(
    renderScheduleList({
      command: "schedule-list",
      schedules: [
        { scheduleId: "armed", state: "armed", nextRunAt: "2026-08-26T14:00:00.000Z", status: { activeRun: {} } },
        { scheduleId: "paused", state: "paused", nextRunAt: null, status: { activeRun: null } },
      ],
    }),
    "armed\tarmed\t2026-08-26T14:00:00.000Z\tactive\npaused\tpaused\tnone\tidle",
  );
  assert.equal(renderScheduleList({ command: "schedule-list", schedules: [] }), "No schedules.");
});
