import path from "node:path";
import {
  stableStringify,
  documentPath,
  isSameExecution,
  submissionDigest,
  runtimeSessionActionIds,
  type TaskLifecycleSnapshot,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import { isSubmittedExecutionCutOpen } from "@harness-anything/kernel/internal/domain/task-bound-runtime-authority.ts";
import { readyDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { actionForDaemonMethod } from "./protocol/daemon-protocol.contract.ts";
import { commandClassForAction } from "./protocol/daemon-protocol-commands.ts";
import { isJsonObject, type JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  executionCredentialRejected,
  runtimeExecutionActor,
  type RuntimeExecutionPrincipal,
} from "./runtime-execution-credential.ts";

/**
 * The canonical Kernel repository-read action has no command descriptor of its own, so the
 * execution scope classifies it directly. It is the only action kind reachable from the closed
 * read map below; command-backed actions keep resolving through the command registry.
 */
const repositoryReadActionKind = "repository-read" as const;

/**
 * GUI repository reads a runtime execution credential may issue. This is a closed policy: each
 * entry names one wire method and its generic repository-read action class, so adding one read
 * never opens the GUI read family or a write. The read handler owns the response projection.
 */
const executionRepositoryReads: ReadonlyMap<string, RepoTaskAction> = new Map([
  ["repo.agent.skills.list", { kind: repositoryReadActionKind }],
]);

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
    executionRepositoryReads.get(method) ??
      (method === "repo.settings.read" ? { kind: "settings-read" } : actionForDaemonMethod(method, params.payload)),
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
  "task-escalation-resolve",
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

/** A taskless session's requested read-only ceiling becomes an issued server-side role. */
export function runtimeExecutionRoleForLaunch(input: {
  readonly taskId: string | null;
  readonly role: RuntimeExecutionPrincipal["role"];
  readonly readOnlyCeiling: boolean;
}): RuntimeExecutionPrincipal["role"] {
  return input.taskId === null && input.readOnlyCeiling && input.role === "session" ? "read-only" : input.role;
}

export function requireExecutionActionScope(p: RuntimeExecutionPrincipal, action: RepoTaskAction): void {
  const commandClass = action.kind === repositoryReadActionKind ? "repo-read" : commandClassForAction(action.kind);
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
  if (action.kind === "task-dispatch-review" && p.role !== "session")
    throw Object.assign(executionCredentialRejected("self-approval"), {
      message:
        `Ask the CEO to recover automatic review dispatch with ha task dispatch-review ${p.taskId}. ` +
        "Workers cannot dispatch reviewers; report the submit receipt and its failed review step to the CEO.",
    });
  if (selfApprovalActions.has(action.kind) || commandClass === "arbiter" || commandClass === "admin")
    throw executionCredentialRejected("self-approval");
  if (
    p.role === "implementation" &&
    action.kind === "task-amend" &&
    Array.isArray(action.patches) &&
    action.patches.some(
      (patch) =>
        patch !== null &&
        typeof patch === "object" &&
        ["surfaces", "reviewDispatchFailure"].includes(String((patch as { readonly field?: unknown }).field)),
    )
  )
    throw executionCredentialRejected("self-approval");
  // A session is authenticated as its spawning person, not granted a task lease. The normal
  // repository authorization path still decides every action against that person's current RBAC.
  if (p.role === "session" && commandClass === "repo-write") return;
  if (action.kind === "doc-materialize") {
    const paths = selectedDocPaths(action);
    // Both path spelling and task ownership need the repository layout in the writer turn.
    if (p.role === "implementation" && paths !== null) return;
    throw executionCredentialRejected("write-other-task");
  }
  // A path-selected doc submit names its task on the documents, not in the action envelope, and this
  // entry turn holds no projection to resolve an owner. It is admitted here and the owner or declared
  // non-task surface is proved where the projection exists, before the scanner sees the selection.
  if (p.role === "implementation" && action.kind === "doc-submit" && selectedDocPaths(action) !== null) return;
  if (repositoryWriteActions.has(action.kind) || (commandClass === "repo-write" && action.taskId === undefined))
    throw executionCredentialRejected("write-other-task");
  if (commandClass !== "repo-write" || action.taskId !== p.taskId || p.role === "reviewer")
    throw executionCredentialRejected("write-other-task");
}

/** The only post-submit implementation writes: the producer may publish a branch and replace the
 * still-current submitted packet for its exact task/execution. All other writes remain lease-bound. */
export function isCurrentSubmittedWorkerWrite(input: {
  readonly action: RepoTaskAction;
  readonly taskId: string;
  readonly executionId: string;
  readonly role: RuntimeExecutionPrincipal["role"];
  readonly snapshot: TaskLifecycleSnapshot;
}): boolean {
  const { action, taskId, executionId, role, snapshot } = input;
  if (
    role !== "implementation" ||
    snapshot.lease != null ||
    action.taskId !== taskId ||
    (action.kind !== "task-push" && !(action.kind === "task-submit" && action.amend === true)) ||
    (action.kind === "task-submit" && action.executionId !== undefined && action.executionId !== executionId)
  )
    return false;
  return isSubmittedExecutionCutOpen(snapshot, executionId);
}

/** Non-empty explicit path selection; a scopeless `--all` sweep is not a path selection. */
export function selectedDocPaths(action: RepoTaskAction): readonly string[] | null {
  const paths = Array.isArray(action.changes)
    ? action.changes.map((change) => (isJsonObject(change) ? change.path : null))
    : action.paths;
  return Array.isArray(paths) && paths.length > 0 && paths.every((value) => typeof value === "string")
    ? (paths as readonly string[])
    : null;
}

/** One owner-approved path grant, copied from Task metadata only for implementation credentials. */
export function taskExecutionSurfaces(task: TaskV2 | null, role: RuntimeExecutionPrincipal["role"]): readonly string[] {
  return role === "implementation" ? (task?.metadata?.surfaces ?? []) : [];
}

/** Task package ownership still wins; declared surfaces only admit non-task authored documents. */
export function requireExecutionDocumentSelection(
  principal: RuntimeExecutionPrincipal,
  paths: readonly unknown[],
  resolve: (path: string) => { readonly path: string; readonly taskId: string | null },
): void {
  if (principal.role !== "implementation" || principal.taskId === null) return;
  const surfaces = (principal.surfaces ?? []).map((surface) => {
    const directory = surface.endsWith("/**"),
      base = directory ? surface.slice(0, -3) : surface;
    return { path: documentPath(resolve(base).path), directory };
  });
  for (const candidate of paths) {
    if (typeof candidate !== "string") throw executionCredentialRejected("write-other-task");
    const target = resolve(candidate);
    const targetPath = documentPath(target.path),
      taskPackagePath = targetPath === "tasks" || targetPath.startsWith("tasks/"),
      granted = surfaces.some((surface) =>
        surface.directory ? targetPath.startsWith(`${surface.path}/`) : targetPath === surface.path,
      );
    if (target.taskId !== principal.taskId && (target.taskId !== null || taskPackagePath || !granted))
      throw executionCredentialRejected("write-other-task");
  }
}

/** Rechecked in the current writer turn; the credential never grants a second execution lease. */
export function requireCurrentExecutionScope(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly projection: Pick<
    TaskProjection,
    "read" | "readRuntimeSession" | "readRuntimeDispatch" | "readDispatchLifecycle" | "currentLease"
  >;
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
  const [lifecycle] = readyDispatchLifecycle(
    input.projection.readDispatchLifecycle({ by: "session", runtimeSessionId: p.runtimeSessionId }),
    runtimeSpawnError,
  );
  const session = input.projection.readRuntimeSession(p.runtimeSessionId),
    dispatch = input.projection.readRuntimeDispatch(p.runtimeSessionId),
    actor = runtimeExecutionActor(p);
  const postSubmitCandidate =
      (input.action.kind === "task-push" || (input.action.kind === "task-submit" && input.action.amend === true)) &&
      input.action.taskId === p.taskId &&
      (input.action.kind === "task-push" ||
        input.action.executionId === undefined ||
        input.action.executionId === p.executionId),
    current = postSubmitCandidate && p.taskId !== null ? input.projection.read(p.taskId).snapshot : null,
    postSubmitWorkerWrite =
      current !== null &&
      p.taskId !== null &&
      p.executionId !== null &&
      isCurrentSubmittedWorkerWrite({
        action: input.action,
        taskId: p.taskId,
        executionId: p.executionId,
        role: p.role,
        snapshot: current,
      });
  // A submitted cut has released its implementation lease, but the worker that produced it may
  // still need to publish a CI fix and amend that same cut. Keep this exception on the exact
  // task/execution and current submission; every other worker write remains lease-bound.
  const exitedPostSubmitWorkerWrite = postSubmitWorkerWrite && lifecycle?.policy.canPublish === true;
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
    !lifecycle ||
    (!lifecycle.policy.canWrite && !settling && !exitedPostSubmitWorkerWrite) ||
    (lifecycle.attempt.outcome === "cancelled" && !negativeTerminal) ||
    dispatch?.payload.dispatchId !== p.dispatchId ||
    dispatch.actor.principal.personId !== p.personId ||
    stableStringify(dispatch.source) !== stableStringify(p.source) ||
    stableStringify(input.binding.source) !== stableStringify(p.source) ||
    (p.role === "session"
      ? dispatch.payload.taskId != null || dispatch.payload.role === "read-only" || dispatch.payload.role === "reviewer"
      : !session.taskBindings.some((b) => b.taskId === p.taskId && b.executionId === p.executionId))
  )
    throw executionCredentialRejected();
  if (p.role === "session") return;
  if (p.taskId === null || p.executionId === null) throw executionCredentialRejected();
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
      const fromFile = String(input.action.fromFile ?? ""),
        // A reviewer may run in its own worktree and therefore name the canonical packet by
        // absolute path; the read boundary later proves that path is inside the workspace.
        packetNamed =
          fromFile.replace(/^harness\//u, "") === reportPacket ||
          fromFile === reportPacket ||
          (path.isAbsolute(fromFile) && fromFile.replace(/\\/gu, "/").endsWith(`/${reportPacket}`));
      if (
        input.action.reviewId !== `review-${p.dispatchId}` ||
        (input.action.docChanges === undefined
          ? !packetNamed
          : !Array.isArray(input.action.docChanges) ||
            input.action.docChanges.length !== 1 ||
            !isJsonObject(input.action.docChanges[0]) ||
            input.action.docChanges[0].path !== `${packagePath}/artifacts/reports/${p.dispatchId}.md`)
      )
        throw Object.assign(executionCredentialRejected(), {
          message:
            `Reviewer dispatch ${p.dispatchId} may register only its assigned review. Use ` +
            `ha task review-execution ${p.taskId} --execution-id ${p.executionId} ` +
            `--review-id review-${p.dispatchId} --from-file harness/${reportPacket}. ` +
            "A carried review must contain only this dispatch's Markdown report.",
        });
    } else if (ingress && !taskReview && !decisionReview) {
      throw executionCredentialRejected();
    }
  } else {
    if (dispatch.payload.role === "reviewer") throw executionCredentialRejected();
    return;
  }
}
