import { readDaemonRegistry, type WriteSource } from "../../kernel/src/index.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import { admitRepoMode, type RepoModeAdmission } from "./repo-mode.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export function admitHostMode(
  context: any,
  repoId: string,
  commandClass: DaemonCommandClass,
  auth: DaemonAuthenticationContext,
): RepoModeAdmission {
  const persisted = readDaemonRegistry({
      userRoot: context.input.userRoot,
    }).repos.find((entry) => entry.repoId === repoId && entry.state === "enabled"),
    fallback = context.unavailable.get(repoId);
  if (!persisted?.mode && !fallback?.mode)
    return {
      ok: false,
      code: "repo_namespace_unknown",
      nextAction: `Unknown repo namespace: ${repoId}.`,
    };
  const source: WriteSource = auth.assignmentBinding
    ? {
        kind: "assignment",
        nodeId: auth.assignmentBinding.nodeId,
        assignmentId: auth.assignmentBinding.assignmentId,
      }
    : "local";
  return admitRepoMode(persisted?.mode ?? fallback!.mode!, commandClass, source);
}

export function localCenterProjectionRepair(
  context: any,
  repoId: string,
  actionKind: string,
  auth: DaemonAuthenticationContext,
): boolean {
  if (actionKind !== "projection-rebuild" || auth.transportKind !== "unix-socket" || auth.assignmentBinding)
    return false;
  const persisted = readDaemonRegistry({
      userRoot: context.input.userRoot,
    }).repos.find((entry) => entry.repoId === repoId && entry.state === "enabled"),
    fallback = context.unavailable.get(repoId);
  return (persisted?.mode ?? fallback?.mode) === "remote-center";
}

export function requireHostMode(
  context: any,
  repoId: string,
  commandClass: DaemonCommandClass,
  auth: DaemonAuthenticationContext,
): void {
  const admission = context.admitHostMode(repoId, commandClass, auth);
  if (!admission.ok) throw context.hostCodedError(admission.code, admission.nextAction);
}

export function settleControl(context: any, pending: DaemonControlReceipt, ok: boolean, error?: unknown): void {
  const completedAt = new Date().toISOString(),
    settled: DaemonControlReceipt = {
      ...pending,
      ok,
      outcome: ok ? "pending" : "op_rejected",
      phase: ok ? "settled" : "failed",
      completedAt,
      after: ok ? context.point() : null,
      error: ok ? null : { code: context.code(error), hint: context.daemonErrorMessage(error) },
      nextAction: ok ? null : "Repair the reported registry or RepoCell error, then request a new refresh.",
    };
  context.controls.set(pending.operationId, settled);
  context.latestControl = settled;
}
