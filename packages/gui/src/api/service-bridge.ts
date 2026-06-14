import path from "node:path";
import type { LocalControllerService } from "../../../application/src/index.ts";
import {
  readAppendProgressPayload,
  readSetStatusPayload,
  readTaskDocumentPayload,
  readTaskIdPayload
} from "../../../application/src/index.ts";
import { classifyShellOutput } from "../terminal/boundary.ts";
import { validateProjectPath } from "./local-api.ts";

export interface GuiServiceBridge {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
}

export function createGuiServiceBridgeForService(rootDir: string, service: LocalControllerService): GuiServiceBridge {
  return {
    invoke: async (method, payload) => dispatchGuiServiceMethod(rootDir, service, method, payload)
  };
}

export async function dispatchGuiServiceMethod(
  rootDir: string,
  service: LocalControllerService,
  method: string,
  payload: unknown
): Promise<unknown> {
  if (method === "getTasks") return service.getTasks();
  if (method === "getTaskDetail") {
    const parsed = readTaskIdPayload(payload);
    if (!parsed.ok) return parsed;
    return service.getTaskDetail(parsed);
  }
  if (method === "getTaskDocument") {
    const pathDecision = validateTaskDocumentPayloadPath(rootDir, payload);
    if (!pathDecision.ok) return pathDecision;
    const parsed = readTaskDocumentPayload(payload);
    if (!parsed.ok) return parsed;
    return service.getTaskDocument(parsed);
  }
  if (method === "setTaskStatus") {
    const parsed = readSetStatusPayload(payload);
    if (!parsed.ok) return parsed;
    return service.setTaskStatus(parsed);
  }
  if (method === "reviewTask") {
    const parsed = readTaskIdPayload(payload);
    if (!parsed.ok) return parsed;
    return service.reviewTask(parsed);
  }
  if (method === "archiveTask") return service.archiveTask();
  if (method === "appendTaskProgress") {
    const parsed = readAppendProgressPayload(payload);
    if (!parsed.ok) return parsed;
    return service.appendTaskProgress(parsed);
  }
  if (method === "rebuildGovernance") return service.rebuildGovernance();
  if (method === "openShell") {
    return {
      ...service.openShell(),
      sampleClassification: classifyShellOutput("")
    };
  }
  return {
    ok: false,
    error: {
      code: "method_not_allowed",
      hint: `Unsupported GUI service method: ${method}`
    }
  };
}

function validateTaskDocumentPayloadPath(rootDir: string, payload: unknown): { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: { code: "invalid_payload", hint: "taskId and path are required." } };
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.taskId !== "string" || typeof record.path !== "string") {
    return { ok: false, error: { code: "invalid_payload", hint: "taskId and path are required." } };
  }
  const decision = validateProjectPath(rootDir, path.join("harness", "planning", "tasks", record.taskId, record.path));
  if (!decision.ok) {
    return {
      ok: false,
      error: {
        code: decision.reason ?? "path_rejected",
        hint: "Requested document path is outside the public task package."
      }
    };
  }
  return { ok: true };
}
