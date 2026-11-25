import type {
  ActorIdentity,
  AuthorizationDecision,
  CanonicalEventStore,
  DocEventV1,
  DocSyncReceiptDetail,
  DocWriteIntent,
  RuntimeArchiveWriteScope,
  TaskProjectionQueries,
  WriteSource,
} from "@harness-anything/kernel";
import {
  decideDocWrite,
  docSyncWritePlan,
  isTaskBoundRuntimeWriter,
  parseDocWriteIntent,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  sha256Bytes,
  taskIsDescendantOf,
} from "@harness-anything/kernel";
import {
  detail,
  docSyncError,
  hasExactDocSyncActionFields,
  isTaskPackagePath,
  localProseSource,
  touch,
  type DocAction,
} from "./doc-sync-details.ts";

// Pure adjudication of one doc write intent against the current canonical
// state: projection readiness, canonical task admission, and the domain
// decideDocWrite judgment (lease channel, per-path bases, region
// proofs). Both the standalone doc submit and the class-A task bundle consume
// the same verdict, so a carried document set can never pass a weaker check
// than an explicit `ha doc sync` submission.
export type DocIntentChannel = "doc-submit" | "task-command";

export type DocIntentAdjudication =
  | {
      readonly accepted: false;
      readonly code: string;
      readonly detail: DocSyncReceiptDetail;
      readonly authorizationDecision: AuthorizationDecision;
    }
  | {
      readonly accepted: true;
      readonly decision: {
        readonly event: DocEventV1;
        readonly plan: ReturnType<typeof docSyncWritePlan>;
        readonly blobs: readonly {
          readonly sha256: string;
          readonly size: number;
          readonly mediaType: string;
          readonly body: string | Uint8Array;
        }[];
        readonly authorizationDecision: AuthorizationDecision;
      };
    };

export interface DocAdjudicationBinding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly authorizationDecision?: AuthorizationDecision;
}

export interface DocAdjudicationInput {
  readonly binding: DocAdjudicationBinding;
  readonly workspaceId: string;
  readonly store: Pick<CanonicalEventStore, "currentCut">;
  readonly projection: Pick<
    TaskProjectionQueries,
    | "readDocument"
    | "readDocumentHistory"
    | "taskIdForDocumentPath"
    | "readRuntimeSession"
    | "read"
    | "currentLease"
    | "currentLeaseForExecution"
  >;
  readonly now: () => string;
  readonly taskDocumentChannel?: DocIntentChannel;
  readonly unleasedTaskCommandId?: string;
  readonly taskId?: string;
  readonly runtimeArchive?: RuntimeArchiveWriteScope;
}

