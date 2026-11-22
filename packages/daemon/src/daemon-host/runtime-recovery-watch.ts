import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { isDeterministicReplicaFailure } from "../fleet-sync/fleet/replica-retry.ts";
import type { RuntimeRecoveryResult } from "./runtime-spawn-adoption.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "../runtime-engine/runtime-spawn-errors.ts";

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

export interface ReplicaConfirmFailure {
  readonly code: string;
  readonly message: string;
  readonly dirtyPaths: readonly string[];
}

export interface ActiveReplicaConfirmFailure extends ReplicaConfirmFailure {
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
}

const DETERMINISTIC_CONFIRM_CODES = new Set([
  "pull_blocked",
  "replica_corrupt",
  "doc_conflict",
  "worktree_workspace_conflict",
  "preview_blocked",
  "doc_route_owned",
  "doc_candidate_too_large",
  "task_materialization_metadata_missing",
  "edge_default_branch_diverged",
  "edge_default_branch_behind",
  "edge_default_branch_mismatch",
  "edge_default_branch_unavailable",
  "edge_origin_missing",
  "edge_origin_mismatch",
  "edge_push_url_mismatch",
  "edge_git_metadata_unavailable",
  "fleet_edge_config_invalid",
  "fleet_edge_config_missing",
  "EISDIR",
  "ENOTDIR",
  "EEXIST",
  "EACCES",
  "EPERM",
  "EROFS",
  "EINVAL",
  "ENAMETOOLONG",
]);

/** Classifies unrecoverable replica confirmation failures that require operator action or a new cut. */
export function deterministicReplicaConfirmFailure(error: unknown): ReplicaConfirmFailure | null {
  if (error instanceof AggregateError) {
    const nested = error.errors.map((entry) => deterministicReplicaConfirmFailure(entry));
    if (nested.length === 0 || nested.some((entry) => entry === null)) return null;
    const confirmed = nested as readonly ReplicaConfirmFailure[];
    return {
      code: confirmed.length === 1 ? confirmed[0]!.code : "replica_confirm_failed",
      message: confirmed.map((entry) => entry.message).join(" | "),
      dirtyPaths: [...new Set(confirmed.flatMap((entry) => entry.dirtyPaths))],
    };
  }
  const rawCode = runtimeErrorCode(error),
    code = isDeterministicReplicaFailure(error)
      ? (rawCode ?? "replica_confirm_failed")
      : rawCode !== null && DETERMINISTIC_CONFIRM_CODES.has(rawCode)
        ? rawCode
        : error instanceof Error && error.name === "TaskEventStoreError" && rawCode !== "publication_indeterminate"
          ? (rawCode ?? "task_event_store_error")
          : error instanceof SyntaxError
            ? "invalid_json"
            : null;
  if (code === null) return null;
  const dirtyPaths =
    typeof error === "object" &&
    error !== null &&
    "dirtyPaths" in error &&
    Array.isArray((error as { readonly dirtyPaths?: unknown }).dirtyPaths)
      ? (error as { readonly dirtyPaths: readonly unknown[] }).dirtyPaths.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  return { code, message: runtimeErrorMessage(error), dirtyPaths };
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
  readonly observeConfirm: (
    repoId: string,
    failure: ReplicaConfirmFailure | null | "unchanged",
    at: string,
    dirtyFingerprint?: string | null,
  ) => void;
  readonly confirmFailure: (repoId: string) => ActiveReplicaConfirmFailure | null;
  readonly confirmDirtyFingerprint: (repoId: string) => string | null;
  readonly noteConfirmFailure: (repoId: string, error: unknown) => boolean;
}

