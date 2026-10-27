import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import type { ActiveRuntime, ProviderFrame, ProviderReconnect } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeProviderFault } from "./runtime-fallback-contract.ts";
import { runtimeSpendCapReason } from "./runtime-spend-cap.ts";

const quota =
    /\b(?:quota|usage limit|credit balance|insufficient[_ -]?quota|resource[_ -]?exhausted)\b|使用上限|配额/iu,
  capacity =
    /\b(?:capacity issues?|at capacity|overloaded|service is busy|temporarily unavailable|try again later|too many pending requests)\b/iu,
  incompleteStream =
    /\b(?:incomplete response|(?:stream|sse).*(?:disconnected|ended|incomplete|event type mismatch)|event type mismatch|before message_stop)\b/iu,
  model = /\b(?:unrecognized[_ -]?model|model[_ -]?not[_ -]?found|unknown[_ -]?model)\b/iu,
  auth = /\b(?:unauthorized|unauthenticated|authentication failed|invalid[_ -]?(?:api[_ -]?key|token))\b/iu;

/** Codex reports a stream reconnect as a plain `error` frame whose message starts with
 * `Reconnecting...`. It is a transport event, not a turn failure: the attempt keeps running, and a
 * turn that ends right after the budget is spent may still answer as if it had finished.
 *
 * The `n/m` budget is optional — `Reconnecting... waiting for network (...)` and proxy/websocket
 * errors arrive without one — and the provider's detail is free text that may itself contain
 * parentheses and newlines (`Connection reset by peer (os error 54)`, an HTML 502 body). So the
 * prefix is the marker, and the budget and detail are parsed separately from it. */
const reconnectPrefix = /^Reconnecting\.\.\.[ \t]*/iu,
  reconnectBudget = /^(\d+)\s*\/\s*(\d+)(?=[ \t]*\(|[ \t]*$)/u;

export function providerReconnectFromFrame(
  kindId: RuntimeInstanceKind,
  value: Record<string, unknown>,
): ProviderReconnect | null {
  if (kindId !== "codex" || value.type !== "error") return null;
  const diagnostic = diagnosticText(value.message);
  return diagnostic === null ? null : reconnectFromDiagnostic(diagnostic);
}

export function reconnectFromDiagnostic(diagnostic: string): ProviderReconnect | null {
  const text = diagnostic.trim(),
    prefix = reconnectPrefix.exec(text);
  if (!prefix) return null;
  const rest = text.slice(prefix[0].length),
    budget = reconnectBudget.exec(rest),
    attempt = budget === null ? null : Number(budget[1]),
    limit = budget === null ? null : Number(budget[2]),
    counted = attempt !== null && limit !== null && Number.isInteger(attempt) && Number.isInteger(limit) && limit > 0;
  // The full message stays the diagnostic: it is what the provider said, and the reason quotes it
  // verbatim after naming whichever budget the frame carried.
  return { attempt: counted ? attempt : null, limit: counted ? limit : null, diagnostic: text };
}

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
  if (
    kindId === "codex" &&
    (value.type === "item.completed" || value.type === "item.updated") &&
    diagnosticRecord(value.item)?.type === "error"
  ) {
    const item = diagnosticRecord(value.item)!,
      diagnostic = diagnosticText(item.message);
    return providerFaultFromDiagnostic(null, null, diagnostic, undefined);
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
  // ACP-family kinds share the canonical frame vocabulary; the error frame's
  // message is the only diagnostic surface.
  if (value.type === "acp.error")
    return providerFaultFromDiagnostic(null, null, diagnosticText(value.message), undefined);
  return null;
}

export function providerFaultFromStderr(kindId: RuntimeInstanceKind, stderr: string): RuntimeProviderFault | null {
  const normalized = stderr.trim();
  if (!normalized) return null;
  if (kindId === "claude") {
    const tagged = /^\[claude-code:([^\]]+)\]/imu.exec(normalized)?.[1] ?? null;
    if (tagged === "unrecognized_model") return fault("unrecognized_model", normalized);
    if (tagged && /auth|unauthor/iu.test(tagged)) return fault("auth_failed", normalized);
  }
  if (
    kindId === "agy" &&
    /^\[agy\] print timeout after [^\r\n]+ with turn in progress; returning partial output$/imu.test(normalized)
  )
    return fault("pre_tool_exit", normalized);
  const diagnosticFault = providerFaultFromDiagnostic(null, null, normalized, undefined);
  return diagnosticFault?.code === "unrecognized_model" || diagnosticFault?.code === "auth_failed"
    ? null
    : diagnosticFault;
}

