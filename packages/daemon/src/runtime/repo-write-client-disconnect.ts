import { RepoWriteDirectClientLane } from "./repo-write-client-direct.ts";
import {
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError
} from "./repo-write-client-errors.ts";
import type { PendingLookup, PendingSubmit } from "./repo-write-client-pending.ts";
import { finishRepoWriteParentPerformanceTiming } from "./repo-write-parent-performance.ts";

export function disconnectRepoWritePendingRequests(
  submits: Map<string, PendingSubmit>,
  direct: RepoWriteDirectClientLane,
  lookups: Map<string, PendingLookup>,
  error: Error
): void {
  for (const [requestId, pending] of submits) {
    clearTimeout(pending.timer);
    submits.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    pending.reject(pending.opId
      ? new RepoWriteOutcomeUnknownError(
          "CAPSULE_DISCONNECTED",
          `Repo writer disconnected after preparation: ${error.message}`,
          pending.opId
        )
      : new RepoWriteNotStartedError(
          "CAPSULE_DISCONNECTED",
          `Repo writer disconnected before the request started: ${error.message}`
        ));
  }
  direct.disconnect(error);
  for (const [requestId, pending] of lookups) {
    clearTimeout(pending.timer);
    lookups.delete(requestId);
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    pending.reject(new RepoWriteLookupError(
      "CAPSULE_DISCONNECTED",
      `Repo writer disconnected during outcome lookup: ${error.message}`,
      pending.opId
    ));
  }
}
