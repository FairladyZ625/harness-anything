// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type DaemonRepoMode } from "@harness-anything/kernel";
import { withPolicyGroup, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  builtinCiObserveScheduleId,
  builtinLedgerBackupScheduleId,
  builtinNightlyReckoningScheduleId,
  scheduledLedgerBackupRoot,
  seedBuiltinSchedules,
} from "../src/schedule-builtin-executor.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { definition, initHarnessRepo } from "./schedule-actions.fixtures.ts";

type Receipt = { readonly outcome: string; readonly code?: string };
type ScheduleRow = {
  readonly scheduleId: string;
  readonly state: string;
  readonly spec: { readonly target: { readonly kind: string } };
  readonly status: { readonly activeRun: unknown; readonly lastRun: { readonly outcome: string } | null };
};

const agentSchedule = (scheduleId: string) => ({
  kind: "schedule-create",
  scheduleId,
  name: scheduleId,
  mode: "detect",
  everyMs: 300_000,
  agentId: "probe-agent",
  runtimeInstanceId: definition.instanceId,
  mission: "Inspect the repository and report success.",
  idempotencyKey: `seed-${scheduleId}`,
});

/** The Schedule events one repository accepted, as [type, scheduleId, principal, source]. */
async function scheduleEvents(repoId: string, rootDir: string) {
  const reader = makeTaskEventReader({ repoId: workspaceId(repoId), rootDir: canonicalRoot(rootDir) });
  try {
    return reader
      .read()
      .events.filter((event) => event.schema === "schedule-event/v1")
      .map((event) => [event.type, event.entity.id, event.actor.principal.personId, event.source]);
  } finally {
    await reader.drain();
  }
}

/**
 * One daemon host owning one repository in the given mode. Both seeded Schedules and the agent
 * Schedule created at 03:12:00.100 fall due inside the admission window once the clock reads 03:17.
 */
