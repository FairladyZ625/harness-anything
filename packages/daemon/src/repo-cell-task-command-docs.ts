import { createHash } from "node:crypto";
import {
  compileTaskLifecycleWrite,
  isTaskEvent,
  lifecycleDocumentFetchPaths,
  parseDocWriteIntent,
  reduceTaskEvent,
  serializeEventHead,
  sha256Text,
  type DocClaimRef,
  type DocEventChange,
  type TaskEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { adjudicateDocIntent, claimBytes, recycleClaims, rejectDocSyncAction } from "./doc-sync-actions.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";

export type TaskCommandWithDocsAction = RepoTaskAction & {
  readonly docChanges: readonly {
    readonly path: string;
    readonly baseBlobSha256: string | null;
    readonly policyId: string;
    readonly candidate: {
      readonly ref: string;
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
    };
  }[];
  readonly mirrorBaseCut?: {
    readonly revision: number;
    readonly headDigest: string;
  };
};

// Class-A sync (design-v2 §3): one serial cell command carries the lifecycle
// intent AND the locally changed task-package documents with their mirror
// base cut. Holder, document base, and transition are adjudicated together —
// any conflict voids the whole command, so a task can never complete at the
// center while its closing documents stay behind on the edge.
export async function runTaskCommandWithDocs(
  cell: RepoCellActionContext,
  action: TaskCommandWithDocsAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const { docChanges, mirrorBaseCut, ...taskAction } = action,
    taskId = cell.requiredCellText(taskAction.taskId, "taskId");
  const head = cell.store.readHead(),
    headRevision = head?.revision ?? 0,
    opId = cell.operationId(action, binding, cell.input.repoId, headRevision);
  // The mirror gate names the exact cut identity: revision AND head digest.
  // A rolled-back or same-revision-rewritten center can never pass on
  // numbers alone.
  if (
    mirrorBaseCut !== undefined &&
    (mirrorBaseCut.revision !== headRevision ||
      head === null ||
      mirrorBaseCut.headDigest !== `sha256:${sha256Text(serializeEventHead(head))}`)
  ) {
    const mirrorLabel =
      mirrorBaseCut === undefined ? "(none)" : `${mirrorBaseCut.revision}/${mirrorBaseCut.headDigest.slice(0, 16)}`;
    return cell.rejected(
      opId,
      "mirror_behind_center",
      [
        "The mirror base cut ",
        mirrorLabel,
        " does not match the center head ",
        `${headRevision}`,
        "; rerun ha daemon fleet edge sync, then resubmit the command so its ",
        "documents ride a current base.",
      ].join(""),
    );
  }
  const lease = cell.projection.currentLease(taskId, cell.now());
  const intent = parseDocWriteIntent(
    {
      schema: "doc-write-intent/v1",
      executionId: lease?.phase === "held" ? lease.executionId : null,
      baseLedgerSha: cell.store.currentCut(),
      changes: docChanges,
    },
    cell.input.repoId,
  );
  const docOpId = cell.operationId(
    {
      kind: "doc-submit",
      executionId: intent.executionId,
      baseLedgerSha: intent.baseLedgerSha,
      changes: docChanges,
    },
    binding,
    cell.input.repoId,
    headRevision,
  );
  const adjudication = adjudicateDocIntent(
    {
      binding,
      workspaceId: cell.input.repoId,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      now: cell.now,
      taskDocumentChannel: "task-command",
    },
    intent,
    docChanges.map((change) => claimBytes(cell.rootDir, change.candidate.ref as DocClaimRef)),
    lease?.phase === "held" ? lease : null,
    docOpId,
  );
  if (!adjudication.accepted)
    return {
      ...rejectDocSyncAction(opId, adjudication.code, adjudication.detail, adjudication.detail.nextAction),
      authorizationDecision: adjudication.authorizationDecision,
      taskId,
      docSync: {
        outcome: "not_applied",
        code: adjudication.code,
        transition: "blocked",
      },
    } as WriteReceipt;
  const carriedChanges = adjudication.decision.event.payload.changes.filter(
    (change): change is DocEventChange => change.candidate !== null,
  );
  if (carriedChanges.length !== adjudication.decision.event.payload.changes.length)
    throw cell.cellCodedError("invalid_command", "task-carried documents cannot contain retirement changes");
  if (taskAction.kind === "task-progress-append") {
    try {
      const progress = cell.appendProgress(taskAction, binding, {
        changes: carriedChanges,
        blobs: adjudication.decision.blobs,
      });
      return {
        ...progress,
        docSync: {
          outcome: progress.outcome === "applied" ? "applied" : "not_applied",
          code: progress.code ?? null,
          transition:
            progress.outcome === "pending" ? "pending" : progress.outcome === "applied" ? "applied" : "rejected",
          paths: docChanges.map((change) => change.path),
        },
      } as WriteReceipt;
    } finally {
      recycleClaims(cell.rootDir, intent);
    }
  }
  // The lifecycle service publishes one task event whose carried-document
  // claims and machine lifecycle claims share the same canonical commit.
  // Projection replay therefore restores both sides after any crash.
  const resolvedLifecycle = cell.resolveLifecycleAction(taskAction),
    bodyOverrides = new Map(
      carriedChanges.map((change) => {
        const blob = adjudication.decision.blobs.find((candidate) => candidate.sha256 === change.candidate!.sha256);
        if (!blob) throw cell.cellCodedError("content_not_ready", `Candidate body for ${change.path} is unavailable.`);
        return [change.path, blob.body] as const;
      }),
    );
  if (resolvedLifecycle?.coordination === "reserve")
    try {
      assertTaskTransitionDocumentReady({
        rootDir: cell.rootDir,
        projection: cell.projection,
        taskId,
        slot: "task.plan",
        transition: "task.start",
        bodyOverrides,
      });
    } catch (error) {
      recycleClaims(cell.rootDir, intent);
      throw error;
    }
  const current = await cell.service.read(taskId),
    normalized = cell.buildCommand(
      taskAction as RepoTaskAction,
      taskId,
      binding,
      cell.input.repoId,
      current.snapshot.revision,
      cell.rootDir,
      current.snapshot,
    ),
    command = cell.withServerMeta(
      normalized,
      cell.store.readTaskEvent(normalized.opId),
      cell.store.readHead()?.revision ?? 0,
      cell.now(),
    ),
    proof = await cell.proofFor(command, current.snapshot, binding, cell.projection);
  let transition: Awaited<ReturnType<typeof cell.service.executeWithDocuments>>;
  try {
    transition = await cell.service.executeWithDocuments(command, proof, {
      changes: carriedChanges,
      blobs: adjudication.decision.blobs,
    });
  } finally {
    recycleClaims(cell.rootDir, intent);
  }
  if (transition.outcome === "applied" && transition.event && transition.proof) {
    const publication = cell.publicPublication(cell.store.publication(transition.event)),
      receipt = cell.lifecycleReceipt(
        transition.event,
        transition.snapshot,
        publication,
        transition.proof,
        proof.authorizationDecision ?? null,
      );
    return {
      ...receipt,
      taskId,
      docSync: {
        outcome: "applied",
        revision: transition.revision,
        commitSha: publication.commitSha,
        cut: publication.cut,
        transition: "applied",
        paths: docChanges.map((change) => change.path),
      },
    } as WriteReceipt;
  }
  if (transition.outcome === "pending")
    return {
      outcome: "pending",
      opId: command.opId,
      revision: transition.revision,
      evidence: transition.evidence,
      visibility: transition.visibility,
      proof: transition.proof,
      nextAction: transition.nextAction ?? "Retry receipt show.",
      taskId,
      docSync: {
        outcome: "pending",
        code: transition.code ?? null,
        transition: "pending",
        paths: docChanges.map((change) => change.path),
      },
    } as WriteReceipt;
  return {
    ...cell.rejected(
      command.opId,
      transition.code ?? "publication_unknown",
      transition.nextAction ?? "Retry receipt show before resubmitting.",
    ),
    taskId,
    docSync: {
      outcome: "not_applied",
      code: transition.code ?? "publication_unknown",
      transition: "rejected",
      paths: docChanges.map((change) => change.path),
    },
  } as WriteReceipt;
}

export function taskSurfaceWrite(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(
      action.kind === "task-supersede" ? action.oldTaskId : action.taskId,
      action.kind === "task-supersede" ? "oldTaskId" : "taskId",
    ),
    current = cell.projection.read(taskId);
  if (!cell.projectionReady(current) || !current.snapshot.task || !current.packagePath)
    throw cell.cellCodedError("task_not_found", `Create or import task ${taskId} before running ${action.kind}.`);
  const snapshot = current.snapshot,
    original = snapshot.task!,
    mutation = cell.taskMutation(action, original, snapshot, binding),
    canonicalAction = cell.withoutDryRun(action),
    canonicalOpId = cell.operationId(canonicalAction, binding, cell.input.repoId, snapshot.revision);
  if (action.dryRun === true)
    return cell.previewResult(
      `preview:${canonicalOpId}`,
      {
        taskId,
        command: action.kind,
        eventType: mutation.type,
        mutation: mutation.audit,
        task: mutation.task,
      },
      snapshot.revision,
      `Remove --dry-run to publish this validated ${action.kind} event.`,
    );
  if (mutation.type === "lease_released" && mutation.execution === undefined) {
    const reservation = mutation.releasedLease;
    if (!reservation) throw cell.cellCodedError("invalid_command", "A reservation release requires the current lease.");
    const published = cell.store
      .read()
      .events.some(
        (event) =>
          isTaskEvent(event) &&
          event.type === "execution_started" &&
          event.taskId === taskId &&
          event.payload.execution.executionId === reservation.executionId,
      );
    if (published)
      throw cell.cellCodedError(
        "projection_pending",
        [
          `Execution ${reservation.executionId} is canonical but missing from the projection; `,
          "retry after projection rebuild.",
        ].join(""),
      );
    cell.projection.releaseLease(reservation);
    const revision = cell.store.readHead()?.revision ?? snapshot.revision;
    return {
      outcome: "no_changes",
      opId: canonicalOpId,
      revision,
      code: "no_changes",
      origin: "task-release",
      evidence: `projection-reservation-released:${reservation.executionId}`,
      visibility: "center",
      proof: {
        committedRevision: revision,
        appliedCut: revision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      authorizationDecision: mutation.authorizationDecision ?? null,
      nextAction: `Reservation released; run ha task start ${taskId} to claim a new execution.`,
      taskId,
      executionId: reservation.executionId,
      report: {
        command: action.kind,
        reason: mutation.audit.reason,
        fields: mutation.audit.fields,
      },
    } as WriteReceipt;
  }
  const opId = canonicalOpId,
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const event = {
      schema: "task-event/v1",
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      opId,
      taskId,
      type: mutation.type,
      actor: binding.actor,
      source: binding.source,
      occurredAt: cell.now(),
      payload: mutation.execution
        ? {
            task: mutation.task,
            execution: mutation.execution,
            releasedLease: mutation.releasedLease,
            mutation: mutation.audit,
            documentClaims: [],
          }
        : {
            task: mutation.task,
            mutation: mutation.audit,
            documentClaims: [],
          },
    } as unknown as TaskEventV1,
    next = reduceTaskEvent(snapshot, event),
    paths = lifecycleDocumentFetchPaths(event, current.packagePath),
    documents = paths.flatMap((target) => {
      const read = cell.projection.readDocument(target);
      if (!cell.projectionReady(read))
        throw cell.cellCodedError(
          "content_not_ready",
          `Retry ${action.kind} after document projection ${target} catches up.`,
        );
      return read.document
        ? [
            {
              path: target,
              body: read.document.body,
              blobSha256: read.document.blobSha256,
            },
          ]
        : [];
    }),
    compiled = compileTaskLifecycleWrite({
      event,
      snapshot: next,
      packagePath: current.packagePath,
      currentDocuments: documents,
    }),
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  cell.input.killpoint?.("after_sqlite_commit");
  const receipt = cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
    mutation.authorizationDecision ?? null,
  );
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return {
    ...receipt,
    mode: action.kind === "task-delete" ? "soft" : undefined,
    report: {
      command: action.kind,
      reason: mutation.audit.reason,
      fields: mutation.audit.fields,
    },
  } as WriteReceipt;
}
