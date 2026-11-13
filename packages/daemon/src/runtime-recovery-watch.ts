import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type { RuntimeRecoveryResult } from "./runtime-spawn-adoption.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";

/** One runtime a recovery scan could not adopt or settle; its siblings were still recovered. */
export interface RuntimeRecoveryFailure {
  readonly runtimeSessionId: string;
  readonly dispatchId: string | null;
  readonly code: string;
  readonly message: string;
}

export interface StuckRuntimeRecovery extends RuntimeRecoveryFailure {
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
}

/** A transient failure clears on the next confirmed position; one that outlives this is an owner's problem. */
export const RUNTIME_RECOVERY_STUCK_AFTER_MS = daemonRuntimePolicy.defaultValue.runtime.recoveryStuckAfterMs;

/** The scan's failures as one error that names every failed runtime and its own error code. */
export function runtimeRecoveryError(results: readonly RuntimeRecoveryResult[]): Error | null {
  const failed = results.filter((result) => result.outcome === "failed");
  if (failed.length === 0) return null;
  const failures = failed.map(
    (result): RuntimeRecoveryFailure => ({
      runtimeSessionId: result.runtimeSessionId,
      dispatchId: result.dispatchId,
      code: runtimeErrorCode(result.error) ?? "runtime_recovery_failed",
      message: runtimeErrorMessage(result.error),
    }),
  );
  return Object.assign(
    new Error(
      `Runtime recovery failed for ${String(failures.length)} runtime(s): ` +
        failures.map((failure) => `${failure.runtimeSessionId} [${failure.code}] ${failure.message}`).join("; "),
      { cause: failed.length === 1 ? failed[0]!.error : new AggregateError(failed.map((result) => result.error)) },
    ),
    // A single failure keeps its own code, so a direct caller still sees what went wrong.
    { code: failures.length === 1 ? failures[0]!.code : "runtime_recovery_failed", recoveryFailures: failures },
  );
}

/** Per-runtime failures carried by a scan error; null when the scan itself failed before any verdict. */
export function runtimeRecoveryFailuresOf(error: unknown): readonly RuntimeRecoveryFailure[] | null {
  if (typeof error !== "object" || error === null || !("recoveryFailures" in error)) return null;
  return error.recoveryFailures as readonly RuntimeRecoveryFailure[];
}

export interface RuntimeRecoveryWatch {
  /** A completed scan replaces the repository's failing set; null keeps it when the scan reached no verdict. */
  readonly observe: (repoId: string, failures: readonly RuntimeRecoveryFailure[] | null, at: string) => void;
  readonly stuck: (repoId: string, at: string) => readonly StuckRuntimeRecovery[];
}

export function openRuntimeRecoveryWatch(): RuntimeRecoveryWatch {
  const repos = new Map<string, ReadonlyMap<string, StuckRuntimeRecovery>>();
  return {
    observe: (repoId, failures, at) => {
      if (failures === null) return;
      const previous = repos.get(repoId);
      repos.set(
        repoId,
        new Map(
          failures.map((failure) => [
            failure.runtimeSessionId,
            {
              ...failure,
              firstFailedAt: previous?.get(failure.runtimeSessionId)?.firstFailedAt ?? at,
              lastFailedAt: at,
            },
          ]),
        ),
      );
    },
    stuck: (repoId, at) =>
      [...(repos.get(repoId)?.values() ?? [])].filter(
        (row) => Date.parse(at) - Date.parse(row.firstFailedAt) >= RUNTIME_RECOVERY_STUCK_AFTER_MS,
      ),
  };
}

/**
 * A replica confirmation's maintenance steps share no failure domain: an unrecoverable runtime must
 * not stop this round's auto-claim or auto-dispatch. Every step runs; their failures surface together.
 */
export async function runReplicaConfirmedRound(input: {
  readonly reconcile: () => Promise<void>;
  readonly observeRecovery: (failures: readonly RuntimeRecoveryFailure[] | null) => void;
  readonly triggers: readonly (() => Promise<void>)[];
}): Promise<void> {
  const [reconciled] = await Promise.allSettled([input.reconcile()]);
  input.observeRecovery(reconciled!.status === "fulfilled" ? [] : runtimeRecoveryFailuresOf(reconciled!.reason));
  const errors: unknown[] = reconciled!.status === "rejected" ? [reconciled!.reason] : [];
  for (const trigger of input.triggers) {
    const [triggered] = await Promise.allSettled([trigger()]);
    if (triggered!.status === "rejected") errors.push(triggered!.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, errors.map((error) => runtimeErrorMessage(error)).join(" | "));
}

export function renderStuckRuntimeRecoveries(rows: readonly StuckRuntimeRecovery[], at: string): string {
  const minutes = (row: StuckRuntimeRecovery) =>
    String(Math.floor((Date.parse(at) - Date.parse(row.firstFailedAt)) / 60_000));
  return (
    `本节点 runtime 清点卡住 (${String(rows.length)}) — 收养/结算持续失败；其余 runtime 与自动派工不受影响，` +
    `详情见 lifecycle 日志 runtime_recovery_failed\n` +
    rows
      .map(
        (row) =>
          `- ${row.runtimeSessionId}${row.dispatchId ? ` / dispatch ${row.dispatchId}` : ""} [${row.code}] ` +
          `已持续 ${minutes(row)} 分钟（自 ${row.firstFailedAt}）— ${row.message}`,
      )
      .join("\n")
  );
}
