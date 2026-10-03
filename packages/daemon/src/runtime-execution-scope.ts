import { stableStringify, isSameExecution, submissionDigest, type TaskProjection } from "@harness-anything/kernel";
import { actionForDaemonMethod } from "./protocol/daemon-protocol.contract.ts";
import { isJsonObject, type JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { executionCredentialRejected, type RuntimeExecutionPrincipal } from "./runtime-execution-credential.ts";

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

function requireExecutionActionScope(p: RuntimeExecutionPrincipal, action: RepoTaskAction): void {
  const reads = ["task-show", "task-read-set", "task-dispatches", "doc-status", "doc-dry-run"],
    writes =
      p.role === "reviewer"
        ? ["task-review-execution"]
        : ["task-progress-append", "fact-record", "doc-submit", "task-submit", "task-artifact-add"];
  if (
    (action.kind.startsWith("doc-") &&
      (action.all === true || (Array.isArray(action.paths) && action.paths.length > 0))) ||
    ![...reads, ...writes].includes(action.kind) ||
    action.taskId !== p.taskId ||
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
  requireExecutionActionScope(p, input.action);
  const session = input.projection.readRuntimeSession(p.runtimeSessionId),
    dispatch = input.projection.readRuntimeDispatch(p.runtimeSessionId),
    actor = {
      principal: { personId: p.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
    };
  if (
    Date.parse(p.expiresAt) <= Date.parse(input.now) ||
    !isSameExecution(actor, input.binding.actor) ||
    !session ||
    session.liveness === "exited" ||
    session.outcome !== null ||
    dispatch?.payload.dispatchId !== p.dispatchId ||
    dispatch.actor.principal.personId !== p.personId ||
    stableStringify(dispatch.source) !== stableStringify(p.source) ||
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
      target.digest !== submissionDigest(execution.submission)
    )
      throw executionCredentialRejected();
    if (input.action.kind === "task-review-execution") {
      const packagePath = input.projection.read(p.taskId).packagePath,
        reportPacket = `${packagePath}/artifacts/reports/${p.dispatchId}.json`;
      if (
        input.action.reviewId !== `review-${p.dispatchId}` ||
        String(input.action.fromFile ?? "").replace(/^harness\//u, "") !== reportPacket
      )
        throw executionCredentialRejected();
    }
  } else {
    const lease = input.projection.currentLease(p.taskId, input.now);
    if (
      dispatch.payload.role === "reviewer" ||
      !lease ||
      lease.phase !== "held" ||
      lease.executionId !== p.executionId ||
      !isSameExecution(lease.actor, actor) ||
      stableStringify(lease.source) !== stableStringify(input.binding.source)
    )
      throw executionCredentialRejected();
  }
}
