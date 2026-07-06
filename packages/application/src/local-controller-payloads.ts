import type { DomainStatus } from "../../kernel/src/index.ts";
import { isDomainStatus, normalizeRelativeDocumentPath, validateTaskIdSyntax } from "../../kernel/src/index.ts";
import type { LocalControllerFailure } from "./index.ts";

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

export function readSetStatusPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly status: DomainStatus } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.status !== "string" || !isDomainStatus(payload.status)) {
    return invalidPayload("valid status is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, status: payload.status };
}

export function readAppendProgressPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly text: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.text !== "string" || payload.text.length === 0) {
    return invalidPayload("text is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, text: payload.text };
}

export function validateLocalControllerTaskId(taskId: string): void {
  validateTaskIdSyntax(taskId);
}

function invalidPayload(hint: string): LocalControllerFailure {
  return { ok: false, error: { code: "invalid_payload", hint } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