/**
 * `ruling` is the worker's own machine-readable request for an owner ruling, already read from
 * the task package by the caller. It is an input rather than a projection read here so this
 * classifier stays pure; settlement is still the one place that turns a result into a settlement.
 * A ruling outranks `gate_red` because the worker stopped on purpose: with no one to answer, the
 * same turn reads as "gate red" and hides the question forever.
 */
export function classifyRuntimeExit(
  active: ActiveRuntime,
  exitCode: number | null,
  ruling: { readonly question: string; readonly options?: readonly string[] } | null = null,
): RuntimeAttemptOutcome & { readonly outcome: RuntimeExitOutcome } {
  const providerFault =
      active.providerFault ?? providerFaultFromStderr(active.kindId, active.errorOverflowed ? "" : active.errorBuffer),
    outcome = runtimeExitOutcome(active, exitCode, providerFault),
    provider = { instance: active.instanceId, model: active.model, kind: active.kindId },
    attemptGroupId = active.fallbackAttempt?.attemptGroupId ?? active.dispatchId,
    attemptIndex = active.fallbackAttempt?.attemptIndex ?? 0,
    attemptFailed =
      exitCode === null ||
      exitCode !== 0 ||
      active.providerOutcome === "failed" ||
      providerFault?.code === "pre_tool_exit",
    classified = (classification: RuntimeAttemptOutcome["classification"], reason: string) => ({
      outcome,
      classification,
      reason,
      provider,
      attemptGroupId,
      attemptIndex,
    });
  if (active.cancelRequested) return classified("worker_stop", "Worker stop was requested.");
  // A cap stop is policy: it settles failed, and the worker_stop classification keeps the
  // fallback chain from spending the next provider's budget on the same runaway attempt.
  if (active.spendCapExceeded)
    return { ...classified("worker_stop", runtimeSpendCapReason(active)), outcome: "failed" };
  if (active.stalledAt !== null && active.stalledAt !== undefined)
    return {
      ...classified(
        "provider_fault",
        `Dispatch stalled after ${String(active.stallTimeoutMs)} ms without provider or workspace progress.`,
      ),
      outcome: "failed",
    };
  // A requested stop for a ruling is never a provider fault: the worker wrote the question and
  // stopped, which is exactly what the unattended contract asks for. It settles `stopped` rather
  // than `failed` so the receipt and agenda read "waiting on the owner", not "the run broke".
  if (ruling !== null) return { ...classified("awaiting_ruling", ruling.question), outcome: "stopped" };
  if (attemptFailed && providerFault?.code === "unrecognized_model")
    return classified("gate_red", providerFault.reason);
  if (attemptFailed && providerFault)
    return {
      ...classified(providerFault.faultClass ? "provider_quota" : "provider_fault", providerFault.reason),
      ...(providerFault.faultClass ? { faultClass: providerFault.faultClass } : {}),
      ...(providerFault.resetAt ? { resetAt: providerFault.resetAt } : {}),
    };
  if (active.lossReason)
    return classified("worker_stop", `Worker process stopped before settlement: ${active.lossReason}`);
  if (exitCode === null)
    return classified("provider_fault", "Provider process disconnected before completing the attempt.");
  // A drained reconnect budget is upstream overload, not the worker giving up: when the provider
  // reconnected and the attempt then ended without any successful tool call, the last agent
  // message is the overloaded stream's tail, whatever it claims about the workspace.
  if (reconnectExhaustedTail(active)) return classified("provider_fault", reconnectExhaustedReason(active));
  // A reconnect with neither a served tool call nor an answering agent message has no terminal
  // evidence to preserve. Keep this transport-loss case on the historical worker-stop path;
  // completed_without_final_text is reserved for a provider that actually completed a turn.
  if (reconnectWithoutAnswer(active)) return classified("worker_stop", workerStopReason(active, outcome));
  if (exitCode === 0 && active.providerOutcome === "succeeded" && !active.finalText?.trim())
    return {
      ...classified(
        "completed_without_final_text",
        `Provider completed without final text (${String(active.toolCallCount)} tool calls; ` +
          `${String(active.workspaceActivityCount ?? 0)} workspace change events). Dispatch transcript: ${active.stream?.ref ?? "unavailable"}`,
      ),
      outcome: "unknown",
    };
  if (attemptFailed && !active.toolCallObserved) {
    if (active.failureText?.startsWith("ACP provider exited before the session completed (exit "))
      return classified("provider_fault", active.failureText);
    const reason = active.errorOverflowed
      ? `Provider exited with code ${String(exitCode)} before any tool call; stderr exceeded the diagnostic limit.`
      : active.failureText ||
        active.errorBuffer.trim() ||
        `Provider exited with code ${String(exitCode)} before any tool call.`;
    return classified("gate_red", reason);
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

export type RuntimeExitOutcome = "succeeded" | "failed" | "unknown" | "cancelled" | "stopped";

/** The provider reconnected, then closed the attempt without a single successful tool call. The
 * attempt answered from a drained stream; the message it wrote is a symptom, never the cause. */
function reconnectExhaustedTail(active: ActiveRuntime): boolean {
  return (
    (active.providerReconnectCount ?? 0) > 0 &&
    active.finalAgentMessageAfterReconnect === true &&
    active.successfulToolCallAfterReconnect !== true
  );
}

function reconnectWithoutAnswer(active: ActiveRuntime): boolean {
  return (
    (active.providerReconnectCount ?? 0) > 0 &&
    active.finalAgentMessageAfterReconnect !== true &&
    active.successfulToolCallAfterReconnect !== true
  );
}

function reconnectExhaustedReason(active: ActiveRuntime): string {
  const last = active.lastProviderReconnect,
    budget =
      last !== null && last.attempt !== null && last.limit !== null
        ? ` (${String(last.attempt)}/${String(last.limit)})`
        : "",
    diagnostic = last ? `${budget}: ${last.diagnostic}` : ".";
  return (
    `Provider stream reconnected ${String(active.providerReconnectCount)} time(s) and the attempt ` +
    `closed after the last reconnect without a successful tool call${diagnostic}`
  );
}

function runtimeExitOutcome(
  active: ActiveRuntime,
  exitCode: number | null,
  providerFault: RuntimeProviderFault | null,
): RuntimeExitOutcome {
  if (active.cancelRequested) return "cancelled";
  if (active.providerOutcome === "failed" || (active.lossReason && providerFault)) return "failed";
  if (exitCode === null) return "unknown";
  if (exitCode !== 0) return "failed";
  if (providerFault?.code === "pre_tool_exit") return "failed";
  if (
    active.providerOutcome === "succeeded" &&
    !active.toolCallObserved &&
    !active.nonEmptyAgentOutputObserved &&
    active.providerUsageEmpty
  )
    return "failed";
  if (active.finalText?.trim() || active.nonEmptyAgentOutputObserved) return "stopped";
  return "unknown";
}

function workerStopReason(active: ActiveRuntime, outcome: RuntimeExitOutcome): string {
  if (outcome === "succeeded") return "Worker completed the attempt successfully.";
  if (outcome === "stopped") return "Worker stopped after a normal exit without a submitted delivery.";
  if (active.protocolError) return "Worker exited with incomplete provider protocol evidence; outcome is unknown.";
  return "Worker exited without sufficient completion evidence; outcome is unknown.";
}

export function observeProviderFault(active: ActiveRuntime, frame: ProviderFrame): void {
  if (frame.providerReconnect) {
    active.providerReconnectCount = (active.providerReconnectCount ?? 0) + 1;
    active.lastProviderReconnect = frame.providerReconnect;
    // A reconnect re-opens the window: only tool calls issued after it prove the provider served
    // this attempt again, and only messages after it can be the drained stream's tail.
    active.successfulToolCallAfterReconnect = false;
    active.finalAgentMessageAfterReconnect = false;
  }
  if (frame.toolCallObserved) {
    active.toolCallObserved = true;
    active.providerFault = null;
    if (frame.toolCallSucceeded) active.successfulToolCallAfterReconnect = true;
  }
  if (frame.finalText?.trim()) {
    active.nonEmptyAgentOutputObserved = true;
    if ((active.providerReconnectCount ?? 0) > 0) active.finalAgentMessageAfterReconnect = true;
  }
  if (frame.providerUsageEmpty !== undefined) active.providerUsageEmpty = frame.providerUsageEmpty;
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
  if (capacity.test(joined)) return fault("server_error", reason);
  if (incompleteStream.test(joined)) return fault("server_error", reason);
  if (responseCode !== null && responseCode >= 500 && responseCode <= 599) return fault("server_error", reason);
  if (model.test(joined)) return fault("unrecognized_model", reason);
  if (responseCode === 401 || auth.test(joined)) return fault("auth_failed", reason);
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
    headerReset = headers ? (headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"]) : undefined,
    retryAfter = headers?.["retry-after"] ?? value.retry_after ?? value.retryAfter;
  for (const candidate of [...direct, headerReset]) {
    const absolute = absoluteResetAt(candidate);
    if (absolute) return absolute;
  }
  return retryAfterAt(retryAfter);
}

function absoluteResetAt(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return epochResetAt(Number(value));
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }
  return typeof value === "number" && Number.isFinite(value) ? epochResetAt(value) : undefined;
}

function epochResetAt(value: number): string | undefined {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function retryAfterAt(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    if (!/^-?\d+(?:\.\d+)?$/u.test(value.trim())) return absoluteResetAt(value);
  }
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
