import type { DispatchLifecycleRead } from "@harness-anything/kernel";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type { AgentRuntimeSessionDto, AgentRuntimeSettlement } from "./agent-runtime-contract.ts";

function lifecycleRow(read: DispatchLifecycleRead) {
  return read.status === "ready" ? (read.rows.length === 1 ? read.rows[0]! : null) : null;
}

/** Bounded wake interval; each wake re-reads the lifecycle projection before returning. */
export const runtimeOutcomeRecheckMs = daemonRuntimePolicy.defaultValue.runtime.outcomeRecheckMs;

/** A waiter completes only after the lifecycle projection accepted the terminal outcome. */
export function runtimeOutcomeSettled(read: DispatchLifecycleRead): boolean {
  return lifecycleRow(read)?.policy.attemptSettled === true;
}

export function createRuntimeOutcomeWaiters(input: {
  readonly readLifecycle: (runtimeSessionId: string) => DispatchLifecycleRead | Promise<DispatchLifecycleRead>;
}): {
  readonly notify: () => void;
  readonly awaitOutcome: (runtimeSessionId: string) => Promise<void>;
  readonly signalVersion: () => number;
  readonly awaitSignal: (observedVersion?: number) => Promise<void>;
} {
  let version = 0;
  const waiters = new Set<() => void>(),
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
        }, runtimeOutcomeRecheckMs);
        timer.unref?.();
        waiters.add(waiter);
      });
  return {
    notify: () => {
      version++;
      const pending = [...waiters];
      waiters.clear();
      for (const waiter of pending) waiter();
    },
    awaitOutcome: async (runtimeSessionId) => {
      for (;;) {
        if (runtimeOutcomeSettled(await input.readLifecycle(runtimeSessionId))) return;
        await park();
      }
    },
    signalVersion: () => version,
    awaitSignal: (observedVersion) =>
      observedVersion !== undefined && observedVersion !== version ? Promise.resolve() : park(),
  };
}

/** Terminal receipt fields are a projection of the canonical dispatch attempt. */
export function runtimeSessionSettlement(
  read: DispatchLifecycleRead,
  session: AgentRuntimeSessionDto,
  resultText: string | null,
): AgentRuntimeSettlement | null {
  const lifecycleAttempt = lifecycleRow(read)?.attempt;
  if (!lifecycleAttempt || lifecycleAttempt.phase !== "closed" || lifecycleAttempt.outcome === null) return null;
  const outcome = lifecycleAttempt.outcome,
    settlementFailed = outcome === "unknown" && session.activity.reasonCode !== undefined,
    sessionAttempt = session.attemptChain?.attempts.find(
      (candidate) => candidate.runtimeSessionId === session.runtimeSessionId,
    ),
    providerFaultClass =
      sessionAttempt?.classification === "provider_fault" || sessionAttempt?.classification === "provider_quota"
        ? sessionAttempt.faultClass
        : undefined,
    providerExit = Number.isInteger(session.activity.exitCode),
    code = settlementFailed
      ? "runtime_settlement_failed"
      : (providerFaultClass ?? (providerExit ? "provider_exit" : "runtime_failed")),
    reason =
      outcome === "succeeded"
        ? null
        : providerFaultClass
          ? providerFaultReason(providerFaultClass, sessionAttempt?.resetAt, sessionAttempt?.reason ?? resultText ?? "")
          : resultText ||
            (settlementFailed
              ? "runtime_settlement_failed: the runtime exited but no terminal outcome became visible."
              : providerExit
                ? `Provider exited with code ${String(session.activity.exitCode)} without a diagnostic.`
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
