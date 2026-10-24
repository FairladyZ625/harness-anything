import {
  stableStringify,
  isSameExecution,
  submissionDigest,
  runtimeSessionActionIds,
  type TaskProjection,
} from "@harness-anything/kernel";
import { actionForDaemonMethod } from "./protocol/daemon-protocol.contract.ts";
import { commandClassForAction } from "./protocol/daemon-protocol-commands.ts";
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
  // CH4: a dispatched agent may ask for its own task, never decide or administer access.
  if (method === "daemon.rbac.manage") {
    if (
      params.operation !== "permission-request-create" ||
      params.repoId !== principal.repoId ||
      params.resource !== `${principal.repoId}:task/${principal.taskId}` ||
      Object.keys(params).some(
        (key) => !["operation", "repoId", "resource", "groupId", "rationale", "personId"].includes(key),
      ) ||
      (params.personId !== undefined && params.personId !== principal.personId)
    )
      throw executionCredentialRejected();
    return;
  }
  if (!isJsonObject(params.repo) || params.repo.repoId !== principal.repoId || !isJsonObject(params.payload))
    throw executionCredentialRejected();
  // Settings are a repository-level read method rather than a task action. Keep it in the
  // execution scope explicitly so the worker can inspect the same repository baseline.
  requireExecutionActionScope(
    principal,
    method === "repo.settings.read" ? { kind: "settings-read" } : actionForDaemonMethod(method, params.payload),
  );
}

const selfApprovalActions = new Set([
  "task-review-consent",
  "task-complete",
  "decision-accept",
  "decision-consent",
  "decision-review-consent",
  "relation-relate",
  "relation-unrelate",
]);

const repositoryWriteActions = new Set(["entity-pin", "entity-unpin", "settings-update"]);

/**
 * The read-only dispatch's ledger surface, enforced here by the daemon — never by prompt
 * discipline. The bundled ask-agent declaration mirrors this list in its prompt for usability;
 * this set is the authority.
 */
const readOnlyLedgerQueries = new Set([
  "work-list",
  "work-show",
  "task-list",
  "task-show",
  "agenda",
  "runtime-status",
  "schedule-list",
  "schedule-runs",
]);

export function requireExecutionActionScope(p: RuntimeExecutionPrincipal, action: RepoTaskAction): void {
  const commandClass = commandClassForAction(action.kind);
  // The read-only dispatch holds no task lease, so every non-allowlisted action — read or
  // write — fails as one allowlist rejection instead of falling into task-binding logic.
  if (p.role === "read-only") {
    if (commandClass === "repo-read" && readOnlyLedgerQueries.has(action.kind)) return;
    throw executionCredentialRejected("read-only-allowlist");
  }
  // CH2 (dec_CF96A3C910B31D2D7498F32DDD): reads are repository-view operations and
  // remain available throughout a dispatch; only writes are task-bound below.
  if (commandClass === "repo-read") return;
  if (action.kind === "task-review-execution") {
    if (p.role === "reviewer" && action.taskId === p.taskId) return;
    throw executionCredentialRejected("write-other-task");
  }
  if (selfApprovalActions.has(action.kind) || commandClass === "arbiter" || commandClass === "admin")
    throw executionCredentialRejected("self-approval");
  // A path-selected doc submit names its task on the documents, not in the action envelope, and this
  // entry turn holds no projection to resolve an owner. It is admitted here and the owner is proved
  // where the projection exists: runDocAction refuses any path outside the execution's task, so a
  // cross-task path still ends in execution_credential_rejected.
  if (p.role === "implementation" && action.kind === "doc-submit" && selectedDocPaths(action) !== null) return;
  if (repositoryWriteActions.has(action.kind) || (commandClass === "repo-write" && action.taskId === undefined))
    throw executionCredentialRejected("write-other-task");
  if (commandClass !== "repo-write" || action.taskId !== p.taskId || p.role === "reviewer")
    throw executionCredentialRejected("write-other-task");
}

/** Non-empty explicit path selection; a scopeless `--all` sweep is not a path selection. */
function selectedDocPaths(action: RepoTaskAction): readonly string[] | null {
  const paths = (action as { readonly paths?: unknown }).paths;
  return Array.isArray(paths) && paths.length > 0 && paths.every((value) => typeof value === "string")
    ? (paths as readonly string[])
    : null;
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
  // A read-only dispatch holds no task lease, so lease-coupled checks cannot apply; the writer
  // turn re-decides the same allowlist rule the request entry used — command-run rechecks
  // arrive for allowlisted query-only reads too, and those still pass.
  if (p.role === "read-only") {
    requireExecutionActionScope(p, input.action);
    return;
  }
  if (p.taskId === null || p.executionId === null) throw executionCredentialRejected();
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
        input.binding.actor.principal.personId === p.personId &&
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
    dispatch.actor.principal.personId !== p.personId ||
    stableStringify(dispatch.source) !== stableStringify(p.source) ||
    stableStringify(input.binding.source) !== stableStringify(p.source) ||
    !session.taskBindings.some((b) => b.taskId === p.taskId && b.executionId === p.executionId)
  )
    throw executionCredentialRejected();
  if (p.role === "reviewer") {
    const target = dispatch.payload.reviewTarget,
      execution = input.projection.read(p.taskId).snapshot.executions.find((e) => e.executionId === p.executionId);
    const taskReview =
      target?.kind === "task" &&
      target.taskId === p.taskId &&
      target.executionId === p.executionId &&
      execution?.submission !== null &&
      execution?.submission !== undefined &&
      (negativeTerminal || target.digest === submissionDigest(execution.submission));
    const decisionReview = target?.kind === "decision" && p.reviewDecisionId === target.decisionId;
    if (dispatch.payload.role !== "reviewer") throw executionCredentialRejected();
    if (input.action.kind === "task-review-execution") {
      if (!taskReview) throw executionCredentialRejected();
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
    } else if (ingress && !taskReview && !decisionReview) {
      throw executionCredentialRejected();
    }
  } else {
    if (dispatch.payload.role === "reviewer") throw executionCredentialRejected();
    return;
  }
}
