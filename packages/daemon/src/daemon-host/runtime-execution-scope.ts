import path from "node:path";
import {
  stableStringify,
  documentPath,
  isDispatchAttemptCancelled,
  isSameExecution,
  submissionDigest,
  runtimeSessionActionIds,
  type TaskLifecycleSnapshot,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import { isSubmittedExecutionCutOpen } from "@harness-anything/kernel/internal/domain/task-bound-runtime-authority.ts";
import { readyDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
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
  ["repo.dossier.status", { kind: repositoryReadActionKind }],
  ["repo.dossier.read", { kind: repositoryReadActionKind }],
  ["repo.dossier.context.read", { kind: repositoryReadActionKind }],
]);

/** Parse strict read-only parameters on `daemon.runtimeInstance.list` (no probing, no unknown fields). */
export function parseReadOnlyRuntimeInstanceListPayload(payload: unknown): { readonly all: boolean } {
  if (!isJsonObject(payload)) throw executionCredentialRejected("read-only-allowlist");
  for (const key of Object.keys(payload)) {
    if (key !== "all" && key !== "probe")
      throw executionCredentialRejected("read-only-allowlist", {
        detail: `Unsupported runtime instance list parameter: ${key}.`,
      });
  }
  if (payload.all !== undefined && typeof payload.all !== "boolean")
    throw executionCredentialRejected("read-only-allowlist", {
      detail: "Runtime instance list parameter `all` must be a boolean.",
    });
  if (payload.probe !== undefined && payload.probe !== false)
    throw executionCredentialRejected("read-only-allowlist", {
      detail: "Runtime instance probing (--probe) is not allowed for read-only dispatches.",
    });
  return { all: payload.all === true };
}

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
  if (principal.role === "read-only") {
    if (method === "daemon.runtimeInstance.list") {
      if (Object.keys(params).some((key) => key !== "repo" && key !== "payload"))
        throw executionCredentialRejected("read-only-allowlist");
      if (params.repo !== undefined) {
        if (
          !isJsonObject(params.repo) ||
          params.repo.repoId !== principal.repoId ||
          Object.keys(params.repo).some((key) => key !== "repoId")
        )
          throw executionCredentialRejected();
      }
      parseReadOnlyRuntimeInstanceListPayload(params.payload);
      return;
    }
    if (method === "repo.fleet.overview.read") {
      if (
        !isJsonObject(params.repo) ||
        params.repo.repoId !== principal.repoId ||
        Object.keys(params.repo).some((key) => key !== "repoId")
      )
        throw executionCredentialRejected();
      if (
        Object.keys(params).some((key) => key !== "repo" && key !== "payload") ||
        (params.payload !== undefined && (!isJsonObject(params.payload) || Object.keys(params.payload).length > 0))
      )
        throw executionCredentialRejected("read-only-allowlist");
      requireExecutionActionScope(principal, { kind: "fleet-overview-read" });
      return;
    }
    if (isJsonObject(params.repo) && params.repo.repoId !== principal.repoId) throw executionCredentialRejected();
    if (method.startsWith("repo.residentCeo.") || !isJsonObject(params.repo) || !isJsonObject(params.payload))
      throw executionCredentialRejected("read-only-allowlist");
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
  "fleet-overview-read",
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
  /** Admits owner/host physical exit & archive settlement after the 12h worker lease expires. */
  readonly hostSettlement?: boolean;
}): void {
  const p = input.binding.executionPrincipal;
  if (!p) return;
  const expiresMs = Date.parse(p.expiresAt),
    nowMs = Date.parse(input.now);
  if (!input.hostSettlement && (!Number.isFinite(expiresMs) || expiresMs <= nowMs))
    throw executionCredentialRejected("expired", {
      expiresAt: p.expiresAt,
      dispatchId: p.dispatchId,
      role: p.role,
    });
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
  const livenessObservation = ingress?.type === "runtime_session_liveness_changed";
  const controlReceiptIngress =
    input.hostSettlement === true &&
    (livenessObservation || ingress?.type === "runtime_session_provider_bound") &&
    isJsonObject(ingress.payload) &&
    isJsonObject(ingress.payload.controlReceipt) &&
    ingress.payload.controlRequest === undefined;
  const archiveIngress = ingress?.kind === "archive";
  const hostSettling = archiveIngress || terminal || controlReceiptIngress;
  // A node may retire its stale reviewer after physical exit. A personal owner may also
  // abandon an unreachable dispatch through cancel's evidence gate. Public terminal ingress
  // uses the runtime executor, so carrying a ruling-shaped payload cannot claim this authority.
  const ownerAbandonment =
    input.hostSettlement &&
    input.binding.actor.executor === null &&
    ingress?.type === "runtime_session_outcome_observed" &&
    isJsonObject(ingress.payload) &&
    ingress.payload.dispatchId === p.dispatchId &&
    ingress.payload.outcome === "unknown" &&
    ingress.payload.exitCode === null &&
    ingress.payload.reasonCode === "ruling_resolved";
  const negativeTerminal =
    ingress?.type === "runtime_session_exited" ||
    (ingress?.type === "runtime_session_outcome_observed" &&
      isJsonObject(ingress.payload) &&
      (ingress.payload.outcome === "failed" || ingress.payload.outcome === "cancelled"));
  const cancelledSettlingIngress = negativeTerminal || archiveIngress || controlReceiptIngress;
  const [lifecycle] = readyDispatchLifecycle(
    input.projection.readDispatchLifecycle({ by: "session", runtimeSessionId: p.runtimeSessionId }),
    runtimeSpawnError,
  );
  const session = input.projection.readRuntimeSession(p.runtimeSessionId),
    dispatch = input.projection.readRuntimeDispatch(p.runtimeSessionId),
    actor = runtimeExecutionActor(p);
  if (
    ingress &&
    !input.hostSettlement &&
    dispatch?.payload.executionTarget &&
    (terminal ||
      ingress.type === "runtime_session_cancelled" ||
      (livenessObservation &&
        isJsonObject(ingress.payload) &&
        (ingress.payload.stopUnconfirmed === true || ingress.payload.processGroupPid !== undefined)))
  )
    throw executionCredentialRejected("scope", { dispatchId: p.dispatchId, role: p.role });
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
  if (!isSameExecution(actor, input.binding.actor)) {
    const allowedIngressActor =
      ingress &&
      input.binding.actor.principal.personId === p.personId &&
      (input.binding.actor.executor === null ||
        isSameExecution(
          {
            principal: actor.principal,
            executor: { kind: "agent", id: `runtime-session:${p.runtimeSessionId}` },
          },
          input.binding.actor,
        ));
    if (!allowedIngressActor)
      throw executionCredentialRejected("scope", {
        dispatchId: p.dispatchId,
        role: p.role,
        detail: `Actor ${input.binding.actor.principal.personId}/${input.binding.actor.executor?.id ?? "human"} does not match ${p.role} dispatch ${p.dispatchId}.`,
      });
  }
  if (!session || !lifecycle)
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail: `Runtime session ${p.runtimeSessionId} for ${p.role} dispatch ${p.dispatchId} has no active canonical session/lifecycle state.`,
    });
  if (
    !lifecycle.policy.canWrite &&
    !hostSettling &&
    !(livenessObservation && !lifecycle.policy.attemptSettled) &&
    !exitedPostSubmitWorkerWrite
  )
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail:
        `${p.role} dispatch ${p.dispatchId} is ${lifecycle.attempt.phase}` +
        `${lifecycle.attempt.outcome ? ` (outcome: ${lifecycle.attempt.outcome})` : ""} and no longer holds write authority.`,
    });
  if (isDispatchAttemptCancelled(lifecycle) && !cancelledSettlingIngress)
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail: `${p.role} dispatch ${p.dispatchId} has already been cancelled.`,
    });
  if (
    dispatch?.payload.dispatchId !== p.dispatchId ||
    dispatch.actor.principal.personId !== p.personId ||
    stableStringify(dispatch.source) !== stableStringify(p.source) ||
    stableStringify(input.binding.source) !== stableStringify(p.source)
  )
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail: `Dispatch provenance for ${p.dispatchId} changed or no longer matches this credential.`,
    });
  if (
    p.role === "session"
      ? dispatch.payload.taskId != null || dispatch.payload.role === "read-only" || dispatch.payload.role === "reviewer"
      : !session.taskBindings.some((b) => b.taskId === p.taskId && b.executionId === p.executionId)
  )
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail: `Session ${p.runtimeSessionId} is not bound to task ${String(p.taskId)} execution ${String(p.executionId)}.`,
    });
  if (p.role === "session") return;
  if (p.taskId === null || p.executionId === null)
    throw executionCredentialRejected("scope", {
      dispatchId: p.dispatchId,
      role: p.role,
      detail: `Dispatch ${p.dispatchId} has no task/execution binding.`,
    });
  if (p.role === "reviewer") {
    const target = dispatch.payload.reviewTarget,
      execution = input.projection.read(p.taskId).snapshot.executions.find((e) => e.executionId === p.executionId);
    const taskReview =
      target?.kind === "task" &&
      target.taskId === p.taskId &&
      target.executionId === p.executionId &&
      execution?.submission !== null &&
      execution?.submission !== undefined &&
      (negativeTerminal || ownerAbandonment || target.digest === submissionDigest(execution.submission));
    const decisionReview = target?.kind === "decision" && p.reviewDecisionId === target.decisionId;
    if (dispatch.payload.role !== "reviewer")
      throw executionCredentialRejected("scope", {
        dispatchId: p.dispatchId,
        role: p.role,
        detail: `Dispatch ${p.dispatchId} is not a reviewer dispatch (actual role: ${String(dispatch.payload.role)}).`,
      });
    if (input.action.kind === "task-review-execution") {
      if (!taskReview)
        throw executionCredentialRejected("scope", {
          dispatchId: p.dispatchId,
          role: p.role,
          detail:
            execution?.submission == null
              ? `Task ${p.taskId} execution ${p.executionId} has no active submitted cut to review.`
              : `Submitted cut for task ${p.taskId} execution ${p.executionId} was amended/superseded after dispatch ${p.dispatchId}; stop and wait for a fresh review dispatch.`,
        });
      const packagePath = input.projection.read(p.taskId).packagePath,
        reportPacket = `${packagePath}/artifacts/reports/${p.dispatchId}.json`,
        expectedReportPath = `${packagePath}/artifacts/reports/${p.dispatchId}.md`,
        expectedReviewId = `review-${p.dispatchId}`;
      const fromFile = String(input.action.fromFile ?? ""),
        normalizedFromFile = fromFile.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, ""),
        // A reviewer may run in its own worktree and therefore name the canonical packet by
        // absolute path; the read boundary later proves containment.
        packetNamed =
          normalizedFromFile.replace(/^harness\//u, "") === reportPacket ||
          normalizedFromFile === reportPacket ||
          (path.isAbsolute(fromFile) && fromFile.replace(/\\/gu, "/").endsWith(`/${reportPacket}`));
      const wrongReviewId = input.action.reviewId !== expectedReviewId,
        docChanges = input.action.docChanges,
        carriedPaths = Array.isArray(docChanges)
          ? docChanges.map((change) => (isJsonObject(change) ? change.path : null))
          : null,
        carriedValid =
          carriedPaths !== null &&
          carriedPaths.length >= 1 &&
          carriedPaths.length <= 2 &&
          new Set(carriedPaths).size === carriedPaths.length &&
          carriedPaths.includes(expectedReportPath) &&
          carriedPaths.every((candidate) => candidate === expectedReportPath || candidate === reportPacket),
        wrongDocChanges = docChanges !== undefined && !carriedValid,
        missingPacket = docChanges === undefined && !packetNamed;
      if (wrongReviewId || wrongDocChanges || missingPacket) {
        const mismatchDetail = wrongReviewId
          ? `Expected --review-id ${expectedReviewId} (received ${String(input.action.reviewId ?? "<missing>")}). `
          : wrongDocChanges
            ? `Expected docChanges containing ${expectedReportPath} and optionally ${reportPacket} (received ${Array.isArray(docChanges) ? `${docChanges.length} entries` : String(docChanges)}). `
            : fromFile
              ? `Expected --from-file ${`harness/${reportPacket}`} (received ${fromFile}). `
              : "--from-file is required (inline --json-input without --from-file is not allowed for scoped reviewer dispatches). ";
        throw executionCredentialRejected("scope", {
          dispatchId: p.dispatchId,
          role: p.role,
          overrideMessage:
            `Reviewer dispatch ${p.dispatchId} may register only its assigned review. ${mismatchDetail}Use ` +
            `ha task review-execution ${p.taskId} --execution-id ${p.executionId} ` +
            `--review-id ${expectedReviewId} --from-file harness/${reportPacket}. ` +
            "A carried review must contain this dispatch's Markdown report and may include its JSON packet.",
        });
      }
    } else if (ingress && !livenessObservation && !taskReview && !decisionReview) {
      throw executionCredentialRejected("scope", {
        dispatchId: p.dispatchId,
        role: p.role,
        detail: `Review target for dispatch ${p.dispatchId} was withdrawn or superseded.`,
      });
    }
  } else {
    if (dispatch.payload.role === "reviewer")
      throw executionCredentialRejected("scope", {
        dispatchId: p.dispatchId,
        role: p.role,
        detail: `Dispatch ${p.dispatchId} is a reviewer dispatch and cannot authorize ${p.role} writes.`,
      });
    return;
  }
}
