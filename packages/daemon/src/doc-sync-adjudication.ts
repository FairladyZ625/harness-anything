import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  decideDocWrite,
  docSyncWritePlan,
  parseDocWriteIntent,
  resolveLiveTaskBoundRuntimeBinding,
  resolveRetirableDocument,
  runtimeSessionIdFromActor,
  sha256Bytes,
  type DocEventV1,
  type DocSyncReceiptDetail,
  type DocWriteIntent,
  type AuthorizationDecision,
} from "../../kernel/src/index.ts";
import { scanDocCandidates, type DocCandidateScan, validateSelectedDocPaths } from "./doc-sync-candidate-scanner.ts";
import type { Input } from "./doc-sync-command-actions.ts";
import { detail, directPaths } from "./doc-sync-details.ts";
import { docSyncError, hasExactDocSyncActionFields } from "./doc-sync-files.ts";
import { admissionRejection } from "./doc-sync-settlement.ts";
import { authorizeAction } from "./authorization.ts";

// Pure adjudication of one doc write intent against the current canonical
// state: projection readiness, assignment-scope admission, and the domain
// decideDocWrite judgment (lease channel, ledger base, per-path bases, region
// proofs). Both the standalone doc submit and the class-A task bundle consume
// the same verdict, so a carried document set can never pass a weaker check
// than an explicit `ha doc sync` submission.
//
// Task-package documents have exactly ONE fleet entry: the lease-brokered task
// command (design §3 — 绕过自动入口的提交直接拒绝). A fleet doc submit that
// touches a task package without naming the held execution is refused here;
// the local repo-prose channel keeps its pre-start edit flow.
export type DocIntentChannel = "doc-submit" | "task-command";

export type DocIntentAdjudication =
  | {
      readonly accepted: false;
      readonly code: string;
      readonly detail: DocSyncReceiptDetail;
      readonly authorizationDecision: AuthorizationDecision | null;
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
          readonly body: string;
        }[];
        readonly authorizationDecision: AuthorizationDecision | null;
      };
    };

export function adjudicateDocIntent(
  input: Omit<Input, "action"> & {
    readonly taskDocumentChannel?: DocIntentChannel;
  },
  intent: DocWriteIntent,
  claims: readonly (Uint8Array | null)[],
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
  opId: string,
  retirementReason?: string,
): DocIntentAdjudication {
  const documents = intent.changes.map((change) => input.projection.readDocument(change.path));
  if (documents.some((read) => read.watermark !== read.sourceRevision)) {
    const pending = detail(intent, input.store.currentCut(), "projection_pending", lease);
    return {
      accepted: false,
      code: "projection_pending",
      authorizationDecision: null,
      detail: {
        ...pending,
        nextAction: `run ha receipt show ${opId} after the canonical projection catches up`,
      },
    };
  }
  const admission = admissionRejection(input, intent, lease);
  if (admission)
    return { accepted: false, code: admission.code, detail: admission.detail, authorizationDecision: null };
  const cut = input.store.currentCut(),
    events = retirementReason === undefined ? [] : input.store.read().events,
    currentDocuments = documents.map((read, index) =>
      retirementReason === undefined
        ? read.document
        : resolveRetirableDocument(input.rootDir, intent.changes[index]!.path, read.document, events),
    );
  const resolvedTaskIds = intent.changes.map((change) => input.projection.taskIdForDocumentPath(change.path)),
    runtimeSessionId = runtimeSessionIdFromActor(input.binding.actor),
    runtimeSession = runtimeSessionId === null ? null : input.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding =
      lease === null ? null : resolveLiveTaskBoundRuntimeBinding(runtimeSession, lease.taskId, lease.executionId),
    authorizationDecision =
      intent.executionId === null
        ? null
        : authorizeAction(
            "doc.submit",
            `execution/${intent.executionId}`,
            input.binding.actor,
            `authorization:${opId}`,
            opId,
            {
              writeSource: input.binding.source,
              target: { lease, runtimeBinding },
              evaluatedAtCut: `canonical:${cut.revision}:${cut.headDigest}`,
            },
          );
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
    authorizationDecision,
    documents: currentDocuments,
    claims,
    retirementReason,
    resolvedTaskIds,
    ...(runtimeBinding ? { runtimeBinding } : {}),
  });
  return decision.accepted
    ? { accepted: true, decision }
    : {
        accepted: false,
        code: decision.code,
        detail: decision.detail,
        authorizationDecision: decision.authorizationDecision,
      };
}

export function assignmentIntent(input: Input): DocWriteIntent {
  try {
    if (!hasExactDocSyncActionFields(input.action, ["kind", "executionId", "baseLedgerSha", "changes"]))
      throw new Error("assignment doc submit requires staged claim descriptors");
    const intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: input.action.executionId,
        baseLedgerSha: input.action.baseLedgerSha,
        changes: input.action.changes,
      },
      input.workspaceId,
    );
    if (
      !directPaths(
        input.rootDir,
        intent.changes.map((change) => change.path),
      )
    )
      throw new Error("document path contains a symbolic link");
    return intent;
  } catch (error) {
    throw docSyncError("invalid_command", error instanceof Error ? error.message : String(error));
  }
}

export function scannerRead(input: Input): DocCandidateScan {
  const taskScoped = Object.hasOwn(input.action, "taskId"),
    fields = taskScoped ? ["kind", "taskId"] : ["kind", "paths"];
  if (
    !hasExactDocSyncActionFields(input.action, fields) ||
    (taskScoped
      ? typeof input.action.taskId !== "string"
      : !Array.isArray(input.action.paths) || input.action.paths.some((item) => typeof item !== "string"))
  )
    throw docSyncError("invalid_command", `${input.action.kind} requires authored-root-relative paths or a task id`);
  const scan = scanDocCandidates({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    store: input.store,
    projection: input.projection,
    actor: input.binding.actor,
    source: input.binding.source,
    now: input.now(),
    ...(!taskScoped ? { selection: input.action.paths as string[] } : {}),
    ...(typeof input.action.taskId === "string" ? { taskId: input.action.taskId } : {}),
  });
  if (!taskScoped) validateSelectedDocPaths(input.rootDir, input.action.paths as string[], scan);
  return scan;
}

export function scannerSubmit(input: Input): DocCandidateScan {
  const taskScoped = Object.hasOwn(input.action, "taskId"),
    fields = taskScoped
      ? ["kind", "taskId"]
      : Object.hasOwn(input.action, "executionId")
        ? ["kind", "executionId", "paths"]
        : ["kind", "paths"];
  if (
    !hasExactDocSyncActionFields(input.action, fields) ||
    (taskScoped
      ? typeof input.action.taskId !== "string"
      : !Array.isArray(input.action.paths) || input.action.paths.some((item) => typeof item !== "string")) ||
    (Object.hasOwn(input.action, "executionId") && typeof input.action.executionId !== "string")
  )
    throw docSyncError("invalid_command", "local doc submit requires scanner paths or a task id");
  const scan = scanDocCandidates({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    store: input.store,
    projection: input.projection,
    actor: input.binding.actor,
    source: input.binding.source,
    now: input.now(),
    ...(!taskScoped ? { selection: input.action.paths as string[] } : {}),
    ...(typeof input.action.taskId === "string" ? { taskId: input.action.taskId } : {}),
    ...(typeof input.action.executionId === "string" ? { executionId: input.action.executionId } : {}),
  });
  if (!taskScoped) validateSelectedDocPaths(input.rootDir, input.action.paths as string[], scan);
  return scan;
}
