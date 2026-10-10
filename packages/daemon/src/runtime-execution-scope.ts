import { samePrincipal } from "@harness-anything/kernel";
import {
  stableStringify,
  isSameExecution,
  submissionDigest,
  runtimeSessionActionIds,
  type TaskProjection,
} from "@harness-anything/kernel";
import { actionForDaemonMethod } from "./protocol/daemon-protocol.contract.ts";
import { isJsonObject, type JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  executionCredentialRejected,
  runtimeExecutionActor,
  type RuntimeExecutionPrincipal,
} from "./runtime-execution-credential.ts";

/** Narrow authentication before any host method can act, including local socket-owner controls. */
export function requireExecutionRequestScope(
  principal: RuntimeExecutionPrincipal,
  method: string,
  params: JsonObject,
): void {
  if (!isJsonObject(params.repo) || params.repo.repoId !== principal.repoId || !isJsonObject(params.payload))
    throw executionCredentialRejected();
  requireExecutionActionScope(principal, actionForDaemonMethod(method, params.payload));
}

export function requireExecutionActionScope(p: RuntimeExecutionPrincipal, action: RepoTaskAction): void {
  const frozenDocument = p.role === "reviewer" && action.kind === "doc-show",
    reads = [
      "event-list",
      "task-show",
      "task-read-set",
      "task-dispatches",
      "doc-status",
      "doc-dry-run",
      ...(frozenDocument ? ["doc-show"] : []),
    ],
    writes =
      p.role === "reviewer"
        ? ["task-review-execution"]
        : ["task-progress-append", "fact-record", "doc-submit", "task-submit", "task-artifact-add"];
  if (
    (action.kind.startsWith("doc-") &&
      (action.all === true || (Array.isArray(action.paths) && action.paths.length > 0))) ||
    ![...reads, ...writes].includes(action.kind) ||
    (action.kind !== "event-list" && !frozenDocument && action.taskId !== p.taskId) ||
    (frozenDocument && action.taskId !== undefined && action.taskId !== p.taskId) ||
    (action.executionId !== undefined && action.executionId !== p.executionId) ||
    (action.executor != null &&
      (!isJsonObject(action.executor) ||
        action.executor.kind !== "agent" ||
        action.executor.id !== `runtime-session:${p.runtimeSessionId}`))
  )
    throw executionCredentialRejected();
}

