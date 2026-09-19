// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createScheduleV1,
  readVerifiedLedgerBackup,
  type ScheduleV1,
  registerDaemonRepo,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { definition, initHarnessRepo } from "./schedule-actions.fixtures.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import {
  builtinLedgerBackupScheduleId,
  executeBuiltinScheduleOccurrence,
  scheduledLedgerBackupRoot,
  seedBuiltinSchedules,
} from "../src/schedule-builtin-executor.ts";

type WriteReceipt = { readonly outcome: string; readonly opId: string; readonly revision: number };

const actor = withRoleBinding(
  { actor: { principal: { personId: "builtin-schedule-operator" }, executor: null }, source: "local" as const },
  "repo-write",
);
const dayMs = 86_400_000;

/** A retention fixture backup: an executor-named directory with a readable manifest. */
function fixtureBackup(root: string, name: string, createdAt: string): string {
  const dir = path.join(root, scheduledLedgerBackupRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ schema: "ledger-backup/v1", createdAt, registration: null, files: [] }),
  );
  return dir;
}

async function runsOf(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  scheduleId: string,
): Promise<
  readonly {
    outcome: string;
    detail: string | null;
  }[]
> {
  const receipt = (await cell.run({ kind: "schedule-runs", scheduleId, limit: 10 }, actor)) as {
    evidence?: string;
  };
  if (typeof receipt.evidence !== "string")
    throw new Error(`schedule-runs receipt carried no evidence: ${JSON.stringify(receipt)}`);
  return (JSON.parse(receipt.evidence) as { runs: readonly { outcome: string; detail: string | null }[] }).runs;
}