async function fireDueOccurrences(mode: DaemonRepoMode) {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-center-builtin-${mode}-`)),
    rootDir = path.join(parent, "repo"),
    clock = { value: "2026-10-02T03:12:00.100Z" };
  rosterRepo(rootDir, "repo");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "repo",
    mode,
    userRoot: path.join(parent, "user"),
    createConvenienceLinks: false,
  });
  signInPolicyTestUser(path.join(parent, "user"), "writer", ["repo"], "admin");
  const host = await openDaemonHost({
    daemonId: `center-builtin-${mode}`,
    userRoot: path.join(parent, "user"),
    now: () => clock.value,
  });
  const run = (action: Readonly<Record<string, unknown>>) =>
      host.run("repo", action as never, auth) as Promise<Receipt & { readonly schedules?: readonly ScheduleRow[] }>,
    list = async () => (await run({ kind: "schedule-list" })).schedules ?? [];
  try {
    await host.attachmentsSettled();
    await seedBuiltinSchedules({
      cell: { run: (action) => run(action) },
      binding: withPolicyGroup(
        { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const },
        "admin",
      ),
    });
    const seeded = await list();
    assert.equal((await run(agentSchedule("agent-probe"))).outcome, "applied");
    clock.value = "2026-10-02T03:17:00.500Z";
    // A Schedule write refreshes the scheduler; reads do not re-arm timers.
    assert.equal(
      (await run({ kind: "schedule-disable", scheduleId: builtinNightlyReckoningScheduleId })).outcome,
      "no_changes",
    );
    // Wait for the builtin Schedule itself: in local mode the agent occurrence can settle first.
    const builtinPending = (current: readonly ScheduleRow[]) =>
      current.find(({ scheduleId }) => scheduleId === builtinLedgerBackupScheduleId)?.status.lastRun == null;
    let rows = await list();
    for (let attempt = 0; attempt < 200 && builtinPending(rows); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await list();
    }
    const events = await scheduleEvents("repo", rootDir),
      backups = existsSync(path.join(rootDir, scheduledLedgerBackupRoot))
        ? readdirSync(path.join(rootDir, scheduledLedgerBackupRoot))
        : [];
    const manual = await run({
      kind: "schedule-run-now",
      scheduleId: builtinLedgerBackupScheduleId,
      idempotencyKey: "operator-run-now",
    });
    return {
      seeded: seeded.map(({ scheduleId, state, spec }) => [scheduleId, state, spec.target.kind]),
      rows: new Map(rows.map((row) => [row.scheduleId, row])),
      manual,
      events,
      backups,
    };
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

const seededRows = [
  [builtinCiObserveScheduleId, "armed", "builtin"],
  [builtinLedgerBackupScheduleId, "armed", "builtin"],
  [builtinNightlyReckoningScheduleId, "paused", "agent-unconfigured"],
];

test(
  "a remote-center daemon seeds, claims, executes, and settles its builtin Schedule",
  { timeout: 120_000 },
  async () => {
    const center = await fireDueOccurrences("remote-center");
    assert.deepEqual(center.seeded, seededRows);
    assert.equal(center.rows.get(builtinLedgerBackupScheduleId)?.status.lastRun?.outcome, "succeeded");
    assert.equal(center.rows.get(builtinLedgerBackupScheduleId)?.status.activeRun, null);
    assert.equal(center.backups.length, 1);
    assert.deepEqual(
      center.events.filter(([, scheduleId]) => scheduleId === builtinLedgerBackupScheduleId),
      ["schedule_created", "schedule_occurrence_claimed", "schedule_run_settled"].map((type) => [
        type,
        builtinLedgerBackupScheduleId,
        "writer",
        "local",
      ]),
    );
    // The agent occurrence was just as due: it belongs to the edge holding its occurrence claim, so the
    // center neither claims it nor writes it off as missed.
    assert.deepEqual(
      center.events.filter(([, scheduleId]) => scheduleId === "agent-probe").map(([type]) => type),
      ["schedule_created"],
    );
    assert.equal(center.rows.get("agent-probe")?.status.activeRun, null);
    // Host-level manual execution remains restricted to the authenticated node entrance.
    assert.equal(center.manual.outcome, "op_rejected");
    assert.equal(center.manual.code, "repo_mode_requires_center_ingress");
  },
);

test("a local daemon still claims both its builtin and its agent occurrences", { timeout: 120_000 }, async () => {
  const local = await fireDueOccurrences("local");
  assert.deepEqual(local.seeded, seededRows);
  assert.equal(local.rows.get(builtinLedgerBackupScheduleId)?.status.lastRun?.outcome, "succeeded");
  assert.equal(
    local.events.some(([type, scheduleId]) => type === "schedule_occurrence_claimed" && scheduleId === "agent-probe"),
    true,
  );
  assert.equal(local.manual.outcome, "applied", JSON.stringify(local.manual));
});

test("a remote-center cell admits the daemon scheduler only on builtin occurrences", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-builtin-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initHarnessRepo(root, "center-builtin-cell");
    cell = await openRepoCell({
      repoId: workspaceId("center-builtin-cell"),
      rootDir: canonicalRoot(root),
      ownerId: "center-builtin-cell",
      mode: "remote-center",
      runtimeInstances: () => [],
    });
    const scheduler = withPolicyGroup(
        { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const },
        "admin",
      ),
      run = (action: Readonly<Record<string, unknown>>, binding = scheduler) =>
        cell!.run(action as never, binding) as Promise<Receipt>,
      show = async (scheduleId: string) =>
        ((await run({ kind: "schedule-show", scheduleId })) as unknown as { readonly schedule: ScheduleRow }).schedule;
    await seedBuiltinSchedules({ cell, binding: scheduler });
    assert.equal((await run(agentSchedule("agent-probe"))).outcome, "applied");

    const fired = await run({
      kind: "schedule-run-now",
      scheduleId: builtinLedgerBackupScheduleId,
      idempotencyKey: "center-builtin-fire",
    });
    assert.equal(fired.outcome, "applied", JSON.stringify(fired));
    assert.equal((await show(builtinLedgerBackupScheduleId)).status.lastRun?.outcome, "succeeded");

    // Each of N edges reaches the center through its own authenticated node identity; none can claim a builtin occurrence.
    for (const nodeId of ["edge-one", "edge-two"]) {
      const edge = await run(
        { kind: "schedule-run-now", scheduleId: builtinLedgerBackupScheduleId, idempotencyKey: `${nodeId}-fire` },
        { ...scheduler, source: { kind: "node", nodeId } },
      );
      assert.deepEqual([edge.outcome, edge.code], ["op_rejected", "schedule_builtin_local_only"], nodeId);
    }

    // The center is never the executor of an agent occurrence, whichever trigger action asks.
    for (const action of [
      { kind: "schedule-run-now", scheduleId: "agent-probe", idempotencyKey: "center-agent-fire" },
      {
        kind: "schedule-claim",
        scheduleId: "agent-probe",
        scheduledFor: "2026-10-02T03:17:00.000Z",
        idempotencyKey: "center-agent-claim",
      },
      {
        kind: "schedule-missed",
        scheduleId: "agent-probe",
        from: "2026-10-02T03:17:00.000Z",
        to: "2026-10-02T03:17:00.000Z",
        count: 1,
        reason: "scheduler_unavailable",
        observedDefinitionRevision: 1,
        idempotencyKey: "center-agent-missed",
      },
    ]) {
      const rejected = await run(action);
      assert.deepEqual([rejected.outcome, rejected.code], ["op_rejected", "repo_mode_requires_center_ingress"]);
    }
    assert.equal((await show("agent-probe")).status.activeRun, null);
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
