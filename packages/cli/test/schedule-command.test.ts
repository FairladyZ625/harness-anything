// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleV1 } from "../../kernel/src/index.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import {
  parseScheduleDuration,
  renderScheduleList,
  renderScheduleRuns,
  renderScheduleShow,
} from "../src/cli/thin-command-schedule.ts";

test("Schedule CLI exposes CRUD and run-control commands with closed inputs", () => {
  const created = parseThinCommand([
    "schedule",
    "create",
    "e2e-probe",
    "--name",
    "E2E probe",
    "--mode",
    "detect",
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
      mode: "detect",
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
  const shown = parseThinCommand(["schedule", "show", "e2e-probe"]);
  assert.equal(shown.ok, true);
  if (shown.ok) assert.deepEqual(shown.command.action, { kind: "schedule-show", scheduleId: "e2e-probe" });
  const runs = parseThinCommand(["schedule", "runs", "e2e-probe", "--limit", "25"]);
  assert.equal(runs.ok, true);
  if (runs.ok) assert.deepEqual(runs.command.action, { kind: "schedule-runs", scheduleId: "e2e-probe", limit: 25 });
  const updated = parseThinCommand([
    "schedule",
    "update",
    "e2e-probe",
    "--name",
    "Updated probe",
    "--every",
    "2h",
    "--mission",
    "Run the updated probe",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "high",
    "--cwd",
    "packages/cli",
    "--idempotency-key",
    "update-e2e-probe",
  ]);
  assert.equal(updated.ok, true);
  if (updated.ok)
    assert.deepEqual(updated.command.action, {
      kind: "schedule-update",
      scheduleId: "e2e-probe",
      name: "Updated probe",
      everyMs: 7_200_000,
      mission: "Run the updated probe",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "packages/cli",
      idempotencyKey: "update-e2e-probe",
    });
  const deleted = parseThinCommand([
    "schedule",
    "delete",
    "e2e-probe",
    "--reason",
    "retired",
    "--idempotency-key",
    "delete-e2e-probe",
  ]);
  assert.equal(deleted.ok, true);
  if (deleted.ok)
    assert.deepEqual(deleted.command.action, {
      kind: "schedule-delete",
      scheduleId: "e2e-probe",
      reason: "retired",
      idempotencyKey: "delete-e2e-probe",
    });
  const listWithOption = parseThinCommand(["schedule", "list", "--unknown"]);
  assert.equal(listWithOption.ok, false);
  if (!listWithOption.ok) assert.match(listWithOption.nextAction, /takes no options/u);
  assert.equal(parseScheduleDuration("60s"), 60_000);
  assert.equal(parseScheduleDuration("1m"), 60_000);
  assert.equal(parseScheduleDuration("2h"), 7_200_000);
  assert.equal(parseScheduleDuration("1d"), 86_400_000);
});

test("Schedule CLI accepts cron and rejects ambiguous triggers, sub-minute intervals, and missions", () => {
  const base = [
    "schedule",
    "create",
    "probe",
    "--name",
    "Probe",
    "--mode",
    "detect",
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
  const subMinute = [...base];
  subMinute[subMinute.indexOf("5m")] = "30s";
  assert.equal(parseThinCommand([...subMinute, "--mission", "one"]).ok, false);
  const cron = parseThinCommand([
    "schedule",
    "create",
    "daily",
    "--name",
    "Daily",
    "--mode",
    "detect",
    "--cron",
    "30 2 * * *",
    "--timezone",
    "Asia/Taipei",
    "--agent",
    "agent",
    "--instance",
    "instance",
    "--mission",
    "one",
  ]);
  assert.equal(cron.ok, true);
  if (cron.ok)
    assert.deepEqual(cron.command.action, {
      kind: "schedule-create",
      scheduleId: "daily",
      name: "Daily",
      mode: "detect",
      cronExpression: "30 2 * * *",
      timezone: "Asia/Taipei",
      agentId: "agent",
      runtimeInstanceId: "instance",
      mission: "one",
    });
  assert.equal(parseThinCommand(["schedule", "update", "probe"]).ok, false);
  assert.equal(
    parseThinCommand(["schedule", "update", "probe", "--mission", "one", "--mission-file", "mission.md"]).ok,
    false,
  );
});

test("Schedule runs human renderer uses the occurrence projection", () => {
  assert.equal(
    renderScheduleRuns({
      command: "schedule-runs",
      evidence: JSON.stringify({
        schema: "schedule-runs/v1",
        ok: true,
        status: "ready",
        scheduleId: "daily",
        runs: [
          {
            occurrenceId: "occurrence-1",
            kind: "scheduled",
            scheduledFor: "2026-08-27T18:30:00.000Z",
            claimedAt: "2026-08-27T18:30:01.000Z",
            endedAt: "2026-08-27T18:30:03.000Z",
            nodeId: "local",
            assignmentId: null,
            outcome: "succeeded",
            durationMs: 2_000,
            reportRef: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
            missedReason: null,
            dispatchId: "dispatch-1",
            runtimeSessionId: "runtime-1",
          },
        ],
        totals: { runs: 1, missed: 0 },
        truncated: false,
        watermark: 4,
        sourceRevision: 4,
      }),
    }),
    `occurrence-1\t2026-08-27T18:30:00.000Z\tsucceeded\tlocal\t2000ms\tartifact:runtime-result/sha256/${"a".repeat(64)}`,
  );
});

test("Schedule show, update, and delete expose closed structured packet inputs", () => {
  for (const [verb, packet] of [
    ["show", "show.json"],
    ["update", "update.json"],
    ["delete", "delete.json"],
  ] as const) {
    const parsed = parseThinCommand(["schedule", verb, "--from-file", packet]);
    assert.equal(parsed.ok, true, verb);
    if (parsed.ok)
      assert.deepEqual(parsed.command.action, {
        kind: `schedule-${verb}`,
        fromFile: packet,
      });
  }
  assert.equal(parseThinCommand(["schedule", "update", "probe", "--from-file", "update.json"]).ok, false);
});

test("Schedule show human renderer returns the complete schedule snapshot", () => {
  assert.equal(
    renderScheduleShow({ command: "schedule-show", schedule: { scheduleId: "probe", state: "armed" } }),
    '{\n  "scheduleId": "probe",\n  "state": "armed"\n}',
  );
});

test("Schedule list human renderer shows state, next occurrence, and single-flight state", () => {
  const actor = { principal: { personId: "schedule-cli-test" }, executor: null } as const,
    armed = createScheduleV1({
      scheduleId: "armed",
      name: "Armed",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-08-26T13:59:00.000Z" },
        target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
        mission: "Run the armed Schedule.",
      },
      actor,
      occurredAt: "2026-08-26T13:59:00.000Z",
    }),
    paused = createScheduleV1({
      scheduleId: "paused",
      name: "Paused",
      state: "paused",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-08-26T13:59:00.000Z" },
        target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
        mission: "Run the paused Schedule.",
      },
      actor,
      occurredAt: "2026-08-26T13:59:00.000Z",
    });
  assert.equal(
    renderScheduleList({
      schema: "command-receipt/v2",
      ok: true,
      command: "schedule-list",
      outcome: "applied",
      evidence: JSON.stringify({
        schema: "schedule-list/v1",
        schedules: [
          {
            ...armed,
            status: {
              ...armed.status,
              activeRun: {
                occurrenceId: "manual-active",
                kind: "manual",
                scheduledFor: "2026-08-26T13:59:00.000Z",
                claimedAt: "2026-08-26T13:59:00.000Z",
                nodeId: "local",
                assignmentId: null,
                claimFence: "claim-active",
                attemptIndex: 0,
              },
            },
            definitionRevision: 1,
            nextRunAt: "2026-08-26T14:00:00.000Z",
          },
          { ...paused, definitionRevision: 2, nextRunAt: null },
        ],
      }),
    }),
    "armed\tarmed\t2026-08-26T14:00:00.000Z\tactive\npaused\tpaused\tnone\tidle",
  );
  assert.equal(
    renderScheduleList({
      schema: "command-receipt/v2",
      ok: true,
      command: "schedule-list",
      outcome: "applied",
      evidence: JSON.stringify({ schema: "schedule-list/v1", schedules: [] }),
    }),
    "No schedules.",
  );
  assert.equal(renderScheduleList({ command: "schedule-list", schedules: [] }), null);
  assert.equal(
    renderScheduleList({
      schema: "command-receipt/v2",
      ok: true,
      command: "schedule-list",
      outcome: "applied",
      evidence: JSON.stringify({ schema: "schedule-list/v2", schedules: [] }),
    }),
    null,
  );
});
