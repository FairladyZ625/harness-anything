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
    return providerFaultFromDiagnostic(responseCode, error, diagnostic);
  }
  if (kindId === "codex" && value.type === "turn.failed") {
    const detail = diagnosticRecord(value.error),
      responseCode = integer(detail?.http_status) ?? integer(detail?.status),
      code = diagnosticText(detail?.code),
      diagnostic = diagnosticText(detail?.message) ?? (detail ? JSON.stringify(detail) : null);
    return providerFaultFromDiagnostic(responseCode, code, diagnostic);
  }
  if (kindId === "agy" && value.event === "result") {
    const result = diagnosticRecord(value.result),
      diagnostic = diagnosticText(result?.error),
      responseCode = integer(result?.status_code),
      code = diagnosticText(result?.code);
    return providerFaultFromDiagnostic(responseCode, code, diagnostic);
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
  if (attemptFailed && providerFault) return classified("provider_fault", providerFault.reason);
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
  if (exitCode === null || active.protocolError) return "unknown";
  if (exitCode !== 0) return "failed";
  const writeEvidenceRequired = active.kindId !== "agy" && active.permissionMode !== "read-only";
  if (
    active.providerOutcome === "succeeded" &&
    (active.planIncomplete || (writeEvidenceRequired && !active.writeItemObserved && !active.planObserved))
  )
    return "unknown";
  return active.providerOutcome ?? "unknown";
}

function workerStopReason(active: ActiveRuntime, outcome: RuntimeExitOutcome): string {
  if (outcome === "succeeded") return "Worker completed the attempt successfully.";
  if (active.protocolError) return "Worker exited with incomplete provider protocol evidence; outcome is unknown.";
  if (active.planIncomplete) return "Worker exited before completing its declared plan; outcome is unknown.";
  if (active.providerOutcome === "succeeded" && !active.writeItemObserved && !active.planObserved)
    return "Worker exited without required write or plan evidence; outcome is unknown.";
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
): RuntimeProviderFault | null {
  const joined = [code, diagnostic].filter((value): value is string => value !== null).join(" ");
  if (responseCode === 429 || /rate[_ -]?limit|too many requests/iu.test(joined))
    return fault("rate_limited", providerDiagnostic("Provider rate limited the attempt", responseCode ?? 429, joined));
  if (responseCode !== null && responseCode >= 500 && responseCode <= 599)
    return fault("server_error", providerDiagnostic("Provider server error", responseCode, joined));
  if (quota.test(joined)) return fault("quota_exhausted", `Provider quota exhausted: ${joined}`);
  if (model.test(joined)) return fault("unrecognized_model", `Provider rejected the model: ${joined}`);
  if (responseCode === 401 || responseCode === 403 || auth.test(joined))
    return fault("auth_failed", providerDiagnostic("Provider authentication failed", responseCode, joined));
  return null;
}

function providerDiagnostic(label: string, responseCode: number | null, diagnostic: string): string {
  const status = responseCode === null ? "" : ` (HTTP ${String(responseCode)})`;
  return `${label}${status}${diagnostic ? `: ${diagnostic}` : "."}`;
}

function fault(code: RuntimeProviderFault["code"], reason: string): RuntimeProviderFault {
  return { code, reason: reason.trim().slice(0, 1024) || code };
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
