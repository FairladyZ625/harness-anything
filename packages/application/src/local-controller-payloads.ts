import { normalizeRelativeDocumentPath, validateTaskIdSyntax } from "../../kernel/src/index.ts";
import type { LocalControllerFailure } from "./index.ts";
import { isRecord } from "./record.ts";

export function readTaskIdPayload(payload: unknown): { readonly ok: true; readonly taskId: string } | LocalControllerFailure {
  if (!isRecord(payload) || typeof payload.taskId !== "string") {
    return invalidPayload("taskId is required.");
  }
  try {
    validateLocalControllerTaskId(payload.taskId);
  } catch {
    return invalidPayload("taskId is invalid.");
  }
  return { ok: true, taskId: payload.taskId };
}

export function readTaskDocumentPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly path: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.path !== "string") {
    return invalidPayload("path is required.");
  }
  try {
    return { ok: true, taskId: taskPayload.taskId, path: normalizeRelativeDocumentPath(payload.path) };
  } catch {
    return invalidPayload("portable document path is required.");
  }
}

export function validateLocalControllerTaskId(taskId: string): void {
  validateTaskIdSyntax(taskId);
}

export function validateLocalControllerDecisionId(decisionId: string): void {
  if (decisionId.length === 0 || decisionId.includes("/") || decisionId.includes("..")) {
    throw new Error("Invalid decision id.");
  }
}

function invalidPayload(hint: string): LocalControllerFailure {
  return { ok: false, error: { code: "invalid_payload", hint } };
}
