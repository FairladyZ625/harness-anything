import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { interactiveRpcDescriptor } from "@harness-anything/daemon/protocol";
import { assertRendererRpc, RPC_CHANNEL } from "../preload/allowlist.ts";
import { isMainProcessRecord } from "./value-validation.ts";
import type { GuiServiceBridge } from "./local-composition-root.ts";
import { assertTrustedIpcSender } from "./ipc-trust.ts";
export { assertTrustedIpcSender } from "./ipc-trust.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { registerAgentRuntimeIpc } from "./agent-runtime-ipc.ts";
export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>,
  ) => void;
  readonly on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => void;
}
export function registerHarnessIpcHandlers(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(RPC_CHANNEL, async (event, value) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (!isMainProcessRecord(value) || typeof value.method !== "string" || !isMainProcessRecord(value.params))
      throw new Error("Invalid renderer RPC envelope.");
    assertRendererRpc(value.method, value.params);
    return bridge.invoke(value.method, value.params as Parameters<GuiServiceBridge["invoke"]>[1]);
  });
  registerAgentRuntimeIpc(registrar, bridge, trustPolicy);
}

const MAX_IPC_TRACE_ENTRIES = 200;
const SAFE_IPC_SUMMARY_FIELDS = new Set([
  "repoId",
  "taskId",
  "entityRef",
  "runtimeSessionId",
  "dispatchId",
  "decisionId",
  "scheduleId",
  "instanceId",
  "providerId",
  "name",
  "facet",
  "projection",
  "state",
  "status",
  "kind",
  "limit",
  "groupBy",
  "range",
]);
const SENSITIVE_IPC_KEY_PATTERN = /key|secret|token|password|credential|auth|cookie|body|content|env/iu;

interface IpcTraceEntry {
  readonly seq: number;
  readonly channel: string;
  readonly method?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly result: "ok" | "ipc_failure" | "error";
  readonly errorCode?: string;
  readonly payloadSummary: unknown;
}

function sanitizeIpcPayloadSummary(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return { type: typeof payload };
  if (Array.isArray(payload)) return { type: "array", length: payload.length };
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const fields: Record<string, unknown> = {};
  const redactedKeys: string[] = [];
  for (const key of keys) {
    if (SENSITIVE_IPC_KEY_PATTERN.test(key)) {
      redactedKeys.push(key);
      continue;
    }
    if (!SAFE_IPC_SUMMARY_FIELDS.has(key)) continue;
    const value = record[key];
    if (typeof value === "string") {
      fields[key] = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  return {
    keys,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(redactedKeys.length > 0 ? { redactedKeys } : {}),
  };
}

/** Electron drops Error properties; preserve domain failures across this process boundary. */
export function withIpcDomainErrors(registrar: HarnessIpcRegistrar): HarnessIpcRegistrar {
  const traceEnabled = process.env.HARNESS_GUI_IPC_TRACE === "1";
  const entries: IpcTraceEntry[] = [];
  let seq = 0;
  if (traceEnabled) {
    (globalThis as Record<string, unknown>).__harnessGuiIpcTrace = {
      snapshot(clear = false) {
        const copy = entries.slice();
        if (clear) entries.length = 0;
        return copy;
      },
    };
  }
  const pushTrace = (entry: IpcTraceEntry) => {
    entries.push(entry);
    if (entries.length > MAX_IPC_TRACE_ENTRIES) entries.splice(0, entries.length - MAX_IPC_TRACE_ENTRIES);
  };
  return {
    on: (channel, listener) => registrar.on(channel, listener),
    handle: (channel, listener) =>
      registrar.handle(channel, async (event, payload) => {
        const startedMs = traceEnabled ? Date.now() : 0;
        const startedAt = traceEnabled ? new Date(startedMs).toISOString() : "";
        const envelope = traceEnabled && channel === RPC_CHANNEL && isMainProcessRecord(payload) ? payload : null;
        const method =
          typeof envelope?.method === "string" ? interactiveRpcDescriptor(envelope.method)?.method : undefined;
        const params = envelope?.params;
        const tracePayload = isMainProcessRecord(params)
          ? {
              ...(isMainProcessRecord(params.payload) ? params.payload : {}),
              ...(isMainProcessRecord(params.repo) ? params.repo : {}),
            }
          : payload;
        const payloadSummary = traceEnabled ? sanitizeIpcPayloadSummary(tracePayload) : null;
        try {
          const reply = await listener(event, payload);
          if (traceEnabled) {
            const replyObj = reply !== null && typeof reply === "object" ? (reply as Record<string, unknown>) : null;
            const replyFailure =
              replyObj && replyObj.ok === false && typeof replyObj.code === "string" ? replyObj.code : undefined;
            pushTrace({
              seq: ++seq,
              channel,
              ...(method === undefined ? {} : { method }),
              startedAt,
              durationMs: Date.now() - startedMs,
              result: replyFailure ? "ipc_failure" : "ok",
              ...(replyFailure ? { errorCode: replyFailure } : {}),
              payloadSummary,
            });
          }
          return reply;
        } catch (error) {
          const isDomainError = error instanceof Error && "code" in error && typeof error.code === "string";
          if (traceEnabled) {
            pushTrace({
              seq: ++seq,
              channel,
              ...(method === undefined ? {} : { method }),
              startedAt,
              durationMs: Date.now() - startedMs,
              result: isDomainError ? "ipc_failure" : "error",
              ...(isDomainError ? { errorCode: String((error as { readonly code: string }).code) } : {}),
              payloadSummary,
            });
          }
          if (!isDomainError) throw error;
          return { ipcFailure: { code: (error as { readonly code: string }).code, message: error.message } };
        }
      }),
  };
}
