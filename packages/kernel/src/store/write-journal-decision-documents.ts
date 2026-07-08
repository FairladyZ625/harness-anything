import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decisionIdFromEntityId } from "../domain/index.ts";
import { isDecisionDocumentPayload, parseDecisionDocument, readDecisionWatermark, serializeDecisionDocument, type DecisionDocumentPayload } from "../domain/decision-document.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { writeFileDurably } from "./write-journal-durable.ts";
import { rejectCasWatermarkMismatch, rejectWrite } from "./write-journal-rejection.ts";

export const decisionWriteKinds = new Set<WriteOp["kind"]>([
  "decision_propose",
  "decision_accept",
  "decision_reject",
  "decision_defer",
  "decision_supersede",
  "decision_amend",
  "decision_relate",
  "decision_retire",
  "relation_retire",
  "relation_replace"
]);

export function writeDecisionDocument(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const targetPath = decisionDocumentTargetPath(rootInput, op);
  if (!isDecisionDocumentPayload(op.payload)) {
    rejectWrite(`${op.kind} op requires decision document payload: ${op.opId}`, op.entityId);
  }
  const payload = op.payload.writeMode?.kind === "append_relation"
    ? appendDecisionRelationPayload(targetPath, op.payload)
    : casSnapshotPayload(targetPath, op);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileDurably(targetPath, serializeDecisionDocument(payload, op.opId));
}

export function decisionDocumentTargetPath(rootInput: HarnessLayoutInput, op: Pick<WriteOp, "entityId" | "payload">): string {
  const decisionId = decisionIdFromEntityId(op.entityId);
  if (!decisionId) rejectWrite(`decision write op requires decision entity: ${op.entityId}`, op.entityId);
  if (isDecisionDocumentPayload(op.payload) && op.payload.decision.decision_id !== decisionId) {
    rejectWrite(`decision payload id ${op.payload.decision.decision_id} does not match entity ${op.entityId}`, op.entityId);
  }
  return resolveHarnessLayout(rootInput).decisionDocumentPath(decisionId);
}

function casSnapshotPayload(targetPath: string, op: WriteOp): DecisionDocumentPayload {
  if (!isDecisionDocumentPayload(op.payload)) {
    rejectWrite(`${op.kind} op requires decision document payload: ${op.opId}`, op.entityId);
  }
  const mode = op.payload.writeMode;
  if (mode?.kind !== "snapshot" || !("expectedWatermark" in mode)) return op.payload;
  const currentWatermark = existsSync(targetPath) ? readDecisionWatermark(readFileSync(targetPath, "utf8")) : null;
  if (currentWatermark !== (mode.expectedWatermark ?? null)) {
    rejectCasWatermarkMismatch({
      entityId: op.entityId,
      expectedWatermark: mode.expectedWatermark ?? null,
      currentWatermark
    });
  }
  return op.payload;
}

function appendDecisionRelationPayload(
  targetPath: string,
  payload: DecisionDocumentPayload
): DecisionDocumentPayload {
  const mode = payload.writeMode;
  if (!isDecisionDocumentPayload(payload) || mode?.kind !== "append_relation") {
    rejectWrite("append relation payload requires decision document payload");
  }
  if (!existsSync(targetPath)) {
    const relations = payload.decision.relations.some((relation) => relation.relation_id === mode.relation.relation_id)
      ? payload.decision.relations
      : [...payload.decision.relations, mode.relation];
    return { ...payload, decision: { ...payload.decision, relations } };
  }

  const current = parseDecisionDocument(readFileSync(targetPath, "utf8"));
  if (current.decision.relations.some((relation) => relation.relation_id === mode.relation.relation_id)) {
    return current;
  }
  return {
    ...current,
    decision: {
      ...current.decision,
      relations: [...current.decision.relations, mode.relation]
    }
  };
}
