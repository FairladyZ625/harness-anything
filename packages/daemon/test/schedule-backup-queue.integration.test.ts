// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe, mock } from "node:test";
import workerThreads, { Worker } from "node:worker_threads";
import { backupExecutionLimitMs } from "../src/schedule-backup-worker.ts";
import { syncBuiltinESMExports } from "node:module";
import { readOfflineLedgerEvents, readVerifiedLedgerBackup, type ScheduleV1 } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoWriterCell } from "../src/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../src/repo-cell-lock.ts";
import { openPersistentWriterEpoch, readLedgerWriterEpoch } from "../src/writer-epoch.ts";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";
import { initHarnessRepo } from "./schedule-actions.fixtures.ts";
import { provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import {
  builtinLedgerBackupScheduleId,
  scheduledLedgerBackupRoot,
  seedBuiltinSchedules,
} from "../src/schedule-builtin-executor.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "backup-test" }, executor: null }, source: "local" as const },
  "contributor",
);

async function openFixture(root: string) {
  const repoId = workspaceId("backup-queue");
  provisionPolicyTestRepository(repoId);
  initHarnessRepo(root, repoId);
  const stateRoot = path.join(root, ".epoch"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "backup-test" }),
    lease = authority.acquire(repoId, readLedgerWriterEpoch(repoId, root)),
    fence = {
      schema: "harness-writer-epoch-fence/v1" as const,
      stateRoot,
      repoId,
      holderId: lease.holderId,
      epoch: lease.epoch,
    };
  authority.close();
  await seedSettingsEvent({ repoId, rootDir: root, writerEpochFence: fence })?.drain();
  return openRepoWriterCell(
    {
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "backup-test",
      defaultWriterEpochFence: fence,
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "test",
        endpoint: path.join(root, ".daemon/test.sock"),
      },
      runtimeInstances: () => [],
      prepareWorkerGitEnvironment: async () => null,
    },
    await acquireWorkspaceLock(canonicalRoot(root)),
  );
}

