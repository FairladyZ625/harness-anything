import path from "node:path";
import type { LocalControllerService } from "../../../application/src/index.ts";
import {
  readAppendProgressPayload,
  readSetStatusPayload,
  readTaskDocumentPayload,
  readTaskIdPayload
} from "../../../application/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, normalizeRelativeDocumentPath, resolveHarnessRuntimeContext, taskDocumentPath } from "../../../kernel/src/index.ts";
import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, deferredGuiBridgeContracts } from "./api-contract-registry.ts";
import { validateProjectPath } from "./local-api.ts";

export interface GuiServiceBridge {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
}

type ShippedGuiBridgeRoute = Extract<(typeof apiRouteContracts)[number], { readonly guiBridgeMethod: PreloadApiMethod }>;
type ShippedGuiBridgeMethod = ShippedGuiBridgeRoute["guiBridgeMethod"];

interface GuiBridgeHandlerContext {
  readonly rootDir: string;
  readonly layoutInput: HarnessLayoutInput;
  readonly service: LocalControllerService;
  readonly payload: unknown;
}

interface GuiBridgeHandlerImplementation {
  readonly serviceMethod: keyof LocalControllerService;
  readonly invoke: (context: GuiBridgeHandlerContext) => Promise<unknown> | unknown;
}

export const guiBridgeHandlerImplementations = {
  getTasks: {
    serviceMethod: "getTasks",
    invoke: ({ service }) => service.getTasks()
  },
  getTaskDetail: {
    serviceMethod: "getTaskDetail",
    invoke: ({ service, payload }) => {
      const parsed = readTaskIdPayload(payload);
      if (!parsed.ok) return parsed;
      return service.getTaskDetail(parsed);
    }
  },
  getTaskDocument: {
    serviceMethod: "getTaskDocument",
    invoke: ({ rootDir, layoutInput, service, payload }) => {
      const pathDecision = validateTaskDocumentPayloadPath(rootDir, layoutInput, payload);
      if (!pathDecision.ok) return pathDecision;
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      return service.getTaskDocument(parsed);
    }
  },
  setTaskStatus: {
    serviceMethod: "setTaskStatus",
    invoke: ({ service, payload }) => {
      const parsed = readSetStatusPayload(payload);
      if (!parsed.ok) return parsed;
      return service.setTaskStatus(parsed);
    }
  },
  reviewTask: {
    serviceMethod: "reviewTask",
    invoke: ({ service, payload }) => {
      const parsed = readTaskIdPayload(payload);
      if (!parsed.ok) return parsed;
      return service.reviewTask(parsed);
    }
  },
  appendTaskProgress: {
    serviceMethod: "appendTaskProgress",
    invoke: ({ service, payload }) => {
      const parsed = readAppendProgressPayload(payload);
      if (!parsed.ok) return parsed;
      return service.appendTaskProgress(parsed);
    }
  },
  rebuildGovernance: {
    serviceMethod: "rebuildGovernance",
    invoke: ({ service }) => service.rebuildGovernance()
  }
} as const satisfies Record<ShippedGuiBridgeMethod, GuiBridgeHandlerImplementation>;

export function getShippedGuiBridgeMethods(): ReadonlyArray<ShippedGuiBridgeMethod> {
  return apiRouteContracts.flatMap((route) => "guiBridgeMethod" in route && route.guiBridgeMethod ? [route.guiBridgeMethod] : []) as ReadonlyArray<ShippedGuiBridgeMethod>;
}

const shippedGuiBridgeMethods = new Set<PreloadApiMethod>(getShippedGuiBridgeMethods());
const deferredGuiBridgeReasons = new Map<PreloadApiMethod, string>(
  deferredGuiBridgeContracts.map((entry) => [entry.guiBridgeMethod, entry.reason])
);

export function createGuiServiceBridgeForService(
  rootDir: string,
  service: LocalControllerService,
  layoutOverrides?: HarnessLayoutOverrides
): GuiServiceBridge {
  const layoutInput = resolveHarnessRuntimeContext(createHarnessRuntimeContext(rootDir, layoutOverrides));
  return {
    invoke: async (method, payload) => dispatchGuiServiceMethod(layoutInput.rootDir, layoutInput, service, method, payload)
  };
}

export async function dispatchGuiServiceMethod(
  rootDir: string,
  layoutInput: HarnessLayoutInput,
  service: LocalControllerService,
  method: string,
  payload: unknown
): Promise<unknown> {
  if (shippedGuiBridgeMethods.has(method as PreloadApiMethod)) {
    const handler = guiBridgeHandlerImplementations[method as ShippedGuiBridgeMethod];
    return handler.invoke({ rootDir, layoutInput, service, payload });
  }
  const deferredReason = deferredGuiBridgeReasons.get(method as PreloadApiMethod);
  if (deferredReason) {
    return {
      ok: false,
      error: {
        code: "method_deferred",
        hint: deferredReason
      }
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

function validateTaskDocumentPayloadPath(
  rootDir: string,
  layoutInput: HarnessLayoutInput,
  payload: unknown
): { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: { code: "invalid_payload", hint: "taskId and path are required." } };
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.taskId !== "string" || typeof record.path !== "string") {
    return { ok: false, error: { code: "invalid_payload", hint: "taskId and path are required." } };
  }
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(record.path);
  } catch {
    return { ok: false, error: { code: "invalid_payload", hint: "Portable document path is required." } };
  }
  let relativeDocumentPath: string;
  try {
    relativeDocumentPath = path.relative(rootDir, taskDocumentPath(layoutInput, record.taskId, documentPath));
  } catch {
    return { ok: false, error: { code: "invalid_payload", hint: "taskId is invalid." } };
  }
  const decision = validateProjectPath(rootDir, relativeDocumentPath);
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
