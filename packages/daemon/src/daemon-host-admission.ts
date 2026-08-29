/** @daemon-transport-authority Transport-bound repository-mode admission. */
import { readDaemonRegistry, type WriteSource } from "../../kernel/src/index.ts";
import type { CommandTopology } from "../../preset/src/preset-command-contract.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import { admitRepoMode, type RepoModeAdmission } from "./repo-mode.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import type { DaemonHostAdmissionContext } from "./daemon-host-context.ts";

export function admitHostMode(
  context: DaemonHostAdmissionContext,
  repoId: string,
  command: CommandTopology,
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
  return admitRepoMode(persisted?.mode ?? fallback!.mode!, command, source);
}

export function requireHostMode(
  context: DaemonHostAdmissionContext,
  repoId: string,
  command: CommandTopology,
  auth: DaemonAuthenticationContext,
): void {
  const admission = context.admitHostMode(repoId, command, auth);
  if (!admission.ok) throw context.hostCodedError(admission.code, admission.nextAction);
}

export function settleControl(
  context: DaemonHostAdmissionContext,
  pending: DaemonControlReceipt,
  ok: boolean,
  error?: unknown,
): void {
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
