import { existsSync, rmSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import {
  applyLedgerBackupRetention,
  readVerifiedLedgerBackup,
  type LedgerBackupRetentionPolicyV1,
  type CiObserveProgress,
  type ScheduleBuiltinParamsV1,
  type ScheduleV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { finishLedgerBackup, type BackupVerification, type BackupWorkerMessage } from "./schedule-backup-worker.ts";
import { backupRepo, drillRepoBackup } from "./repo-all-purge.ts";
import { cellErrorCode } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** Root (relative to the repository root) holding scheduled backups, per the established convention. */
export const scheduledLedgerBackupRoot = "tmp/harness-backup";
/** Deterministic schedule id of the system-seeded ledger backup. */
export const builtinLedgerBackupScheduleId = "builtin-ledger-backup";
export const builtinCiObserveScheduleId = "builtin-ci-observe";
export const builtinNightlyReckoningScheduleId = "builtin-nightly-reckoning";
/** Retention defaults when the schedule carries no explicit params. */
export const defaultLedgerBackupRetention: LedgerBackupRetentionPolicyV1 = { keepDays: 3, keepMonthly: true };

/** The executor's entire cell dependency: where the repository lives and what time it is. */
export interface BuiltinExecutorCell {
  readonly rootDir: string;
  readonly now: () => string;
  readonly observeCi: (schedule: ScheduleV1) => Promise<BuiltinExecutionResult>;
  readonly runSnapshot: <T>(work: () => T | PromiseLike<T>) => Promise<T>;
}

type RunInternal<Receipt extends WriteReceipt> = (action: RepoTaskAction, binding: RepoCellBinding) => Promise<Receipt>;

/** One registered in-process executor; the registry is a fixed map, not a plugin surface. */
type BuiltinExecutor = (input: {
  readonly cell: BuiltinExecutorCell;
  readonly schedule: ScheduleV1;
  readonly occurrenceId: string;
}) => Promise<BuiltinExecutionResult>;

export interface BuiltinExecutionResult {
  readonly outcome: "succeeded" | "failed";
  readonly detail: string;
  readonly ciObserve?: CiObserveProgress;
}

const builtinExecutors: Readonly<Record<string, BuiltinExecutor>> = Object.freeze({
  "ledger-backup": executeLedgerBackup,
  "ci-observe": ({ cell, schedule }) => cell.observeCi(schedule),
});

/**
 * Execute a claimed builtin after its claim leaves the write queue. Only runSnapshot
 * enters the queue for live-source capture. Validation, drill and retention run on a temporary
 * worker; settlement re-enters through the normal runner. No workspace or runtime is spawned.
 */
export async function executeBuiltinScheduleOccurrence<Receipt extends WriteReceipt>(input: {
  readonly cell: BuiltinExecutorCell;
  readonly schedule: ScheduleV1;
  readonly idempotencyKey: string;
  readonly binding: RepoCellBinding;
  readonly runInternal: RunInternal<Receipt>;
}): Promise<Receipt> {
  const active = input.schedule.status.activeRun,
    target = input.schedule.spec.target,
    executor = target.kind === "builtin" ? builtinExecutors[target.builtinId] : undefined;
  if (target.kind !== "builtin" || !active)
    throw new Error(`Schedule ${input.schedule.scheduleId} has no built-in occurrence to execute.`);
  // Every terminal branch settles the occurrence — a thrown executor error becomes the settle
  // detail of a failed outcome, never a swallowed failure or an abandoned claim.
  const settleOccurrence = async (result: BuiltinExecutionResult): Promise<Receipt> => {
    const settled = await input
      .runInternal(
        {
          kind: "schedule-settle",
          scheduleId: input.schedule.scheduleId,
          claimFence: active.claimFence,
          outcome: result.outcome,
          endedAt: input.cell.now(),
          detail: result.detail,
          ...(result.ciObserve ? { ciObserve: result.ciObserve } : {}),
          idempotencyKey: `${input.idempotencyKey}:builtin-${result.outcome}`,
        },
        input.binding,
      )
      .catch((error: unknown) => {
        console.warn(
          `[schedule-builtin] ${input.schedule.scheduleId}/${active.claimFence} settlement failed: ${cellErrorCode(error)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
    if (settled.outcome !== "applied" && settled.outcome !== "no_changes") {
      console.warn(
        `[schedule-builtin] ${input.schedule.scheduleId}/${active.claimFence} settlement rejected: ${settled.code ?? settled.outcome}.`,
      );
      return settled;
    }
    return result.outcome === "succeeded" ? settled : ({ ...settled, code: "schedule_builtin_failed" } as Receipt);
  };
  if (executor === undefined)
    return settleOccurrence({
      outcome: "failed",
      detail: `builtin ${target.builtinId} is not registered on this daemon`,
    });
  return settleOccurrence(await runRegisteredBuiltin(executor, input.cell, input.schedule, active.occurrenceId));
}

/** An executor error becomes the settle detail of a failed outcome — never a swallowed failure. */
async function runRegisteredBuiltin(
  executor: BuiltinExecutor,
  cell: BuiltinExecutorCell,
  schedule: ScheduleV1,
  occurrenceId: string,
): Promise<BuiltinExecutionResult> {
  try {
    return await executor({ cell, schedule, occurrenceId });
  } catch (error) {
    const builtinId = schedule.spec.target.kind === "builtin" ? schedule.spec.target.builtinId : "?";
    return {
      outcome: "failed",
      detail: `builtin ${builtinId} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Snapshot, restore-drill, then retention cleanup — each step timed, failures named. */
async function executeLedgerBackup(input: {
  readonly cell: BuiltinExecutorCell;
  readonly schedule: ScheduleV1;
  readonly occurrenceId: string;
}): Promise<BuiltinExecutionResult> {
  const target = input.schedule.spec.target;
  if (target.kind !== "builtin") throw new Error("ledger-backup requires a builtin target");
  const policy = retentionOf(target.params),
    backupRoot = path.join(input.cell.rootDir, scheduledLedgerBackupRoot),
    backupDir = path.join(backupRoot, `ledger-backup-${input.occurrenceId}`),
    startedAt = performance.now();
  const { reusedSnapshot, bytes, backupMs, captureMs, drillMs, cleanupMs, retention } = await finishLedgerBackup(
    {
      rootDir: input.cell.rootDir,
      backupDir,
      backupRoot,
      now: input.cell.now(),
      policy,
    },
    input.cell.runSnapshot,
  );
  return {
    outcome: "succeeded",
    detail: JSON.stringify({
      builtin: target.builtinId,
      backupDir: path.relative(input.cell.rootDir, backupDir),
      ...(reusedSnapshot ? { reusedSnapshot: true } : { bytes }),
      backupMs,
      captureMs,
      drillMs,
      cleanupMs,
      removed: retention.removed.length,
      retained: retention.retained.length,
      ...(retention.skipped.length ? { skipped: retention.skipped.length } : {}),
      ...(retention.warnings.length ? { warnings: retention.warnings } : {}),
      totalMs: Math.round(performance.now() - startedAt),
    }),
  };
}

function retentionOf(params: ScheduleBuiltinParamsV1 | undefined): LedgerBackupRetentionPolicyV1 {
  return {
    keepDays: params?.keepDays ?? defaultLedgerBackupRetention.keepDays,
    keepMonthly: params?.keepMonthly ?? defaultLedgerBackupRetention.keepMonthly,
  };
}

/**
 * Seed the system builtin schedules through authenticated init/configure. The create rides the
 * cell's single write queue with a deterministic schedule id and idempotency key, so two
 * attaches converge on one schedule: the second either replays the same operation or meets
 * entity_exists. Seeding belongs to the node holding the canonical cell — fleet mirror cells
 * never seed.
 */
export async function seedBuiltinSchedules(input: {
  readonly cell: {
    readonly run: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<unknown> | unknown;
  };
  readonly binding: RepoCellBinding;
}): Promise<void> {
  const seeds: readonly RepoTaskAction[] = [
    {
      kind: "schedule-create",
      scheduleId: builtinLedgerBackupScheduleId,
      name: "Ledger backup",
      mode: "detect",
      cronExpression: "17 3 * * *",
      timezone: "UTC",
      builtinId: "ledger-backup",
      systemPresetId: "ledger-backup",
      keepDays: defaultLedgerBackupRetention.keepDays,
      keepMonthly: defaultLedgerBackupRetention.keepMonthly,
      mission: "System ledger backup: snapshot, restore drill, retention cleanup.",
      idempotencyKey: `builtin-seed:${builtinLedgerBackupScheduleId}:v1`,
    },
    {
      kind: "schedule-create",
      scheduleId: builtinCiObserveScheduleId,
      name: "CI observation",
      mode: "detect",
      everyMs: 60_000,
      builtinId: "ci-observe",
      systemPresetId: "ci-observe",
      mission: "Reconcile GitHub workflow witnesses and diagnostic artifacts through the center occurrence.",
      idempotencyKey: `builtin-seed:${builtinCiObserveScheduleId}:v1`,
    },
    {
      kind: "schedule-create",
      scheduleId: builtinNightlyReckoningScheduleId,
      name: "Nightly reckoning",
      mode: "detect",
      cronExpression: "30 23 * * *",
      timezone: "UTC",
      systemPresetId: "nightly-reckoning",
      unconfiguredAgent: true,
      disabled: true,
      mission:
        "Run `ha schedule reckon` and review the general ledger signals from the most recent window. Open the " +
        "evidence behind each candidate and group items with the same cause. First ask whether the mechanism creating the friction can be fixed; then " +
        "whether an existing rule can be removed; only then consider a new rule with an explicit expiry condition. " +
        "Treat the second occurrence of the same class as a structural problem. Report no finding when the evidence " +
        "does not justify one.",
      idempotencyKey: `builtin-seed:${builtinNightlyReckoningScheduleId}:v1`,
    },
  ];
  for (const seed of seeds) {
    const receipt = (await input.cell.run(seed, input.binding)) as {
      readonly outcome?: unknown;
      readonly code?: unknown;
    };
    if (receipt.outcome === "applied" || receipt.outcome === "no_changes" || receipt.code === "entity_exists") continue;
    throw new Error(
      `[schedule-builtin] seeding ${seed.scheduleId} was ${String(receipt.outcome)}` +
        `${receipt.code ? ` (${String(receipt.code)})` : ""}; retry through authenticated init/configure.`,
    );
  }
}

if (!isMainThread && workerData?.kind === "ledger-backup-verification" && parentPort) {
  parentPort.once("message", async (input: BackupVerification) => {
    let phase = "prepare";
    try {
      const backupStartedAt = performance.now(),
        reusedSnapshot = existingSnapshotIsVerified(input.backupDir);
      parentPort!.postMessage({ kind: "prepared" } satisfies BackupWorkerMessage);
      // Even a reused snapshot must pass the current writer and occurrence claim fence.
      await new Promise<void>((resolve) => parentPort!.once("message", () => resolve()));
      let captureMs = 0;
      phase = "snapshot";
      const captureStartedAt = performance.now(),
        snapshotCaptured = () => {
          captureMs = reusedSnapshot ? 0 : Math.round(performance.now() - captureStartedAt);
          parentPort!.postMessage({ kind: "captured" } satisfies BackupWorkerMessage);
          phase = "validation";
        };
      if (reusedSnapshot) snapshotCaptured();
      const manifest = reusedSnapshot ? null : backupRepo({ ...input, onSnapshotCaptured: snapshotCaptured }),
        backupMs = Math.round(performance.now() - backupStartedAt);
      phase = "drill";
      const drillStartedAt = performance.now();
      drillRepoBackup({ rootDir: input.rootDir, backupDir: input.backupDir });
      const drillMs = Math.round(performance.now() - drillStartedAt);
      phase = "cleanup";
      const cleanupStartedAt = performance.now(),
        retention = applyLedgerBackupRetention({
          backupRoot: input.backupRoot,
          now: input.now,
          policy: input.policy,
          protectedDirs: [input.backupDir],
        }),
        cleanupMs = Math.round(performance.now() - cleanupStartedAt);
      parentPort!.postMessage({
        kind: "result",
        result: {
          reusedSnapshot,
          bytes: manifest?.files.reduce((total, file) => total + file.size, 0) ?? 0,
          backupMs,
          captureMs,
          drillMs,
          cleanupMs,
          retention,
        },
      } satisfies BackupWorkerMessage);
      parentPort!.close();
    } catch (error) {
      throw new Error(`ledger-backup ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  });
}

/** Complete occurrence output is immutable; partial output belongs to this occurrence alone. */
function existingSnapshotIsVerified(backupDir: string): boolean {
  if (!existsSync(backupDir)) return false;
  try {
    readVerifiedLedgerBackup(backupDir);
  } catch {
    rmSync(backupDir, { recursive: true, force: true });
    return false;
  }
  return true;
}
