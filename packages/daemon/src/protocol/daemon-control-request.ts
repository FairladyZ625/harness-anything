import type { DaemonControlRequestV1 } from "../../../application/src/index.ts";
import type { JsonObject } from "./json-rpc-types.ts";

export function daemonControlRequest(
  method: "admin.daemon.restart" | "admin.daemon.refresh",
  payload: JsonObject
): { readonly ok: true; readonly value: DaemonControlRequestV1 } | { readonly ok: false; readonly code: string; readonly hint: string } {
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
  return {
    ok: true,
    value: {
      reason: payload.reason,
      drainTimeoutMs: Number(payload.drainTimeoutMs),
      ...(method === "admin.daemon.refresh" ? { trigger: payload.trigger as DaemonControlRequestV1["trigger"] } : {})
    }
  };
}
