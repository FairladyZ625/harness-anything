import {
  isEntityEvent,
  isTaskEvent,
  isTaskProgressEvent,
  requireEntityKindContract,
  type CanonicalEventV1,
  type TaskProgressEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { readDocReceipt } from "./doc-sync-actions.ts";
import type { PublicPublication, RepoCellBinding, TaskProgressReceipt } from "./repo-cell-types.ts";

export function receiptForOperation(cell: any, opId: string, binding: RepoCellBinding): WriteReceipt {
  cell.requiredCellText(opId, "opId");
  const event = cell.store.readEvent(opId);
  if (event === null)
    return cell.recoveryUncertain || cell.recovery.status === "indeterminate"
      ? {
          outcome: "indeterminate",
          opId,
          code: "publication_indeterminate",
          origin: "daemon",
          evidence: "prepared-recovery:indeterminate",
          nextAction: [
            "Repair the prepared publication state, restart the daemon, then run ha ",
            "receipt show ",
            `${opId}`,
            " again before retrying.",
          ].join(""),
        }
      : cell.rejected(
          opId,
          "operation_not_published",
          "No committed or recoverable event exists for this opId; the write was not applied and may be retried.",
        );
  // Replay receipts name the current canonical cut: the event is reachable there, and replay proves
  // occurrence rather than original publication provenance.
  if (event.schema === "doc-event/v1")
    return cell.canonicalSettlement(
      readDocReceipt(
        {
          binding,
          workspaceId: cell.input.repoId,
          rootDir: cell.rootDir,
          store: cell.store,
          projection: cell.projection,
          now: cell.now,
          killpoint: cell.input.killpoint,
        },
        event,
      ),
      event,
    );
  const publication = cell.publicPublication(cell.store.publication(event));
  if (isTaskProgressEvent(event)) return cell.canonicalSettlement(cell.progressReceipt(event, publication), event);
  const applied = cell.projection.readOperation(opId),
    visible = !!applied && applied.watermark >= event.workspaceRevision,
    proof = {
      committedRevision: event.workspaceRevision,
      appliedCut: applied?.watermark ?? 0,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: isTaskEvent(event) || event.schema === "decision-event/v1" ? true : null,
    };
  if (isEntityEvent(event)) {
    const claim = event.payload.declarationDocumentClaim,
      declarationProof = { ...proof, worktreeVisible: true },
      detail = {
        kind: "entity_upsert" as const,
        entityKind: event.payload.entityKind,
        entityId: event.payload.entityId,
        schemaId: requireEntityKindContract(event.payload.entityKind).schema.$id,
        path: claim.path,
      };
    return visible
      ? {
          outcome: "applied",
          opId,
          revision: event.workspaceRevision,
          evidence: JSON.stringify({
            event: {
              schema: event.schema,
              eventId: event.eventId,
              opId,
              path: claim.path,
            },
          }),
          visibility: "center",
          proof: declarationProof,
          detail,
          ...publication,
        }
      : {
          outcome: "pending",
          opId,
          revision: event.workspaceRevision,
          evidence: `event-object:${opId}`,
          visibility: "center",
          proof: declarationProof,
          detail,
          ...publication,
          nextAction: `Retry after the projection records declaration event ${opId}.`,
        };
  }
  if (isTaskEvent(event) && visible)
    return cell.lifecycleReceipt(event, cell.projection.read(event.taskId).snapshot, publication, proof);
  if (event.schema === "decision-event/v1" && visible) {
    const claim = event.payload.decisionDocumentClaim,
      consentId = "judgmentConsent" in event.payload ? event.payload.judgmentConsent.consentId : null;
    return {
      outcome: "applied",
      opId,
      revision: event.workspaceRevision,
      evidence: `event-object:${opId}`,
      visibility: "center",
      proof,
      path: claim.path,
      ...publication,
      documentSha256: claim.sha256,
      worktreeVisible: true,
      consentId,
    } as WriteReceipt;
  }
  return cell.canonicalSettlement(
    {
      outcome: "pending",
      opId,
      revision: event.workspaceRevision,
      evidence: `event-object:${opId}`,
      visibility: "center",
      proof,
      nextAction: "Projection catch-up may still be pending.",
    },
    event,
  );
}

export function canonicalSettlement(
  cell: any,
  receipt: WriteReceipt,
  event: ReturnType<typeof cell.store.readEvent> & object,
): WriteReceipt {
  const publication = cell.publicPublication(cell.store.publication(event)),
    proof = {
      ...cell.receiptProof(event, publication),
      worktreeVisible: receipt.proof?.worktreeVisible ?? null,
    },
    base = {
      ...receipt,
      revision: event.workspaceRevision,
      evidence: receipt.evidence ?? `event-object:${event.opId}`,
      visibility: "center" as const,
      proof,
      ...publication,
    };
  return proof.canonicalVisible
    ? { ...base, outcome: "applied" }
    : {
        ...base,
        outcome: "pending",
        nextAction: `Query receipt ${event.opId}; its canonical publication cut is not exact.`,
      };
}

export function projectedTaskIds(cell: any): Set<string> {
  if (cell.knownTaskIds) return cell.knownTaskIds;
  const read = cell.projection.list();
  if (read.watermark === read.sourceRevision) {
    cell.knownTaskIds = new Set(read.rows.map(({ taskId }: { readonly taskId: string }) => taskId));
    return cell.knownTaskIds;
  }
  const taskIds = new Set<string>();
  let cursor: string | null = null;
  try {
    for (;;) {
      const batch = cell.store.readBatch(cursor, 4096) as {
        readonly events: readonly CanonicalEventV1[];
        readonly cursor: string | null;
        readonly done: boolean;
      };
      for (const event of batch.events) if (isTaskEvent(event)) taskIds.add(event.taskId);
      if (batch.done) break;
      if (batch.cursor === cursor) throw new Error("canonical task event scan did not advance");
      cursor = batch.cursor;
    }
  } catch {
    throw cell.cellCodedError(
      "content_not_ready",
      [
        "Task projection is catching up from revision ",
        `${read.watermark}`,
        " to ",
        `${read.sourceRevision}`,
        "; task identity cannot be determined until the canonical event stream is readable.",
      ].join(""),
    );
  }
  cell.knownTaskIds = taskIds;
  return cell.knownTaskIds;
}

export function progressReceipt(
  cell: any,
  event: TaskProgressEventV1,
  publication: PublicPublication,
): TaskProgressReceipt {
  const applied = cell.projection.readOperation(event.opId),
    visible = !!applied && applied.watermark >= event.workspaceRevision;
  return {
    outcome: visible ? "applied" : "pending",
    opId: event.opId,
    revision: event.workspaceRevision,
    evidence: `event-object:${event.opId};file:${event.payload.resultDocumentClaim.path}`,
    visibility: "center",
    proof: {
      committedRevision: event.workspaceRevision,
      appliedCut: applied?.watermark ?? 0,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: true,
    },
    summary: `appended progress for ${event.payload.taskId} at ${event.payload.resultDocumentClaim.path}`,
    taskId: event.payload.taskId,
    executionId: event.payload.executionId,
    progressPath: event.payload.resultDocumentClaim.path,
    eventId: event.eventId,
    ...publication,
    worktreeVisible: true,
    nextAction: `ha task submit ${event.payload.taskId} --execution-id ${event.payload.executionId} ...`,
  };
}
