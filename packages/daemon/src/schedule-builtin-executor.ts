import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  applyLedgerBackupRetention,
  readVerifiedLedgerBackup,
  type LedgerBackupRetentionPolicyV1,
  type ScheduleBuiltinParamsV1,
  type ScheduleV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { backupRepo, drillRepoBackup } from "./repo-all-purge.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** Root (relative to the repository root) holding scheduled backups, per the established convention. */
export const scheduledLedgerBackupRoot = "tmp/harness-backup";
/** Deterministic schedule id of the system-seeded ledger backup. */
export const builtinLedgerBackupScheduleId = "builtin-ledger-backup";
export const builtinNightlyReckoningScheduleId = "builtin-nightly-reckoning";
/** Retention defaults when the schedule carries no explicit params. */
export const defaultLedgerBackupRetention: LedgerBackupRetentionPolicyV1 = { keepDays: 3, keepMonthly: true };

/** The executor's entire cell dependency: where the repository lives and what time it is. */
export interface BuiltinExecutorCell {
  readonly rootDir: string;
  readonly now: () => string;
}

type RunInternal = (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>;

/** One registered in-process executor; the registry is a fixed map, not a plugin surface. */
type BuiltinExecutor = (input: {
  readonly cell: BuiltinExecutorCell;
  readonly schedule: ScheduleV1;
  readonly occurrenceId: string;
}) => Promise<BuiltinExecutionResult>;

export interface BuiltinExecutionResult {
  readonly outcome: "succeeded" | "failed";
  readonly detail: string;
}

const builtinExecutors: Readonly<Record<string, BuiltinExecutor>> = Object.freeze({
  "ledger-backup": executeLedgerBackup,
});

/**
 * Execute a claimed builtin occurrence in-process and settle it. The caller is the write-queue
 * turn of the claiming run-now action, so the backup runs serialized against every other ledger
 * write — exactly the serialization `cell.backup` would add — without re-entering the queue.
 * No occurrence workspace is prepared and no runtime is spawned.
 */
export async function executeBuiltinScheduleOccurrence(input: {
  readonly cell: BuiltinExecutorCell;
  readonly schedule: ScheduleV1;
  readonly idempotencyKey: string;
  readonly binding: RepoCellBinding;
  readonly runInternal: RunInternal;
}): Promise<WriteReceipt> {
  const active = input.schedule.status.activeRun,
    target = input.schedule.spec.target,
    executor = target.kind === "builtin" ? builtinExecutors[target.builtinId] : undefined;
  if (target.kind !== "builtin" || !active)
    throw new Error(`Schedule ${input.schedule.scheduleId} has no built-in occurrence to execute.`);
  // Every terminal branch settles the occurrence — a thrown executor error becomes the settle
  // detail of a failed outcome, never a swallowed failure or an abandoned claim.
  const settleOccurrence = async (result: BuiltinExecutionResult): Promise<WriteReceipt> => {
    const settled = await input.runInternal(
      {
        kind: "schedule-settle",
        scheduleId: input.schedule.scheduleId,
        claimFence: active.claimFence,
        outcome: result.outcome,
        endedAt: input.cell.now(),
        detail: result.detail,
        idempotencyKey: `${input.idempotencyKey}:builtin-${result.outcome}`,
      },
      input.binding,
    );
    return result.outcome === "succeeded" ? settled : ({ ...settled, code: "schedule_builtin_failed" } as WriteReceipt);
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
  let bytes = 0;
  const reusedSnapshot = existingSnapshotIsVerified(backupDir);
  const backupStartedAt = performance.now();
  if (!reusedSnapshot) {
    const manifest = await backupRepo({ rootDir: input.cell.rootDir, backupDir });
    bytes = manifest.files.reduce((total, file) => total + file.size, 0);
  }
  const backupMs = Math.round(performance.now() - backupStartedAt),
    drillStartedAt = performance.now();
  await drillRepoBackup({ rootDir: input.cell.rootDir, backupDir });
  const drillMs = Math.round(performance.now() - drillStartedAt),
    // The drill verified this backup; only then is older data eligible for cleanup.
    cleanupStartedAt = performance.now(),
    retention = applyLedgerBackupRetention({
      backupRoot,
      now: input.cell.now(),
      policy,
      protectedDirs: [backupDir],
    }),
    cleanupMs = Math.round(performance.now() - cleanupStartedAt);
  return {
    outcome: "succeeded",
    detail: JSON.stringify({
      builtin: target.builtinId,
      backupDir: path.relative(input.cell.rootDir, backupDir),
      ...(reusedSnapshot ? { reusedSnapshot: true } : { bytes }),
      backupMs,
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
 * A previous attempt of this occurrence may have died after the snapshot: a verifiable
 * backup is reused, so crash recovery resumes at the drill instead of failing forever.
 * Unverifiable output of this very occurrence (its name is occurrence-keyed) is partial
 * and owned by this run; it is removed so the snapshot is taken again.
 */
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

/**
 * Seed the system builtin schedules on a freshly attached local cell. The create rides the
 * cell's single write queue with a deterministic schedule id and idempotency key, so two
 * attaches converge on one schedule: the second either replays the same operation or meets
 * entity_exists. Seeding stays a local-mode concern — fleet mirror cells never seed.
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
    console.warn(
      `[schedule-builtin] seeding ${seed.scheduleId} was ${String(receipt.outcome)}` +
        `${receipt.code ? ` (${String(receipt.code)})` : ""}; retrying on the next attach.`,
    );
  }
}
