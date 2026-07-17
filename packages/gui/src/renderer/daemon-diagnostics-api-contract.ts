import type {
  DaemonControlAcceptedV1,
  DaemonLogEntryV1,
  DaemonLogPageV1,
  DaemonRendererStatusV2
} from "../api/renderer-dto.ts";

export function readDaemonStatusResult(value: unknown): DaemonRendererStatusV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(daemonDiagnosticsErrorHint(value, "Daemon status bridge returned an invalid result."));
  }
  const result = value as Partial<DaemonRendererStatusV2> & { readonly ok?: boolean };
  if (result.ok === false) throw new Error(daemonDiagnosticsErrorHint(value, "Daemon status bridge returned an error."));
  if (result.schema !== "daemon-status/v2") {
    throw new Error(`Daemon status schema must be daemon-status/v2, got ${String(result.schema)}.`);
  }
  if (!result.service || typeof result.service !== "object") throw new Error("Daemon status.service is required.");
  if (!Array.isArray(result.repos)) throw new Error("Daemon status.repos must be an array.");
  return result as DaemonRendererStatusV2;
}

export function readDaemonLogPageResult(value: unknown): DaemonLogPageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(daemonDiagnosticsErrorHint(value, "Daemon log bridge returned an invalid result."));
  }
  const result = value as Partial<DaemonLogPageV1> & { readonly ok?: boolean };
  if (result.ok === false) throw new Error(daemonDiagnosticsErrorHint(value, "Daemon log bridge returned an error."));
  if (result.schema !== "daemon-log-page/v1" || !Array.isArray(result.entries)
    || result.entries.length > 200 || !result.entries.every(isDaemonLogEntry)
    || (result.nextCursor !== null && typeof result.nextCursor !== "string")
    || typeof result.truncated !== "boolean"
    || !Number.isInteger(result.droppedCount) || Number(result.droppedCount) < 0) {
    throw new Error("Daemon log bridge returned data outside daemon-log-page/v1.");
  }
  return result as DaemonLogPageV1;
}

export type DaemonRestartResult =
  | { readonly ok: true; readonly accepted: DaemonControlAcceptedV1 }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly operationId?: string | null } };

/**
 * Reads the daemon restart bridge result.
 * Success returns daemon-control-accepted/v1; failure surfaces control error codes
 * such as daemon_restart_failed / daemon_control_in_progress.
 */
export function readDaemonRestartResult(value: unknown): DaemonRestartResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_result",
        hint: daemonDiagnosticsErrorHint(value, "Daemon restart bridge returned an invalid result.")
      }
    };
  }
  const result = value as {
    readonly ok?: boolean;
    readonly schema?: string;
    readonly accepted?: boolean;
    readonly operationId?: string;
    readonly kind?: string;
    readonly error?: { readonly code?: string; readonly hint?: string; readonly operationId?: string | null };
  };
  if (result.ok === false || (result.error && typeof result.error === "object")) {
    const error = result.error ?? {};
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : "daemon_restart_failed",
        hint: typeof error.hint === "string" ? error.hint : "Daemon restart failed.",
        ...(error.operationId !== undefined ? { operationId: error.operationId } : {})
      }
    };
  }
  if (
    result.schema === "daemon-control-accepted/v1"
    && result.accepted === true
    && result.kind === "restart"
    && typeof result.operationId === "string"
    && result.operationId.length > 0
  ) {
    return { ok: true, accepted: result as unknown as DaemonControlAcceptedV1 };
  }
  return {
    ok: false,
    error: {
      code: "invalid_result",
      hint: "Daemon restart bridge did not return daemon-control-accepted/v1."
    }
  };
}

function isDaemonLogEntry(value: unknown): value is DaemonLogEntryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DaemonLogEntryV1>;
  return entry.schema === "daemon-log-entry/v1"
    && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
    && Number.isInteger(entry.sequence) && Number(entry.sequence) >= 0
    && typeof entry.level === "string" && ["debug", "info", "warn", "error", "fatal"].includes(entry.level)
    && (entry.source === "daemon" || entry.source === "cli")
    && typeof entry.component === "string" && typeof entry.event === "string" && typeof entry.message === "string"
    && entry.redaction?.policy === "runtime-log-redaction/v1"
    && Array.isArray(entry.redaction.fieldsRemoved) && typeof entry.redaction.truncated === "boolean";
}

function daemonDiagnosticsErrorHint(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as { readonly error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const hint = (error as { readonly hint?: unknown }).hint;
  return typeof hint === "string" ? hint : fallback;
}
