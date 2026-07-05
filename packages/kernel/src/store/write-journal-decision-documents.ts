import { mkdirSync } from "node:fs";
import path from "node:path";
import { decisionIdFromEntityId } from "../domain/index.ts";
import { isDecisionDocumentPayload, serializeDecisionDocument } from "../domain/decision-document.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { writeFileDurably } from "./write-journal-durable.ts";
import { rejectWrite } from "./write-journal-rejection.ts";

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
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileDurably(targetPath, serializeDecisionDocument(op.payload, op.opId));
}

export function decisionDocumentTargetPath(rootInput: HarnessLayoutInput, op: Pick<WriteOp, "entityId" | "payload">): string {
  const decisionId = decisionIdFromEntityId(op.entityId);
  if (!decisionId) rejectWrite(`decision write op requires decision entity: ${op.entityId}`, op.entityId);
  if (isDecisionDocumentPayload(op.payload) && op.payload.decision.decision_id !== decisionId) {
    rejectWrite(`decision payload id ${op.payload.decision.decision_id} does not match entity ${op.entityId}`, op.entityId);
  }
  return resolveHarnessLayout(rootInput).decisionDocumentPath(decisionId);
}