export function openRuntimeRecoveryWatch(): RuntimeRecoveryWatch {
  const repos = new Map<string, ReadonlyMap<string, StuckRuntimeRecovery>>(),
    confirmFailures = new Map<
      string,
      { readonly failure: ActiveReplicaConfirmFailure; readonly dirtyFingerprint: string | null } | null
    >(),
    loggedConfirmKeys = new Map<string, string | null>();
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
    observeConfirm: (repoId, failure, at, dirtyFingerprint = null) => {
      if (failure === null) {
        confirmFailures.set(repoId, null);
        loggedConfirmKeys.set(repoId, null);
        return;
      }
      if (failure === "unchanged") {
        const existing = confirmFailures.get(repoId) ?? null;
        if (existing) confirmFailures.set(repoId, { ...existing, failure: { ...existing.failure, lastFailedAt: at } });
        return;
      }
      const previous = confirmFailures.get(repoId)?.failure ?? null,
        sameState = previous !== null && previous.code === failure.code && previous.message === failure.message;
      confirmFailures.set(repoId, {
        failure: {
          ...failure,
          firstFailedAt: sameState ? previous.firstFailedAt : at,
          lastFailedAt: at,
        },
        dirtyFingerprint,
      });
    },
    confirmFailure: (repoId) => confirmFailures.get(repoId)?.failure ?? null,
    confirmDirtyFingerprint: (repoId) => confirmFailures.get(repoId)?.dirtyFingerprint ?? null,
    noteConfirmFailure: (repoId, error) => {
      const deterministic = deterministicReplicaConfirmFailure(error);
      if (deterministic === null) {
        loggedConfirmKeys.set(repoId, null);
        return true;
      }
      const key = `${deterministic.code}\u0000${deterministic.message}`;
      if (loggedConfirmKeys.get(repoId) === key) return false;
      loggedConfirmKeys.set(repoId, key);
      return true;
    },
  };
}

/**
 * A replica confirmation's maintenance steps share no failure domain: a blocked workspace mirror or
 * unrecoverable runtime must not stop this round's reconcile, auto-claim, or auto-dispatch.
 * Every step runs; their failures surface together.
 */
export async function runReplicaConfirmedRound(input: {
  readonly materialize?: () => void | Promise<void>;
  readonly observeConfirm?: (failure: ReplicaConfirmFailure | null | "unchanged") => void;
  readonly reconcile: () => Promise<void>;
  readonly observeRecovery: (failures: readonly RuntimeRecoveryFailure[] | null) => void;
  readonly triggers: readonly (() => Promise<void>)[];
}): Promise<void> {
  const errors: unknown[] = [];
  let materializedOk = true,
    confirmFailure: ReplicaConfirmFailure | null = null;
  if (input.materialize) {
    const [materialized] = await Promise.allSettled([Promise.resolve().then(() => input.materialize!())]);
    if (materialized!.status === "rejected") {
      materializedOk = false;
      errors.push(materialized!.reason);
      confirmFailure = deterministicReplicaConfirmFailure(materialized!.reason);
    }
  }
  const [reconciled] = await Promise.allSettled([input.reconcile()]);
  input.observeRecovery(reconciled!.status === "fulfilled" ? [] : runtimeRecoveryFailuresOf(reconciled!.reason));
  if (reconciled!.status === "rejected") {
    errors.push(reconciled!.reason);
    confirmFailure ??= deterministicReplicaConfirmFailure(reconciled!.reason);
  }
  for (const trigger of input.triggers) {
    const [triggered] = await Promise.allSettled([trigger()]);
    if (triggered!.status === "rejected") {
      errors.push(triggered!.reason);
      confirmFailure ??= deterministicReplicaConfirmFailure(triggered!.reason);
    }
  }
  if (confirmFailure !== null) input.observeConfirm?.(confirmFailure);
  else if (materializedOk) input.observeConfirm?.(null);
  else input.observeConfirm?.("unchanged");
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, errors.map((error) => runtimeErrorMessage(error)).join(" | "));
}

export function renderReplicaConfirmFailure(failure: ActiveReplicaConfirmFailure, at: string): string {
  const minutes = String(Math.max(0, Math.floor((Date.parse(at) - Date.parse(failure.firstFailedAt)) / 60_000)));
  return (
    `本节点副本确认待处理 [阻塞] — 工作区物化或确认遇到不可自愈错误；reconcile 与自动派工不受影响，` +
    `解决本地冲突/分叉后将在下次确认自动恢复（详情见 lifecycle 日志 replica_confirm_failed）\n` +
    `- [${failure.code}] 已持续 ${minutes} 分钟（自 ${failure.firstFailedAt}）— ${failure.message}`
  );
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
