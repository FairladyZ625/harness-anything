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
  // A decision document carries the op id that authored it. If a previous flush
  // applied the file and then died before its global watermark, this equality is
  // definitive replay evidence rather than a stale-CAS conflict. Keep the bytes
  // already on disk; companion task writes (if any) are still applied by the
  // caller so a partially applied transaction can finish converging.
  if (existsSync(targetPath) && readDecisionWatermark(readFileSync(targetPath, "utf8")) === op.opId) {
    return;
  }
  const materialized = op.payload.writeMode?.kind === "append_relation"
    ? appendDecisionRelationPayload(targetPath, op.payload)
    : casSnapshotPayload(targetPath, op);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileDurably(targetPath, serializeDecisionDocument(materialized.payload, op.opId, materialized.bodyTail));
}

export function decisionDocumentTargetPath(rootInput: HarnessLayoutInput, op: Pick<WriteOp, "entityId" | "payload">): string {
  const decisionId = decisionIdFromEntityId(op.entityId);
  if (!decisionId) rejectWrite(`decision write op requires decision entity: ${op.entityId}`, op.entityId);
  if (isDecisionDocumentPayload(op.payload) && op.payload.decision.decision_id !== decisionId) {
    rejectWrite(`decision payload id ${op.payload.decision.decision_id} does not match entity ${op.entityId}`, op.entityId);
  }
  return resolveHarnessLayout(rootInput).decisionDocumentPath(decisionId);
}

interface MaterializedDecisionDocument {
  readonly payload: DecisionDocumentPayload;
  readonly bodyTail?: string;
}

function casSnapshotPayload(targetPath: string, op: WriteOp): MaterializedDecisionDocument {
  if (!isDecisionDocumentPayload(op.payload)) {
    rejectWrite(`${op.kind} op requires decision document payload: ${op.opId}`, op.entityId);
  }
  const mode = op.payload.writeMode;
  const currentDocument = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  if (mode?.kind !== "snapshot" || !("expectedWatermark" in mode)) {
    return bodyPreservingSnapshot(op.payload, currentDocument);
  }
  const currentWatermark = currentDocument === null ? null : readDecisionWatermark(currentDocument);
  if (currentWatermark !== (mode.expectedWatermark ?? null)) {
    rejectCasWatermarkMismatch({
      entityId: op.entityId,
      expectedWatermark: mode.expectedWatermark ?? null,
      currentWatermark
    });
  }
  return bodyPreservingSnapshot(op.payload, currentDocument);
}

function appendDecisionRelationPayload(
  targetPath: string,
  payload: DecisionDocumentPayload
): MaterializedDecisionDocument {
  const mode = payload.writeMode;
  if (!isDecisionDocumentPayload(payload) || mode?.kind !== "append_relation") {
    rejectWrite("append relation payload requires decision document payload");
  }
  if (!existsSync(targetPath)) {
    const relations = payload.decision.relations.some((relation) => relation.relation_id === mode.relation.relation_id)
      ? payload.decision.relations
      : [...payload.decision.relations, mode.relation];
    return { payload: { ...payload, decision: { ...payload.decision, relations } } };
  }

  const currentDocument = readFileSync(targetPath, "utf8");
  const current = parseDecisionDocument(currentDocument);
  const bodyTail = decisionBodyTail(currentDocument);
  if (current.decision.relations.some((relation) => relation.relation_id === mode.relation.relation_id)) {
    return { payload: current, bodyTail };
  }
  return {
    payload: {
      ...current,
      decision: {
        ...current.decision,
        relations: [...current.decision.relations, mode.relation]
      }
    },
    bodyTail
  };
}

function bodyPreservingSnapshot(
  payload: DecisionDocumentPayload,
  currentDocument: string | null
): MaterializedDecisionDocument {
  if (payload.body !== undefined || currentDocument === null) return { payload };
  const currentBodyTail = decisionBodyTail(currentDocument);
  const appendBody = payload.writeMode?.kind === "snapshot" ? payload.writeMode.appendBody : undefined;
  return {
    payload,
    bodyTail: appendBody ? appendBodySection(currentBodyTail, appendBody) : currentBodyTail
  };
}

function decisionBodyTail(document: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/u.exec(document)?.[0];
  if (!frontmatter) rejectWrite("decision document missing frontmatter");
  return document.slice(frontmatter.length);
}

function appendBodySection(currentBodyTail: string, section: string): string {
  const heading = section.split(/\r?\n/u, 1)[0];
  if (heading && currentBodyTail.split(/\r?\n/u).includes(heading)) return currentBodyTail;
  const separator = currentBodyTail.endsWith("\n\n") ? "" : currentBodyTail.endsWith("\n") ? "\n" : "\n\n";
  return `${currentBodyTail}${separator}${section}\n`;
}
