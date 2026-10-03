// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import workerThreads, { Worker } from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { readOfflineLedgerEvents, readVerifiedLedgerBackup } from "@harness-anything/kernel";
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

for (const mode of ["drill", "failure", "cleanup"]) {
  const corrupt = mode === "failure";
  test(
    `normal writes and duplicate claims complete while backup verification is held (${mode})`,
    { timeout: 15_000 },
    async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-backup-queue-")),
        cell = await openFixture(root),
        entered = Promise.withResolvers<void>();
      let release: (() => void) | undefined,
        launches = 0;
      const original = Worker.prototype.postMessage;
      const messageMock = t.mock.method(
        Worker.prototype,
        "postMessage",
        function (this: Worker, message: unknown, ...args: []) {
          if (mode !== "cleanup" && message && typeof message === "object" && "backupRoot" in message) {
            launches++;
            release = () => original.call(this, message, ...args);
            entered.resolve();
            return;
          }
          return original.call(this, message, ...args);
        },
      );
      const control = new Int32Array(new SharedArrayBuffer(4)),
        NativeWorker = Worker;
      const cleanupMock =
        mode === "cleanup"
          ? t.mock.method(workerThreads, "Worker", function (url: URL, options: workerThreads.WorkerOptions) {
              const worker = new NativeWorker(
                new URL("./schedule-backup-cleanup-barrier.fixture.ts", import.meta.url),
                {
                  ...options,
                  workerData: {
                    ...options.workerData,
                    moduleUrl: url.href,
                    control,
                    holdAt: path.join(root, scheduledLedgerBackupRoot, "ledger-backup-manual_000000000000000000000001"),
                  },
                },
              );
              const emit = worker.emit;
              worker.emit = (event: string | symbol, ...args: unknown[]): boolean => {
                if (event === "message" && args[0] && typeof args[0] === "object" && "cleanupHeld" in args[0]) {
                  entered.resolve();
                  return true;
                }
                return emit.call(worker, event, ...args);
              };
              launches++;
              release = () => {
                Atomics.store(control, 0, 2);
                Atomics.notify(control, 0);
              };
              return worker;
            })
          : undefined;
      if (cleanupMock) syncBuiltinESMExports();
      let backup: ReturnType<typeof cell.run> | undefined;
      const abort = () => release?.();
      t.signal.addEventListener("abort", abort, { once: true });
      try {
        await seedBuiltinSchedules({ cell, binding });
        const older = path.join(root, scheduledLedgerBackupRoot, "ledger-backup-manual_000000000000000000000001");
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
        const action = {
          kind: "schedule-run-now",
          scheduleId: builtinLedgerBackupScheduleId,
          idempotencyKey: "queue-run",
        };
        backup = cell.run(action, binding);
        await Promise.race([
          entered.promise,
          backup.then((receipt) => {
            throw new Error(`Backup ended before barrier: ${JSON.stringify(receipt)}`);
          }),
        ]);
        const name = readdirSync(path.join(root, scheduledLedgerBackupRoot)).find(
            (entry) => entry !== path.basename(older),
          ),
          backupDir = path.join(root, scheduledLedgerBackupRoot, name!),
          cut = readVerifiedLedgerBackup(backupDir);
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
        assert.equal(readVerifiedLedgerBackup(backupDir).accepted.revision, cut.accepted.revision);
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
        const result = await backup;
        assert.equal(result.outcome, "applied");
        assert.equal(result.code, corrupt ? "schedule_builtin_failed" : undefined);
        assert.equal((await replay).opId, result.opId);
        assert.equal(existsSync(older), corrupt);
        if (!corrupt) {
          const shadows = path.join(root, ".harness/restore-drills"),
            restored = readOfflineLedgerEvents({ rootInput: path.join(shadows, readdirSync(shadows)[0]!) });
          assert.equal(restored.length, cut.accepted.opIds);
          assert.equal(JSON.stringify(restored).includes("during-drill"), false);
        }
        const shown = (await cell.run(
          { kind: "schedule-show", scheduleId: builtinLedgerBackupScheduleId },
          binding,
        )) as unknown as { schedule: { status: { activeRun: unknown; lastRun: { outcome: string } } } };
        assert.equal(shown.schedule.status.activeRun, null);
        assert.equal(shown.schedule.status.lastRun.outcome, corrupt ? "failed" : "succeeded");
      } finally {
        release?.();
        await backup;
        await cell.close();
        messageMock.mock.restore();
        cleanupMock?.mock.restore();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
