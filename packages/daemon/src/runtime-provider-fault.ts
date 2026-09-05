import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import type { ActiveRuntime, ProviderFrame } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeProviderFault } from "./runtime-fallback-contract.ts";

const quota =
    /\b(?:quota|usage limit|credit balance|insufficient[_ -]?quota|resource[_ -]?exhausted)\b|使用上限|配额/iu,
  model = /\b(?:unrecognized[_ -]?model|model[_ -]?not[_ -]?found|unknown[_ -]?model)\b/iu,
  auth = /\b(?:unauthorized|unauthenticated|authentication failed|invalid[_ -]?(?:api[_ -]?key|token)|forbidden)\b/iu;

export function providerFaultFromFrame(
  kindId: RuntimeInstanceKind,
  value: Record<string, unknown>,
): RuntimeProviderFault | null {
  if (kindId === "claude") {
    const responseCode = integer(value.api_error_status) ?? integer(value.error_status),
      error = diagnosticText(value.error),
      diagnostic = diagnosticText(value.result) ?? error;
    return providerFaultFromDiagnostic(responseCode, error, diagnostic, resetAtFrom(value));
  }
  if (kindId === "codex" && value.type === "turn.failed") {
    const detail = diagnosticRecord(value.error),
      responseCode = integer(detail?.http_status) ?? integer(detail?.status),
      code = diagnosticText(detail?.code),
      diagnostic = diagnosticText(detail?.message) ?? (detail ? JSON.stringify(detail) : null);
    return providerFaultFromDiagnostic(responseCode, code, diagnostic, resetAtFrom(detail ?? value));
  }
  if (kindId === "agy" && value.event === "result") {
    const result = diagnosticRecord(value.result),
      diagnostic = diagnosticText(result?.error),
      responseCode = integer(result?.status_code),
      code = diagnosticText(result?.code);
    return providerFaultFromDiagnostic(responseCode, code, diagnostic, resetAtFrom(result ?? value));
  }
  if (kindId === "zcode" && value.type === "turn.failed") {
    const payload = diagnosticRecord(value.payload),
      detail = diagnosticRecord(payload?.error) ?? payload,
      attribution = diagnosticRecord(detail?.attribution) ?? diagnosticRecord(payload?.attribution),
      responseCode = integer(attribution?.statusCode) ?? integer(detail?.statusCode) ?? integer(detail?.status),
      code = diagnosticText(detail?.code),
      diagnostic = diagnosticText(detail?.message) ?? (detail ? JSON.stringify(detail) : null);
    return providerFaultFromDiagnostic(responseCode, code, diagnostic, resetAtFrom(attribution ?? detail ?? value));
  }
  return null;
}

export function providerFaultFromStderr(kindId: RuntimeInstanceKind, stderr: string): RuntimeProviderFault | null {
  const normalized = stderr.trim();
  if (!normalized) return null;
  if (kindId === "claude") {
    const tagged = /^\[claude-code:([^\]]+)\]/imu.exec(normalized)?.[1] ?? null;
    if (tagged === "unrecognized_model") return fault("unrecognized_model", normalized);
    if (tagged && /auth|unauthor|forbidden/iu.test(tagged)) return fault("auth_failed", normalized);
  }
  return null;
}

export function classifyRuntimeExit(
  active: ActiveRuntime,
  exitCode: number | null,
): RuntimeAttemptOutcome & { readonly outcome: RuntimeExitOutcome } {
  const outcome = runtimeExitOutcome(active, exitCode),
    provider = { instance: active.instanceId, model: active.model, kind: active.kindId },
    attemptGroupId = active.fallbackAttempt?.attemptGroupId ?? active.dispatchId,
    attemptIndex = active.fallbackAttempt?.attemptIndex ?? 0,
    attemptFailed = exitCode === null || exitCode !== 0 || active.providerOutcome === "failed",
    providerFault =
      active.providerFault ?? providerFaultFromStderr(active.kindId, active.errorOverflowed ? "" : active.errorBuffer),
    classified = (classification: RuntimeAttemptOutcome["classification"], reason: string) => ({
      outcome,
      classification,
      reason,
      provider,
      attemptGroupId,
      attemptIndex,
    });
  if (active.cancelRequested || active.lossReason)
    return classified(
      "worker_stop",
      active.cancelRequested
        ? "Worker stop was requested."
        : `Worker process stopped before settlement: ${active.lossReason}`,
    );
  if (attemptFailed && providerFault)
    return {
      ...classified("provider_fault", providerFault.reason),
      ...(providerFault.faultClass ? { faultClass: providerFault.faultClass } : {}),
      ...(providerFault.resetAt ? { resetAt: providerFault.resetAt } : {}),
    };
  if (exitCode === null)
    return classified("provider_fault", "Provider process disconnected before completing the attempt.");
  if (attemptFailed && !active.toolCallObserved) {
    const reason = active.errorOverflowed
      ? `Provider exited with code ${String(exitCode)} before any tool call; stderr exceeded the diagnostic limit.`
      : active.errorBuffer.trim() || `Provider exited with code ${String(exitCode)} before any tool call.`;
    return classified("provider_fault", reason);
  }
  if (attemptFailed)
    return classified(
      "gate_red",
      active.failureText ??
        (exitCode === 0
          ? "Worker reported failure after tool activity."
          : `Worker stopped after tool activity with provider exit ${String(exitCode)}.`),
    );
  return classified("worker_stop", workerStopReason(active, outcome));
}

