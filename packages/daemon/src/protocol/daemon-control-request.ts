import type { DaemonControlRequestV1 } from "@harness-anything/application";
import type { JsonObject } from "./json-rpc-types.ts";

export function daemonControlRequest(
  method: "admin.daemon.restart" | "admin.daemon.refresh",
  payload: JsonObject
): { readonly ok: true; readonly kind: "restart" | "refresh" | "upgrade"; readonly value: DaemonControlRequestV1 }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  const cliCommand = method === "admin.daemon.refresh" ? "ha daemon refresh" : "ha daemon restart";
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.reason. Retry with \`${cliCommand} --reason "operator request"\`.` };
  }
  if (!Number.isSafeInteger(payload.drainTimeoutMs) || Number(payload.drainTimeoutMs) < 100 || Number(payload.drainTimeoutMs) > 120_000) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.drainTimeoutMs from 100 through 120000. Retry with \`${cliCommand} --timeout-ms 5000\`.` };
  }
  if (method === "admin.daemon.refresh"
    && payload.trigger !== "explicit"
    && payload.trigger !== "post-merge"
    && payload.trigger !== "dist-watcher") {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.trigger explicit|post-merge|dist-watcher. Retry with \`ha daemon refresh --trigger explicit\`.` };
  }
  if (payload.kind !== undefined && (method !== "admin.daemon.refresh" || payload.kind !== "upgrade")) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} only accepts payload.kind=upgrade on the refresh transport.` };
  }
  if (payload.daemonGeneration !== undefined
    && (!Number.isSafeInteger(payload.daemonGeneration) || Number(payload.daemonGeneration) < 1)) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.daemonGeneration to be a positive safe integer. Read the current value from \`ha daemon status --json --include-generation-axes\`, or omit the field to use legacy control.` };
  }
  if (payload.connectionId !== undefined
    && (typeof payload.connectionId !== "string" || payload.connectionId.length === 0)) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.connectionId to be a non-empty string. Reuse the connectionId from your accepted connection, or omit the field to use legacy control.` };
  }
  return {
    ok: true,
    kind: method === "admin.daemon.restart" ? "restart" : payload.kind === "upgrade" ? "upgrade" : "refresh",
    value: {
      reason: payload.reason,
      drainTimeoutMs: Number(payload.drainTimeoutMs),
      ...(method === "admin.daemon.refresh" ? { trigger: payload.trigger as DaemonControlRequestV1["trigger"] } : {}),
      ...(payload.daemonGeneration !== undefined ? { daemonGeneration: Number(payload.daemonGeneration) } : {}),
      ...(payload.connectionId !== undefined ? { connectionId: payload.connectionId as string } : {})
    }
  };
}
