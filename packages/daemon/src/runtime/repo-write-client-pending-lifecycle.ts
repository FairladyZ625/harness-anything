import type { RepoWriteRequestTimeoutDiagnostic } from "./repo-write-client-contract.ts";
import type { RepoWriteDirectClientLane } from "./repo-write-client-direct.ts";
import {
  RepoWriteLookupError,
  RepoWriteProtocolViolationError
} from "./repo-write-client-errors.ts";
import type {
  PendingLookup,
  PendingSubmit
} from "./repo-write-client-pending.ts";
import type { RepoWriteFailureFrame } from "./repo-write-protocol.ts";
import { advanceRepoWritePhase } from "./repo-write-phase.ts";
import { expireRepoWriteSubmit } from "./repo-write-client-timeout.ts";
import { armRepoWriteSubmitEscalation } from "./repo-write-client-watchdog.ts";
import { finishRepoWriteParentPerformanceTiming } from "./repo-write-parent-performance.ts";

export function rejectRepoWriteQueuedRequests(
  submits: Map<string, PendingSubmit>,
  direct: RepoWriteDirectClientLane,
  lookups: Map<string, PendingLookup>,
  error: Error & { readonly code: string }
): void {
  for (const [requestId, pending] of submits) {
    if (pending.phase !== "queued") continue;
    clearTimeout(pending.timer);
    submits.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    pending.reject(error);
  }
  direct.rejectQueued(error);
  for (const [requestId, pending] of lookups) {
    if (pending.phase !== "queued") continue;
    clearTimeout(pending.timer);
    lookups.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    pending.reject(new RepoWriteLookupError(error.code, error.message, pending.opId));
  }
}

export function expireRepoWritePendingSubmit(
  requestId: string,
  pendingRequests: Map<string, PendingSubmit>,
  limits: {
    readonly requestTimeoutMs: number;
    readonly proceededStallTimeoutMs: number;
  },
  onTimeout: ((diagnostic: RepoWriteRequestTimeoutDiagnostic) => void) | undefined
): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  const outcome = expireRepoWriteSubmit(pending, limits.requestTimeoutMs, onTimeout);
  if (outcome === "queued") {
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    pending.reject(new RepoWriteProtocolViolationError(
      "Repo writer request deadline fired before dispatch."
    ));
    return;
  }
  if (outcome === "expired") {
    pendingRequests.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
  }
  if (outcome === "observed") {
    armRepoWriteSubmitEscalation({
      pending,
      pendingRequests,
      delayMs: limits.proceededStallTimeoutMs - limits.requestTimeoutMs,
      totalTimeoutMs: limits.proceededStallTimeoutMs,
      onTimeout
    });
  }
}

export function repoWritePendingFailureTransitionError(
  pending: PendingSubmit,
  message: Extract<RepoWriteFailureFrame, { readonly kind: "failure" }>
): string | undefined {
  if (message.outcome === "not-started") {
    if (pending.phase !== "submitted" && pending.phase !== "prepared" && pending.phase !== "proceeded") {
      return "Repo writer not-started failure has an invalid phase transition.";
    }
    advanceRepoWritePhase("parent", "not-started", pending.phase);
    return undefined;
  }
  if (pending.phase !== "prepared" && pending.phase !== "proceeded") {
    return "Repo writer outcome-unknown failure has an invalid phase transition.";
  }
  advanceRepoWritePhase("parent", "outcome-unknown", pending.phase);
  return undefined;
}