for (const mode of ["manifest", "drill", "failure", "cleanup", "deadline", "capture-deadline"]) {
  const corrupt = mode === "failure";
  describe(`backup verification held (${mode})`, () => {
    let root: string,
      cell: Awaited<ReturnType<typeof openFixture>>,
      backup: ReturnType<Awaited<ReturnType<typeof openFixture>>["run"]> | undefined,
      older: string;
    const entered = Promise.withResolvers<void>(),
      action = {
        kind: "schedule-run-now",
        scheduleId: builtinLedgerBackupScheduleId,
        idempotencyKey: "queue-run",
      };
    let release: (() => void) | undefined,
      launches = 0;
    const spawned: Worker[] = [],
      deadlines: Array<() => void> = [],
      nativeSetTimeout = globalThis.setTimeout;
    let restoreMocks = () => {};
    after(
      async () => {
        release?.();
        try {
          await backup;
        } finally {
          try {
            await cell?.close();
          } finally {
            restoreMocks();
            if (root) rmSync(root, { recursive: true, force: true });
          }
        }
      },
      { timeout: 30_000 },
    );
    // Cold fixture/worker startup is separate from the 15-second invariant budget.
    before(
      async () => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-backup-queue-")));
        cell = await openFixture(root);
        const timerMock = mock.method(
          globalThis,
          "setTimeout",
          (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
            if (delay === backupExecutionLimitMs) deadlines.push(() => callback(...args));
            return nativeSetTimeout(callback, delay, ...args);
          },
        );
        const control = new Int32Array(new SharedArrayBuffer(4)),
          NativeWorker = Worker;
        const workerMock = mock.method(
          workerThreads,
          "Worker",
          function (url: URL, options: workerThreads.WorkerOptions) {
            if ((options?.workerData as { kind?: string } | undefined)?.kind !== "ledger-backup-verification") {
              return new NativeWorker(url, options);
            }
            const worker = new NativeWorker(
              launches === 0 ? new URL("./schedule-backup-cleanup-barrier.fixture.ts", import.meta.url) : url,
              {
                ...options,
                workerData: {
                  ...options.workerData,
                  moduleUrl: url.href,
                  control,
                  phase:
                    mode === "capture-deadline"
                      ? "capture"
                      : mode === "failure" || mode === "deadline"
                        ? "drill"
                        : mode,
                  root,
                  holdAt: path.join(root, scheduledLedgerBackupRoot, "ledger-backup-manual_000000000000000000000001"),
                },
              },
            );
            const emit = worker.emit;
            worker.emit = (event: string | symbol, ...args: unknown[]): boolean => {
              if (event === "message" && args[0] && typeof args[0] === "object" && "backupHeld" in args[0]) {
                entered.resolve();
                return true;
              }
              return emit.call(worker, event, ...args);
            };
            launches++;
            spawned.push(worker);
            release = () => {
              Atomics.store(control, 0, 2);
              Atomics.notify(control, 0);
            };
            return worker;
          },
        );
        restoreMocks = () => {
          timerMock.mock.restore();
          workerMock.mock.restore();
          syncBuiltinESMExports();
        };
        syncBuiltinESMExports();
        await seedBuiltinSchedules({ cell, binding });
        older = path.join(root, scheduledLedgerBackupRoot, "ledger-backup-manual_000000000000000000000001");
        mkdirSync(older, { recursive: true });
        writeFileSync(
          path.join(older, "manifest.json"),
          JSON.stringify({
            schema: "ledger-backup/v1",
            createdAt: "2020-01-01T00:00:00.000Z",
            registration: null,
            files: [],
          }),
        );
        await cell.run(
          {
            kind: "schedule-update",
            scheduleId: builtinLedgerBackupScheduleId,
            keepMonthly: false,
            idempotencyKey: "retention-policy",
          },
          binding,
        );
        backup = cell.run(action, binding);
        await Promise.race([
          entered.promise,
          backup.then((receipt) => {
            throw new Error(`Backup ended before barrier: ${JSON.stringify(receipt)}`);
          }),
        ]);
      },
      { timeout: 60_000 },
    );
    test(
      "normal writes and duplicate claims complete while backup verification is held",
      { timeout: 15_000 },
      async (t) => {
        if (mode === "deadline" || mode === "capture-deadline") {
          assert.equal(deadlines.length, 1);
          assert.notEqual(spawned[0]!.threadId, -1);
          deadlines[0]!();
          const result = await backup!;
          release = undefined;
          assert.equal(result.outcome, "applied");
          assert.equal(result.code, "schedule_builtin_failed");
          assert.equal(spawned[0]!.threadId, -1, "physical worker exited before settlement returns");
          const shown = (await cell.run(
            { kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId },
            binding,
          )) as unknown as { schedule: ScheduleV1 };
          assert.equal(shown.schedule.status.activeRun, null);
          assert.equal(shown.schedule.status.lastRun!.outcome, "failed");
          assert.match(shown.schedule.status.lastRun!.detail!, /backup worker exceeded 1800000ms/);
          const successor = await cell.run({ ...action, idempotencyKey: "after-expired-worker" }, binding);
          assert.equal(successor.outcome, "applied");
          assert.equal(successor.code, undefined);
          assert.equal(launches, 2);
          const next = (await cell.run(
            { kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId },
            binding,
          )) as unknown as { schedule: ScheduleV1 };
          assert.equal(next.schedule.status.activeRun, null);
          assert.equal(next.schedule.status.lastRun!.outcome, "succeeded");
          t.diagnostic(
            JSON.stringify({
              phase: mode,
              terminatedThread: spawned[0]!.threadId,
              outcome: shown.schedule.status.lastRun!.outcome,
              nextOutcome: next.schedule.status.lastRun!.outcome,
            }),
          );
          return;
        }
        const name = readdirSync(path.join(root, scheduledLedgerBackupRoot)).find(
            (entry) => entry !== path.basename(older),
          ),
          backupDir = path.join(root, scheduledLedgerBackupRoot, name!),
          cut =
            mode === "manifest"
              ? {
                  accepted: {
                    revision: readOfflineLedgerEvents({ rootInput: path.join(backupDir, "payload") }).length,
                  },
                  files: [],
                }
              : readVerifiedLedgerBackup(backupDir);
        if (mode === "manifest") assert.equal(existsSync(path.join(backupDir, "manifest.json")), false);
        const schedulePath = path.join(backupDir, "payload/harness/schedules", `${builtinLedgerBackupScheduleId}.json`),
          frozenSchedule = JSON.parse(readFileSync(schedulePath, "utf8")) as {
            spec: { target: { params: { keepDays: number } } };
          };
        const frozenEvents = readOfflineLedgerEvents({ rootInput: path.join(backupDir, "payload") }) as readonly {
            type: string;
            payload: { schedule: ScheduleV1 };
          }[],
          frozenClaim = frozenEvents.findLast((event) => event.type === "schedule_occurrence_claimed");
        assert.ok(frozenClaim);
        assert.equal(
          path.basename(backupDir),
          `ledger-backup-${frozenClaim.payload.schedule.status.activeRun!.occurrenceId}`,
        );
        assert.deepEqual(
          frozenSchedule.spec.target.params,
          frozenClaim.payload.schedule.spec.target.kind === "builtin"
            ? frozenClaim.payload.schedule.spec.target.params
            : undefined,
        );
        assert.equal(frozenSchedule.spec.target.params.keepDays, 3);
        assert.equal(cell.status().queueDepth, 0);
        const write = await cell.run(
          {
            kind: "schedule-update",
            scheduleId: builtinLedgerBackupScheduleId,
            keepDays: 7,
            idempotencyKey: "during-drill",
          },
          binding,
        );
        assert.equal(write.outcome, "applied");
        assert.ok((write.revision ?? 0) > cut.accepted.revision);
        assert.deepEqual(JSON.parse(readFileSync(schedulePath, "utf8")), frozenSchedule);
        if (mode !== "manifest")
          assert.equal(readVerifiedLedgerBackup(backupDir).accepted.revision, cut.accepted.revision);
        const read = await cell.run({ kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId }, binding);
        assert.equal(read.outcome, "applied");
        const replay = cell.run(action, binding);
        const duplicate = await cell.run({ ...action, idempotencyKey: "other-claim" }, binding);
        assert.equal(duplicate.outcome, "op_rejected");
        assert.equal(launches, 1);
        if (corrupt) {
          const file = cut.files.find((entry) => entry.method === "copy");
          assert.ok(file);
          writeFileSync(path.join(backupDir, "payload", file.path), "broken snapshot");
        }
        release!();
        release = undefined;
        const result = await backup!;
        assert.equal(result.outcome, "applied");
        assert.equal(result.code, corrupt ? "schedule_builtin_failed" : undefined);
        assert.equal(spawned[0]!.threadId, -1, "physical worker exited before settlement returns");
        assert.equal((await replay).opId, result.opId);
        assert.equal(existsSync(older), corrupt);
        if (!corrupt) {
          const shadows = path.join(root, ".harness/restore-drills"),
            restored = readOfflineLedgerEvents({ rootInput: path.join(shadows, readdirSync(shadows)[0]!) });
          assert.equal(restored.length, cut.accepted.revision);
          assert.equal(readVerifiedLedgerBackup(backupDir).accepted.revision, cut.accepted.revision);
          assert.equal(JSON.stringify(restored).includes("during-drill"), false);
        }
        const shown = (await cell.run(
          { kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId },
          binding,
        )) as unknown as { schedule: { status: { activeRun: unknown; lastRun: { outcome: string } } } };
        assert.equal(shown.schedule.status.activeRun, null);
        assert.equal(shown.schedule.status.lastRun.outcome, corrupt ? "failed" : "succeeded");
      },
    );
  });
}

// Cleanup may release a worker while it is still importing its executor module.
test("a barrier preserves release received before hold", { timeout: 15_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-backup-early-release-"))),
    control = new Int32Array(new SharedArrayBuffer(4)),
    source = path.join(root, "source"),
    destination = path.join(root, "payload", "copy");
  mkdirSync(path.dirname(destination));
  writeFileSync(source, "released");
  Atomics.store(control, 0, 2);
  const worker = new Worker(new URL("./schedule-backup-cleanup-barrier.fixture.ts", import.meta.url), {
    workerData: {
      control,
      phase: "capture",
      source,
      destination,
      moduleUrl: `data:text/javascript,${encodeURIComponent(
        'import { cpSync } from "node:fs"; import { workerData } from "node:worker_threads"; cpSync(workerData.source, workerData.destination);',
      )}`,
    },
  });
  t.after(async () => {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(await once(worker, "exit"), [0]);
  assert.equal(Atomics.load(control, 0), 2);
  assert.equal(readFileSync(destination, "utf8"), "released");
});