test("the seeded ledger-backup builtin executes in-process and settles with drilled, retained backups", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-builtin-"));
  let launchCount = 0;
  try {
    initHarnessRepo(root, "builtin-backup");
    const cell = await openRepoCell({
      repoId: workspaceId("builtin-backup"),
      rootDir: canonicalRoot(root),
      ownerId: "builtin-backup-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "builtin-backup-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Schedule Codex",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (_instanceId, request) => {
        launchCount += 1;
        return {
          definition,
          installation: {
            installationId: definition.installationId,
            kindId: definition.kindId,
            executablePath: "/opt/test/codex",
            version: "1.0.0",
            observedAt: "2026-09-19T00:00:00.000Z",
          },
          executablePath: "/opt/test/codex",
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      prepareWorkerGitEnvironment: async () => null,
      runtimeLaunch: () => ({
        pid: 4601,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    try {
      // Seeding is idempotent: two attaches converge on exactly one system schedule.
      await seedBuiltinSchedules({ cell, binding: actor });
      await seedBuiltinSchedules({ cell, binding: actor });
      const seeded = (await cell.run({ kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId }, actor)) as {
        schedule: { state: string; spec: { target: { kind: string; builtinId: string } } };
      };
      assert.equal(seeded.schedule.state, "armed");
      assert.equal(seeded.schedule.spec.target.kind, "builtin");
      assert.equal(seeded.schedule.spec.target.builtinId, "ledger-backup");
      const listed = (await cell.run({ kind: "schedule-list" }, actor)) as { schedules: readonly unknown[] };
      assert.equal(listed.schedules.length, 1);

      // Retention fixtures: the 7-day-old backup is always deletable (its month always has a
      // newer sibling among the older trio); the fresh in-window one always survives.
      const now = Date.now();
      fixtureBackup(root, "ledger-backup-occurrence_00a00a0a0a0a0a0a0a0a0a01", new Date(now - dayMs).toISOString());
      fixtureBackup(root, "ledger-backup-occurrence_00a00a0a0a0a0a0a0a0a0a05", new Date(now - 5 * dayMs).toISOString());
      fixtureBackup(root, "ledger-backup-occurrence_00a00a0a0a0a0a0a0a0a0a06", new Date(now - 6 * dayMs).toISOString());
      const oldest = fixtureBackup(
        root,
        "ledger-backup-occurrence_00a00a0a0a0a0a0a0a0a0a07",
        new Date(now - 7 * dayMs).toISOString(),
      );
      // A directory the executor never named, and an executor-named one without a readable
      // manifest: neither may be deleted.
      const foreign = fixtureBackup(root, "nightly-agent-backup", new Date(now - 300 * dayMs).toISOString());
      const unidentified = fixtureBackup(
        root,
        "ledger-backup-manual_00b00b0b0b0b0b0b0b0b0b02",
        new Date(now - 300 * dayMs).toISOString(),
      );
      rmSync(path.join(unidentified, "manifest.json"));

      const receipt = (await cell.run(
        { kind: "schedule-run-now", scheduleId: builtinLedgerBackupScheduleId, idempotencyKey: "builtin-run-1" },
        actor,
      )) as { outcome: string; code?: string };
      assert.equal(receipt.outcome, "applied");
      // The builtin path never spawns a runtime and never prepares an occurrence worktree.
      assert.equal(launchCount, 0);
      assert.equal(existsSync(path.join(root, ".worktrees")), false);

      const [run] = await runsOf(cell, builtinLedgerBackupScheduleId);
      assert.equal(run.outcome, "succeeded");
      const detail = JSON.parse(run.detail ?? "{}") as {
        builtin: string;
        backupDir: string;
        bytes: number;
        backupMs: number;
        drillMs: number;
        cleanupMs: number;
        removed: number;
        retained: number;
        skipped: number;
      };
      assert.equal(detail.builtin, "ledger-backup", `settle detail was: ${run.detail}`);
      assert.equal(detail.bytes > 0, true, `settle detail was: ${run.detail}`);
      assert.ok(
        detail.backupMs >= 0 && detail.drillMs >= 0 && detail.cleanupMs >= 0,
        `settle detail was: ${run.detail}`,
      );
      assert.equal(detail.removed >= 1, true);
      assert.equal(detail.skipped, 1);
      const backupDir = path.join(root, detail.backupDir);
      assert.equal(/^ledger-backup-manual_[0-9a-f]{24}$/u.test(path.basename(backupDir)), true);
      assert.deepEqual(readVerifiedLedgerBackup(backupDir).schema, "ledger-backup/v1");
      // Retention deleted exactly the planned old backup; everything protected survived.
      assert.equal(existsSync(oldest), false);
      assert.equal(
        existsSync(path.join(root, scheduledLedgerBackupRoot, "ledger-backup-occurrence_00a00a0a0a0a0a0a0a0a0a01")),
        true,
      );
      assert.equal(existsSync(foreign), true);
      assert.equal(existsSync(unidentified), true);

      // A built-in Schedule cannot be deleted, but its cadence and retention can change.
      const deleted = (await cell.run(
        { kind: "schedule-delete", scheduleId: builtinLedgerBackupScheduleId, idempotencyKey: "builtin-delete-1" },
        actor,
      )) as { outcome: string; code?: string };
      assert.deepEqual(
        { outcome: deleted.outcome, code: deleted.code },
        {
          outcome: "op_rejected",
          code: "schedule_builtin_protected",
        },
      );
      const updated = (await cell.run(
        {
          kind: "schedule-update",
          scheduleId: builtinLedgerBackupScheduleId,
          cronExpression: "30 4 * * *",
          timezone: "UTC",
          keepDays: 5,
          idempotencyKey: "builtin-update-1",
        },
        actor,
      )) as { outcome: string };
      assert.equal(updated.outcome, "applied");
      const after = (await cell.run({ kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId }, actor)) as {
        schedule: { spec: { target: { params: { keepDays: number } } } };
      };
      assert.equal(after.schedule.spec.target.params.keepDays, 5);
      const retargeted = (await cell.run(
        {
          kind: "schedule-update",
          scheduleId: builtinLedgerBackupScheduleId,
          agentId: "probe-agent",
          runtimeInstanceId: definition.instanceId,
          idempotencyKey: "builtin-update-2",
        },
        actor,
      )) as { outcome: string; code?: string };
      assert.deepEqual(
        { outcome: retargeted.outcome, code: retargeted.code },
        {
          outcome: "op_rejected",
          code: "schedule_builtin_definition_fixed",
        },
      );

      // An edge assignment can never claim a built-in occurrence.
      const edge = (await cell.run(
        { kind: "schedule-run-now", scheduleId: builtinLedgerBackupScheduleId, idempotencyKey: "builtin-edge-1" },
        {
          ...actor,
          source: { kind: "assignment", nodeId: "edge-node", assignmentId: "assignment-edge" },
        },
      )) as { outcome: string; code?: string };
      assert.deepEqual(
        { outcome: edge.outcome, code: edge.code },
        {
          outcome: "op_rejected",
          code: "schedule_builtin_local_only",
        },
      );

      // An unregistered builtin settles failed, naming the executor — it does not hang the claim.
      assert.equal(
        (
          (await cell.run(
            {
              kind: "schedule-create",
              scheduleId: "builtin-unknown",
              name: "Unknown builtin",
              mode: "detect",
              everyMs: 3_600_000,
              builtinId: "not-registered",
              mission: "Never registered.",
              idempotencyKey: "builtin-unknown-1",
            },
            actor,
          )) as { outcome: string }
        ).outcome,
        "applied",
      );
      const failed = (await cell.run(
        { kind: "schedule-run-now", scheduleId: "builtin-unknown", idempotencyKey: "builtin-unknown-run-1" },
        actor,
      )) as { outcome: string; code?: string };
      assert.equal(failed.outcome, "applied");
      assert.equal(failed.code, "schedule_builtin_failed");
      const [failedRun] = await runsOf(cell, "builtin-unknown");
      assert.equal(failedRun.outcome, "failed");
      assert.match(failedRun.detail ?? "", /not registered/u);
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partially written backup of the same occurrence is retaken, a verified one reused", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-builtin-resume-"));
  try {
    initHarnessRepo(root, "builtin-resume");
    const cell = await openRepoCell({
      repoId: workspaceId("builtin-resume"),
      rootDir: canonicalRoot(root),
      ownerId: "builtin-resume-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "builtin-resume-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [],
      prepareWorkerGitEnvironment: async () => null,
    });
    try {
      // Crash recovery rides the executor directly: a replayed claim re-enters with the same
      // occurrence, whose occurrence-keyed backup directory may already exist on disk.
      const occurredAt = "2026-09-19T03:17:00.000Z";
      const base = createScheduleV1({
        scheduleId: builtinLedgerBackupScheduleId,
        name: "Ledger backup",
        mode: "detect",
        spec: {
          trigger: { kind: "cron", expression: "17 3 * * *", timezone: "UTC" },
          target: { kind: "builtin", builtinId: "ledger-backup", params: { keepDays: 3, keepMonthly: true } },
          mission: "System ledger backup.",
        },
        actor: actor.actor,
        occurredAt,
      });
      const claimed: ScheduleV1 = {
        ...base,
        status: {
          ...base.status,
          activeRun: {
            occurrenceId: "manual_00c00c0c0c0c0c0c0c0c0c0c",
            kind: "manual",
            scheduledFor: occurredAt,
            claimedAt: occurredAt,
            nodeId: "local",
            assignmentId: null,
            claimFence: "claim_resumed",
            attemptIndex: 0,
          },
        },
      };
      const settledActions: RepoTaskAction[] = [];
      const settleThrough = async (action: RepoTaskAction): Promise<WriteReceipt> => {
        settledActions.push(action);
        return { outcome: "applied", opId: `op-${settledActions.length}`, revision: settledActions.length };
      };
      const executorCell = { rootDir: canonicalRoot(root), now: () => new Date().toISOString() };
      // A previous attempt died mid-copy: the partial directory is owned by this very
      // occurrence and must be removed and retaken, not drilled against.
      const partial = path.join(
        root,
        scheduledLedgerBackupRoot,
        claimed.status.activeRun!.occurrenceId.replace("manual_", "ledger-backup-"),
      );
      mkdirSync(partial, { recursive: true });
      writeFileSync(path.join(partial, "ledger.sqlite"), "half a copy");
      const retaken = await executeBuiltinScheduleOccurrence({
        cell: executorCell,
        schedule: claimed,
        idempotencyKey: "builtin-resume",
        binding: actor,
        runInternal: settleThrough,
      });
      assert.equal(retaken.code, undefined);
      const retakenDetail = JSON.parse(String(settledActions.at(-1)?.detail)) as {
        reusedSnapshot?: boolean;
        bytes: number;
      };
      assert.equal(retakenDetail.reusedSnapshot, undefined);
      assert.equal(retakenDetail.bytes > 0, true);
      // The settled occurrence re-executes (a replayed claim after a crash before settle):
      // the verified snapshot is reused and the drill still runs against it.
      const reused = await executeBuiltinScheduleOccurrence({
        cell: executorCell,
        schedule: claimed,
        idempotencyKey: "builtin-resume",
        binding: actor,
        runInternal: settleThrough,
      });
      assert.equal(reused.code, undefined);
      const reusedDetail = JSON.parse(String(settledActions.at(-1)?.detail)) as { reusedSnapshot?: boolean };
      assert.equal(reusedDetail.reusedSnapshot, true);
      assert.equal(settledActions.length, 2);
      for (const action of settledActions) assert.equal(action.kind, "schedule-settle");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a registered local repo seeds one builtin schedule across attaches and runs it from the daemon host",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-builtin-seed-")),
      repo = path.join(root, "repo"),
      userRoot = path.join(root, "user"),
      repoId = "builtin-seed",
      localAuth = {
        transportKind: "unix-socket" as const,
        unixSocketOwnerBoundary: {
          ownerUid: process.getuid?.() ?? 0,
          source: "unix-socket-filesystem-owner-boundary" as const,
        },
      };
    try {
      initHarnessRepo(repo, "builtin-seed");
      writeFileSync(
        path.join(repo, "harness/people.yaml"),
        `${JSON.stringify(
          {
            schema: "harness-people/v1",
            people: [
              {
                personId: "owner",
                displayName: "Owner",
                roles: ["owner"],
                credentials: [
                  {
                    kind: "unix-socket-owner-boundary",
                    issuer: `host:${hostname()}`,
                    subject: String(process.getuid?.() ?? 0),
                  },
                ],
              },
            ],
            roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }],
          },
          null,
          2,
        )}\n`,
      );
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["-C", repo, "add", "harness"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "commit", "-qm", "people"], { stdio: "ignore" });
      registerDaemonRepo({
        canonicalRoot: repo,
        repoId,
        mode: "local",
        userRoot,
        createConvenienceLinks: false,
      });
      let host = await openDaemonHost({ daemonId: "builtin-seed-test", userRoot });
      try {
        await host.attachmentsSettled();
        const first = (await host.run(repoId, { kind: "schedule-list" }, localAuth)) as {
          schedules: readonly { scheduleId: string }[];
        };
        assert.deepEqual(
          first.schedules.map(({ scheduleId }) => scheduleId),
          [builtinLedgerBackupScheduleId],
        );
        const run = (await host.run(
          repoId,
          { kind: "schedule-run-now", scheduleId: builtinLedgerBackupScheduleId, idempotencyKey: "seed-run-1" },
          localAuth,
        )) as { outcome: string; code?: string };
        assert.equal(run.outcome, "applied", JSON.stringify(run));
        assert.equal(run.code, undefined);
        const backups = readdirSync(path.join(repo, scheduledLedgerBackupRoot));
        assert.equal(backups.length, 1);
        assert.match(backups[0] ?? "", /^ledger-backup-manual_[0-9a-f]{24}$/u);
        await host.close();
        // A second attach converges on the same single seeded schedule — no duplicates.
        host = await openDaemonHost({ daemonId: "builtin-seed-test", userRoot });
        await host.attachmentsSettled();
        const second = (await host.run(repoId, { kind: "schedule-list" }, localAuth)) as {
          schedules: readonly { scheduleId: string }[];
        };
        assert.deepEqual(
          second.schedules.map(({ scheduleId }) => scheduleId),
          [builtinLedgerBackupScheduleId],
        );
      } finally {
        await host.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
