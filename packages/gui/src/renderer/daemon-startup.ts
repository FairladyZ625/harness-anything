export const daemonStartupBudgetMs = 30_000;

const retryableDaemonCodes = new Set([
  "daemon_closed",
  "daemon_response_timeout",
  "daemon_stopping",
  "daemon_unavailable",
]);

export type DaemonStartupPhase = "pending" | "waiting" | "timeout" | "ready";

export function daemonErrorCode(error: unknown): string | null {
  return error instanceof Error && typeof (error as { readonly code?: unknown }).code === "string"
    ? String((error as { readonly code: string }).code)
    : null;
}

export function daemonBridgeError(value: unknown, fallback: string): Error & { readonly code?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Error(fallback);
  const bridge = value as { readonly ok?: unknown; readonly error?: unknown };
  if (bridge.ok !== false || bridge.error === null || typeof bridge.error !== "object" || Array.isArray(bridge.error))
    return new Error(fallback);
  const detail = bridge.error as { readonly code?: unknown; readonly hint?: unknown };
  const error = new Error(typeof detail.hint === "string" ? detail.hint : fallback);
  return typeof detail.code === "string" ? Object.assign(error, { code: detail.code }) : error;
}

export function isRetryableDaemonError(error: unknown): boolean {
  const code = daemonErrorCode(error);
  return code !== null && retryableDaemonCodes.has(code);
}

export function daemonStartupPhase(input: {
  readonly pending: boolean;
  readonly ready: boolean;
  readonly elapsedMs: number;
}): DaemonStartupPhase {
  if (input.ready) return "ready";
  if (input.elapsedMs >= daemonStartupBudgetMs) return "timeout";
  return input.pending ? "pending" : "waiting";
}

export function daemonRetryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}
