import { runtimeSessionOutcomeFromEvidence, type RuntimeSession } from "../../kernel/src/index.ts";
import type { AgentRuntimeSessionDto, AgentRuntimeSettlement } from "./agent-runtime-contract.ts";

/** Grace window after a process exit during which the daemon still expects the outcome event to project. */
export const runtimeSettlementGraceMs = 5_000;

/** The settle signal for orchestration waiters: an explicit terminal outcome, or an exited session
 * whose outcome event outlived the settlement grace window. */
export function runtimeOutcomeSettled(
  session:
    | (Pick<RuntimeSession, "liveness" | "outcome" | "lastObservedAt"> &
        Partial<Pick<RuntimeSession, "exitCode" | "resultRef" | "reasonCode">>)
    | null
    | undefined,
  now: string,
): boolean {
  if (!session) return false;
  if (runtimeSessionOutcomeFromEvidence(session) !== null) return true;
  if (session.liveness !== "exited") return false;
  const elapsed = Date.parse(now) - Date.parse(session.lastObservedAt);
  return Number.isFinite(elapsed) && elapsed >= runtimeSettlementGraceMs;
}

/**
 * Orchestration waiters (runtime batch, agent create) park here instead of polling the projection
 * on a client cadence; every terminal signal re-checks the domain settle predicate. The predicate
 * is also time-based (post-exit grace), so a missed event cannot park a waiter forever: each wake
 * re-reads the session and either returns or rearms.
 */
export function createRuntimeOutcomeWaiters(input: {
  readonly readSession: (runtimeSessionId: string) => Parameters<typeof runtimeOutcomeSettled>[0];
  readonly now: () => string;
}): {
  readonly notify: () => void;
  readonly awaitOutcome: (runtimeSessionId: string) => Promise<void>;
  readonly awaitSignal: () => Promise<void>;
} {
  const waiters = new Set<() => void>(),
    // One parked wake: resolves on the next runtime signal/outcome notification, or on the grace
    // backstop so a missed signal cannot park a waiter forever.
    park = () =>
      new Promise<void>((resolve) => {
        const waiter = () => {
          waiters.delete(waiter);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, runtimeSettlementGraceMs);
        timer.unref?.();
        waiters.add(waiter);
      });
  return {
    notify: () => {
      const pending = [...waiters];
      waiters.clear();
      for (const waiter of pending) waiter();
    },
    awaitOutcome: async (runtimeSessionId) => {
      while (!runtimeOutcomeSettled(input.readSession(runtimeSessionId), input.now())) {
        await park();
      }
    },
    awaitSignal: park,
  };
}

/** The daemon-authoritative terminal receipt fields for one runtime session read. Null while the
 * session is still running or inside the post-exit settlement grace window. */
export function runtimeSessionSettlement(
  session: AgentRuntimeSessionDto,
  resultText: string | null,
  now: string,
): AgentRuntimeSettlement | null {
  const activity = session.activity;
  if (activity.outcome === null) {
    if (session.liveness !== "exited") return null;
    const elapsed = Date.parse(now) - Date.parse(activity.lastObservedAt);
    if (!Number.isFinite(elapsed) || elapsed < runtimeSettlementGraceMs) return null;
  }
  const outcome = activity.outcome ?? "unknown",
    settlementFailed = activity.outcome === null || (outcome === "unknown" && activity.reasonCode !== undefined),
    attempt = session.attemptChain?.attempts.find(
      (candidate) => candidate.runtimeSessionId === session.runtimeSessionId,
    ),
    providerFaultClass =
      attempt?.classification === "provider_fault" || attempt?.classification === "provider_quota"
        ? attempt.faultClass
        : undefined,
    providerExit = Number.isInteger(activity.exitCode),
    code = settlementFailed
      ? "runtime_settlement_failed"
      : (providerFaultClass ?? (providerExit ? "provider_exit" : "runtime_failed")),
    reason =
      outcome === "succeeded"
        ? null
        : providerFaultClass
          ? providerFaultReason(providerFaultClass, attempt?.resetAt, attempt?.reason ?? resultText ?? "")
          : resultText ||
            (settlementFailed
              ? "runtime_settlement_failed: the runtime exited but no terminal outcome became visible."
              : providerExit
                ? `Provider exited with code ${String(activity.exitCode)} without a diagnostic.`
                : `runtime: ${outcome}`);
  return {
    outcome,
    exitCode: outcome === "succeeded" ? 0 : 1,
    code: reason === null ? null : code,
    reason,
  };
}

function providerFaultReason(faultClass: string, resetAt: string | undefined, diagnostic: string): string {
  return [`faultClass=${faultClass}`, resetAt ? `resetAt=${resetAt}` : null, diagnostic]
    .filter((value): value is string => Boolean(value))
    .join("; ");
}
