import path from "node:path";
import {
  cleanupRetiredAttributionFields,
  decisionIdFromEntityId,
  taskIdFromEntityId,
  type EntityId,
  type RetiredAttributionDocumentKind
} from "../../../domain/index.ts";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { resolveHarnessLayout, taskPackagePath, type HarnessLayoutInput } from "../../../layout/index.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import { rejectWrite } from "../rejection.ts";

interface RetiredAttributionFieldCleanupPayload {
  readonly schema: "retired-attribution-field-cleanup/v1";
  readonly documentKind: RetiredAttributionDocumentKind;
  readonly planId: string;
  readonly expectedSha256: string;
  readonly resultSha256: string;
}

export function retiredAttributionFieldCleanupTargetPath(
  rootInput: HarnessLayoutInput,
  op: Pick<WriteOp, "entityId" | "payload">
): string {
  const payload = readPayload(op.payload, op.entityId);
  if (payload.documentKind === "task-index") {
    const taskId = taskIdFromEntityId(op.entityId);
    if (!taskId) rejectWrite("task-index cleanup requires a task entity", op.entityId);
    return path.join(taskPackagePath(rootInput, taskId), "INDEX.md");
  }
  const decisionId = decisionIdFromEntityId(op.entityId);
  if (!decisionId) rejectWrite("decision cleanup requires a decision entity", op.entityId);
  return resolveHarnessLayout(rootInput).decisionDocumentPath(decisionId);
}

export function prepareRetiredAttributionFieldCleanup(
  targetPath: string,
  current: string,
  op: Pick<WriteOp, "entityId" | "payload">
): { readonly body: string; readonly alreadyApplied: boolean } {
  const payload = readPayload(op.payload, op.entityId);
  const currentSha256 = sha256Text(current);
  if (currentSha256 === payload.resultSha256) return { body: current, alreadyApplied: true };
  if (currentSha256 !== payload.expectedSha256) {
    rejectWrite(
      `retired attribution cleanup CAS mismatch for ${targetPath}: expected ${payload.expectedSha256}, found ${currentSha256}`,
      op.entityId
    );
  }
  let cleanup: ReturnType<typeof cleanupRetiredAttributionFields>;
  try {
    cleanup = cleanupRetiredAttributionFields(current, payload.documentKind);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
  const resultSha256 = sha256Text(cleanup.body);
  if (resultSha256 !== payload.resultSha256) {
    rejectWrite(
      `retired attribution cleanup result hash mismatch for ${targetPath}: expected ${payload.resultSha256}, derived ${resultSha256}`,
      op.entityId
    );
  }
  if (cleanup.authoredBodyBefore !== cleanup.authoredBodyAfter) {
    rejectWrite(`retired attribution cleanup would change authored body bytes: ${targetPath}`, op.entityId);
  }
  if (cleanup.contentPinArbitersBefore !== cleanup.contentPinArbitersAfter) {
    rejectWrite(`retired attribution cleanup would change contentPins[].arbiter: ${targetPath}`, op.entityId);
  }
  return { body: cleanup.body, alreadyApplied: false };
}

function readPayload(payload: unknown, entityId: EntityId): RetiredAttributionFieldCleanupPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    rejectWrite("retired attribution cleanup requires an object payload", entityId);
  }
  const candidate = payload as Partial<RetiredAttributionFieldCleanupPayload>;
  if (
    candidate.schema !== "retired-attribution-field-cleanup/v1" ||
    (candidate.documentKind !== "task-index" && candidate.documentKind !== "decision") ||
    typeof candidate.planId !== "string" ||
    candidate.planId.trim().length === 0 ||
    !isSha256(candidate.expectedSha256) ||
    !isSha256(candidate.resultSha256)
  ) {
    rejectWrite("retired attribution cleanup payload is malformed", entityId);
  }
  if (candidate.expectedSha256 === candidate.resultSha256) {
    rejectWrite("retired attribution cleanup must change the target document", entityId);
  }
  return candidate as RetiredAttributionFieldCleanupPayload;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
