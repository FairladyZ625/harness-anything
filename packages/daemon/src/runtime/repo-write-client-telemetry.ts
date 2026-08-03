import type { RepoWriteDirectClientLane } from "./repo-write-client-direct.ts";
import type {
  PendingLookup,
  PendingShutdown,
  PendingSubmit
} from "./repo-write-client-pending.ts";
import type { RepoWriteTelemetryFrame } from "./repo-write-protocol.ts";
import { markRepoWriteChildStarted } from "./repo-write-parent-performance.ts";

export function repoWriteTelemetryMatchesPendingRequest(
  message: RepoWriteTelemetryFrame,
  submits: ReadonlyMap<string, PendingSubmit>,
  lookups: ReadonlyMap<string, PendingLookup>,
  direct: RepoWriteDirectClientLane,
  shutdown: PendingShutdown | undefined
): boolean {
  const submit = submits.get(message.requestId);
  if (submit) return message.opId === undefined || submit.opId === message.opId;
  const lookup = lookups.get(message.requestId);
  if (lookup) {
    return lookup.phase === "sent"
      && (message.opId === undefined || lookup.opId === message.opId);
  }
  if (direct.telemetryMatches(message)) return true;
  return shutdown?.sent === true
    && shutdown.requestId === message.requestId
    && message.opId === undefined;
}

export function recordRepoWriteClientTelemetry(
  message: RepoWriteTelemetryFrame,
  submits: Map<string, PendingSubmit>,
  lookups: Map<string, PendingLookup>,
  direct: RepoWriteDirectClientLane
): void {
  const submit = submits.get(message.requestId);
  if (submit) {
    markRepoWriteChildStarted(submit.performanceTiming);
    submit.lastTelemetry = message;
    return;
  }
  const lookup = lookups.get(message.requestId);
  if (lookup) {
    markRepoWriteChildStarted(lookup.performanceTiming);
    lookup.lastTelemetry = message;
    return;
  }
  direct.recordTelemetry(message);
}
