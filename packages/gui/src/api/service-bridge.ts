import path from "node:path";
import type { LocalControllerService } from "../../../application/src/index.ts";
import { makeLocalControllerService } from "../../../application/src/index.ts";
import { classifyShellOutput } from "../terminal/boundary.ts";
import { validateProjectPath } from "./local-api.ts";

export interface GuiServiceBridge {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
}

export function createGuiServiceBridge(rootDir: string): GuiServiceBridge {
  return createGuiServiceBridgeForService(path.resolve(rootDir), makeLocalControllerService({ rootDir }));
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
  if (method === "getTaskDetail") return service.getTaskDetail(payload);
  if (method === "getTaskDocument") {
    const pathDecision = validateTaskDocumentPayloadPath(rootDir, payload);
    if (!pathDecision.ok) return pathDecision;
    return service.getTaskDocument(payload);
  }
  if (method === "setTaskStatus") return service.setTaskStatus(payload);
  if (method === "reviewTask") return service.reviewTask(payload);
  if (method === "archiveTask") return service.archiveTask();
  if (method === "appendTaskProgress") return service.appendTaskProgress(payload);
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
  const decision = validateProjectPath(rootDir, path.join("tasks", record.taskId, record.path));
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