export function adjudicateDocIntent(
  input: DocAdjudicationInput,
  intent: DocWriteIntent,
  claims: readonly (Uint8Array | null)[],
  lease: ReturnType<TaskProjectionQueries["currentLeaseForExecution"]>,
  opId: string,
  retirementReason?: string,
): DocIntentAdjudication {
  const authorizationDecision = requiredDocAuthorization(input.binding.authorizationDecision);
  const documents = intent.changes.map((change) => {
    const active = input.projection.readDocument(change.path);
    return active.document !== null || change.candidate === null
      ? active
      : (input.projection.readDocumentHistory?.(change.path) ?? active);
  });
  if (documents.some((read) => read.watermark !== read.sourceRevision)) {
    const pending = detail(intent, input.store.currentCut(), "projection_pending", lease);
    return {
      accepted: false,
      code: "projection_pending",
      authorizationDecision,
      detail: {
        ...pending,
      },
    };
  }
  const cut = input.store.currentCut(),
    currentDocuments = documents.map((read) => read.document);
  const resolvedTaskIds = intent.changes.map((change) => input.projection.taskIdForDocumentPath(change.path)),
    runtimeSessionId = runtimeSessionIdFromActor(input.binding.actor),
    runtimeSession = runtimeSessionId === null ? null : input.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding =
      lease === null ? null : resolveTaskBoundRuntimeBinding(runtimeSession, lease.taskId, lease.executionId),
    runtimeDelegatedTaskId =
      runtimeBinding !== null &&
      input.taskId !== undefined &&
      taskIsDescendantOf(
        input.taskId,
        runtimeBinding.taskId,
        (current) => input.projection.read(current).snapshot.task?.metadata?.parentTaskId ?? null,
      )
        ? input.taskId
        : null,
    authorization = authorizationDecision;
  const delegatedTaskId =
    runtimeDelegatedTaskId &&
    runtimeBinding &&
    lease &&
    isTaskBoundRuntimeWriter(lease, input.binding.actor, input.binding.source, runtimeBinding)
      ? runtimeDelegatedTaskId
      : undefined;
  const admission = admissionRejection(input, intent, lease, delegatedTaskId);
  if (admission) return { accepted: false, code: admission.code, detail: admission.detail, authorizationDecision };
  const decision = decideDocWrite({
    intent,
    opId,
    eventId: `event-${sha256Bytes(Buffer.from(opId))}`,
    workspaceRevision: cut.revision + 1,
    actor: input.binding.actor,
    source: input.binding.source,
    occurredAt: input.now(),
    currentLedgerSha: cut,
    lease,
    authorizationDecision: authorization,
    documents: currentDocuments,
    claims,
    retirementReason,
    resolvedTaskIds,
    ...(runtimeBinding ? { runtimeBinding } : {}),
    ...(runtimeDelegatedTaskId ? { runtimeDelegatedTaskId } : {}),
    ...(input.runtimeArchive ? { runtimeArchive: input.runtimeArchive } : {}),
  });
  return decision.accepted
    ? { accepted: true, decision: { ...decision, authorizationDecision } }
    : {
        accepted: false,
        code: decision.code,
        detail: decision.detail,
        authorizationDecision,
      };
}

function requiredDocAuthorization(decision: AuthorizationDecision | undefined): AuthorizationDecision {
  if (!decision || decision.outcome !== "allowed")
    throw docSyncError(
      "authorization_missing",
      "Document criteria require the center AuthorizationPort decision before adjudication.",
    );
  return decision;
}

export function parseNodeDocIntent(
  input: {
    readonly action: DocAction;
    readonly workspaceId: string;
  },
  directPaths?: (paths: readonly string[]) => boolean,
): DocWriteIntent {
  try {
    if (
      !hasExactDocSyncActionFields(input.action, [
        "kind",
        "executionId",
        "baseLedgerSha",
        "changes",
        ...(typeof input.action.taskId === "string" ? ["taskId"] : []),
      ])
    )
      throw new Error("node doc submit requires staged claim descriptors");
    const intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: input.action.executionId,
        baseLedgerSha: input.action.baseLedgerSha,
        changes: input.action.changes,
      },
      input.workspaceId,
    );
    if (directPaths && !directPaths(intent.changes.map((change) => change.path)))
      throw new Error("document path contains a symbolic link");
    return intent;
  } catch (error) {
    throw docSyncError("invalid_command", error instanceof Error ? error.message : String(error));
  }
}