export type RuntimeExitOutcome = "succeeded" | "failed" | "unknown" | "cancelled";

function runtimeExitOutcome(active: ActiveRuntime, exitCode: number | null): RuntimeExitOutcome {
  if (active.cancelRequested) return "cancelled";
  if (exitCode === null) return "unknown";
  if (exitCode !== 0) return "failed";
  if (active.providerOutcome === "failed") return "failed";
  return active.descendantsAlive || active.worktreeDirty ? "unknown" : "succeeded";
}

function workerStopReason(active: ActiveRuntime, outcome: RuntimeExitOutcome): string {
  if (outcome === "succeeded") return "Worker completed the attempt successfully.";
  if (active.descendantsAlive) return "Worker exited while descendant processes are still running.";
  if (active.worktreeDirty) return "Worker exited with uncommitted changes in its worktree.";
  if (active.protocolError) return "Worker exited with incomplete provider protocol evidence; outcome is unknown.";
  return "Worker exited without a structured provider outcome; outcome is unknown.";
}

export function observeProviderFault(active: ActiveRuntime, frame: ProviderFrame): void {
  if (frame.toolCallObserved) {
    active.toolCallObserved = true;
    active.providerFault = null;
  }
  if (frame.providerFault) active.providerFault = frame.providerFault;
}

function providerFaultFromDiagnostic(
  responseCode: number | null,
  code: string | null,
  diagnostic: string | null,
  resetAt: string | undefined,
): RuntimeProviderFault | null {
  const joined = [code, diagnostic].filter((value): value is string => value !== null).join(" "),
    reason = providerReason(responseCode, joined);
  if (quota.test(joined)) return fault("quota_exhausted", reason, "quota_exhausted", resetAt);
  if (responseCode === 429 || /rate[_ -]?limit|too many requests/iu.test(joined))
    return fault("rate_limited", reason, "rate_limited", resetAt);
  if (responseCode !== null && responseCode >= 500 && responseCode <= 599) return fault("server_error", reason);
  if (model.test(joined)) return fault("unrecognized_model", reason);
  if (responseCode === 401 || responseCode === 403 || auth.test(joined)) return fault("auth_failed", reason);
  return null;
}

function providerReason(responseCode: number | null, diagnostic: string): string {
  const status = responseCode === null ? "" : `HTTP ${String(responseCode)}`;
  return [status, diagnostic].filter(Boolean).join(": ");
}

function fault(
  code: RuntimeProviderFault["code"],
  reason: string,
  faultClass?: RuntimeProviderFault["faultClass"],
  resetAt?: string,
): RuntimeProviderFault {
  return {
    code,
    reason: reason.trim().slice(0, 1024) || code,
    ...(faultClass ? { faultClass } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function resetAtFrom(value: Record<string, unknown>): string | undefined {
  const direct = ["resetAt", "reset_at", "resetTime", "reset_time", "x-ratelimit-reset"].flatMap((key) =>
      value[key] === undefined ? [] : [value[key]],
    ),
    headers = diagnosticRecord(value.headers) ?? diagnosticRecord(value.response_headers),
    headerReset = headers
      ? (headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"] ?? headers["retry-after"])
      : undefined,
    retryAfter = value.retry_after ?? value.retryAfter;
  for (const candidate of [...direct, headerReset]) {
    const absolute = absoluteResetAt(candidate);
    if (absolute) return absolute;
  }
  return retryAfterAt(retryAfter);
}

function absoluteResetAt(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
    if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return epochResetAt(Number(value));
  }
  return typeof value === "number" && Number.isFinite(value) ? epochResetAt(value) : undefined;
}

function epochResetAt(value: number): string | undefined {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function retryAfterAt(value: unknown): string | undefined {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/u.test(value.trim())) return absoluteResetAt(value);
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? new Date(Date.now() + seconds * 1_000).toISOString() : undefined;
}
function integer(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null;
}
function diagnosticText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function diagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