/** Rechecked in the current writer turn; the credential never grants a second execution lease. */
export function requireCurrentExecutionScope(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly projection: Pick<TaskProjection, "read" | "readRuntimeSession" | "readRuntimeDispatch" | "currentLease">;
  readonly now: string;
}): void {
  const p = input.binding.executionPrincipal;
  if (!p) return;
  const ingress =
    input.action.kind === "runtime-run" && isJsonObject(input.action.executionRuntimeIngress)
      ? input.action.executionRuntimeIngress
      : null;
  if (ingress) {
    const target = ingress.kind === "archive" ? ingress.archive : ingress.payload;
    if (
      !isJsonObject(target) ||
      target.runtimeSessionId !== p.runtimeSessionId ||
      (target.dispatchId !== undefined && target.dispatchId !== p.dispatchId) ||
      (target.taskId !== undefined && target.taskId !== p.taskId) ||
      (target.executionId !== undefined && target.executionId !== p.executionId) ||
      (target.taskBinding !== undefined &&
        (!isJsonObject(target.taskBinding) ||
          target.taskBinding.taskId !== p.taskId ||
          target.taskBinding.executionId !== p.executionId)) ||
      (ingress.kind !== "archive" &&
        (ingress.kind !== "event" || !(runtimeSessionActionIds as readonly unknown[]).includes(ingress.type)))
    )
      throw executionCredentialRejected();
  } else requireExecutionActionScope(p, input.action);
  const terminal = ingress?.type === "runtime_session_exited" || ingress?.type === "runtime_session_outcome_observed";
  const settling = ingress?.kind === "archive" || terminal;
  // A node may retire its own stale reviewer without restoring business access.
  // Archive and successful outcomes still require the current submission cut.
  const negativeTerminal =
    ingress?.type === "runtime_session_exited" ||
    (ingress?.type === "runtime_session_outcome_observed" &&
      isJsonObject(ingress.payload) &&
      (ingress.payload.outcome === "failed" || ingress.payload.outcome === "cancelled"));
  const session = input.projection.readRuntimeSession(p.runtimeSessionId),
    dispatch = input.projection.readRuntimeDispatch(p.runtimeSessionId),
    actor = runtimeExecutionActor(p);
  if (Date.parse(p.expiresAt) <= Date.parse(input.now)) throw executionCredentialRejected("expired");
  if (
    (!isSameExecution(actor, input.binding.actor) &&
      !(
        ingress &&
        samePrincipal(input.binding.actor.principal, p.principal) &&
        (input.binding.actor.executor === null ||
          isSameExecution(
            {
              principal: actor.principal,
              executor: { kind: "agent", id: `runtime-session:${p.runtimeSessionId}` },
            },
            input.binding.actor,
          ))
      )) ||
    !session ||
    (session.liveness === "exited" && !settling) ||
    (session.outcome !== null && !settling) ||
    (session.outcome === "cancelled" && !negativeTerminal) ||
    dispatch?.payload.dispatchId !== p.dispatchId ||
    !samePrincipal(dispatch.actor.principal, p.principal) ||
    stableStringify(dispatch.source) !== stableStringify(p.source) ||
    stableStringify(input.binding.source) !== stableStringify(p.source) ||
    !session.taskBindings.some((b) => b.taskId === p.taskId && b.executionId === p.executionId)
  )
    throw executionCredentialRejected();
  if (p.role === "reviewer") {
    const target = dispatch.payload.reviewTarget,
      execution = input.projection.read(p.taskId).snapshot.executions.find((e) => e.executionId === p.executionId);
    if (
      dispatch.payload.role !== "reviewer" ||
      target?.kind !== "task" ||
      target.taskId !== p.taskId ||
      target.executionId !== p.executionId ||
      !execution?.submission ||
      (!negativeTerminal && target.digest !== submissionDigest(execution.submission))
    )
      throw executionCredentialRejected();
    if (input.action.kind === "task-review-execution") {
      const packagePath = input.projection.read(p.taskId).packagePath,
        reportPacket = `${packagePath}/artifacts/reports/${p.dispatchId}.json`;
      if (
        input.action.reviewId !== `review-${p.dispatchId}` ||
        (p.source === "local"
          ? String(input.action.fromFile ?? "").replace(/^harness\//u, "") !== reportPacket
          : !Array.isArray(input.action.docChanges) ||
            input.action.docChanges.length !== 1 ||
            !isJsonObject(input.action.docChanges[0]) ||
            input.action.docChanges[0].path !== `${packagePath}/artifacts/reports/${p.dispatchId}.md`)
      )
        throw executionCredentialRejected();
    }
  } else {
    if (dispatch.payload.role === "reviewer") throw executionCredentialRejected();
    const snapshot = settling ? input.projection.read(p.taskId).snapshot : null;
    const lease =
      input.projection.currentLease(p.taskId, input.now) ??
      (terminal && snapshot?.lease?.phase === "released" ? snapshot.lease : null);
    if (
      settling &&
      input.projection
        .read(p.taskId)
        .snapshot.executions.some(
          (execution) => execution.executionId === p.executionId && execution.submission !== null,
        )
    )
      return;
    if (
      !lease ||
      (lease.phase !== "held" && !(terminal && lease.phase === "released")) ||
      lease.executionId !== p.executionId ||
      !isSameExecution(lease.actor, actor) ||
      stableStringify(lease.source) !== stableStringify(input.binding.source)
    )
      throw executionCredentialRejected();
  }
}