export function admissionRejection(
  input: Pick<DocAdjudicationInput, "binding" | "workspaceId" | "store" | "projection" | "runtimeArchive"> & {
    readonly taskDocumentChannel?: DocIntentChannel;
    readonly taskId?: string;
    readonly unleasedTaskCommandId?: string;
  },
  intent: DocWriteIntent,
  lease: ReturnType<TaskProjectionQueries["currentLeaseForExecution"]>,
  delegatedTaskId?: string,
): { readonly code: string; readonly detail: DocSyncReceiptDetail } | null {
  const derivedExplainers = intent.changes.filter((change) => {
    if (!change.path.endsWith("/artifacts/explainer.html")) return false;
    const taskId = input.projection.taskIdForDocumentPath(change.path);
    return taskId !== null && input.projection.read(taskId).snapshot.task?.taskClass === "work";
  });
  if (derivedExplainers.length)
    return {
      code: "derived_document_read_only",
      detail: detail(
        intent,
        input.store.currentCut(),
        "derived_document_read_only",
        lease,
        derivedExplainers.map((change) =>
          touch(
            change.path,
            "daemon-derived",
            "Work explainers are rendered from the current work projection and cannot be written.",
          ),
        ),
      ),
    };
  if (input.taskDocumentChannel === "task-command") {
    const outside = intent.changes.filter(
      (change) => input.projection.taskIdForDocumentPath(change.path) !== input.taskId,
    );
    if (outside.length)
      return {
        code: "execution_scope_mismatch",
        detail: detail(
          intent,
          input.store.currentCut(),
          "execution_scope_mismatch",
          lease,
          outside.map((change) =>
            touch(change.path, "canonical-task-package", "Carried documents must belong to this task command"),
          ),
        ),
      };
  }
  const plannedPlanPaths = new Set(
    (input.taskDocumentChannel ?? "doc-submit") === "doc-submit"
      ? intent.changes
          .filter((change) => change.candidate !== null && plannedTaskPlanSubmission(input, change.path))
          .map((change) => change.path)
      : [],
  );
  if (
    (input.taskDocumentChannel ?? "doc-submit") === "doc-submit" &&
    typeof input.binding.source === "object" &&
    input.binding.source.kind === "node" &&
    input.runtimeArchive === undefined
  ) {
    const taskTouches = intent.changes.filter(
      (change) =>
        intent.executionId === null &&
        (input.projection.taskIdForDocumentPath(change.path) !== null || isTaskPackagePath(change.path)) &&
        !plannedPlanPaths.has(change.path),
    );
    if (taskTouches.length > 0) {
      const rejected = detail(
        intent,
        input.store.currentCut(),
        "task_docs_require_task_command",
        lease,
        taskTouches.map((change) =>
          touch(
            change.path,
            "task-command",
            [
              "task-context documents other than a planned task's plan ride the canonical ",
              "lease-checked task command; this doc-submit names no held execution",
            ].join(""),
          ),
        ),
      );
      return {
        code: "task_docs_require_task_command",
        detail: {
          ...rejected,
        },
      };
    }
  }
  const touches = input.runtimeArchive
    ? []
    : scopeTouches(
        input,
        intent.changes.map((change) => change.path),
        input.taskDocumentChannel === "task-command" ? input.unleasedTaskCommandId : delegatedTaskId,
        plannedPlanPaths,
      );
  if (!touches.length) return null;
  const rejected = detail(intent, input.store.currentCut(), "execution_scope_mismatch", lease, touches);
  return {
    code: "execution_scope_mismatch",
    detail: {
      ...rejected,
    },
  };
}

function plannedTaskPlanSubmission(
  input: { readonly projection: Pick<TaskProjectionQueries, "taskIdForDocumentPath" | "read" | "currentLease"> },
  path: string,
): boolean {
  const taskId = input.projection.taskIdForDocumentPath(path);
  if (taskId === null) return false;
  const task = input.projection.read(taskId);
  return (
    task.snapshot.task?.status === "planned" &&
    task.packagePath !== null &&
    path === `${task.packagePath}/task_plan.md` &&
    input.projection.currentLease(taskId) === null
  );
}

export function scopeTouches(
  input: {
    readonly binding: Pick<DocAdjudicationBinding, "actor" | "source">;
    readonly projection: Pick<TaskProjectionQueries, "taskIdForDocumentPath" | "currentLease">;
  },
  paths: readonly string[],
  unleasedTaskCommandId?: string,
  exemptPaths?: ReadonlySet<string>,
): readonly ReturnType<typeof touch>[] {
  if (localProseSource(input.binding.source)) return [];
  return paths
    .filter((candidate) => {
      const taskId = input.projection.taskIdForDocumentPath(candidate);
      if (!taskId) return isTaskPackagePath(candidate);
      if (taskId === unleasedTaskCommandId) return false;
      if (exemptPaths?.has(candidate)) return false;
      const lease = input.projection.currentLease(taskId);
      return (
        !lease ||
        lease.phase !== "held" ||
        lease.actor.principal.personId !== input.binding.actor.principal.personId ||
        JSON.stringify(lease.source) !== JSON.stringify(input.binding.source)
      );
    })
    .map((candidate) =>
      touch(candidate, "canonical-task-lease", "Task document requires the node's current task lease"),
    );
}
