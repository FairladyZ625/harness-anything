import type { RepoWriteDirectClientLane } from "./repo-write-client-direct.ts";
import type {
  PendingLookup,
  PendingShutdown,
  PendingSubmit
} from "./repo-write-client-pending.ts";
import type {
  RepoWriteTelemetryBatchFrame,
  RepoWriteTelemetryFrame,
  RepoWriteTelemetryMessage
} from "./repo-write-protocol.ts";
import { markRepoWriteChildStarted } from "./repo-write-parent-performance.ts";
import {
  observeRepoWriteTelemetry,
  observeRepoWriteTelemetryBatch
} from "./repo-write-client-observers.ts";

export function handleRepoWriteClientTelemetry(input: {
  readonly message: RepoWriteTelemetryMessage;
  readonly submits: Map<string, PendingSubmit>;
  readonly lookups: Map<string, PendingLookup>;
  readonly direct: RepoWriteDirectClientLane;
  readonly shutdown: PendingShutdown | undefined;
  readonly onTelemetry: (frame: RepoWriteTelemetryFrame) => void;
  readonly onTelemetryBatch?: (frame: RepoWriteTelemetryBatchFrame) => void;
  readonly failProtocol: (message: string) => void;
}): boolean {
  if (!repoWriteTelemetryMatchesPendingRequest(
    input.message,
    input.submits,
    input.lookups,
    input.direct,
    input.shutdown
  )) return false;
  recordRepoWriteClientTelemetry(input.message, input.submits, input.lookups, input.direct);
  if (input.message.kind === "telemetry-batch" && input.onTelemetryBatch) {
    observeRepoWriteTelemetryBatch(
      input.onTelemetryBatch,
      input.message,
      () => input.failProtocol("Repo writer telemetry batch observer failed.")
    );
    return true;
  }
  for (const frame of repoWriteTelemetryFrames(input.message)) {
    observeRepoWriteTelemetry(
      input.onTelemetry,
      frame,
      () => input.failProtocol("Repo writer telemetry observer failed.")
    );
  }
  return true;
}

function repoWriteTelemetryMatchesPendingRequest(
  message: RepoWriteTelemetryMessage,
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

function recordRepoWriteClientTelemetry(
  message: RepoWriteTelemetryMessage,
  submits: Map<string, PendingSubmit>,
  lookups: Map<string, PendingLookup>,
  direct: RepoWriteDirectClientLane
): void {
  const last = repoWriteTelemetryFrames(message).at(-1);
  if (!last) return;
  const submit = submits.get(message.requestId);
  if (submit) {
    markRepoWriteChildStarted(submit.performanceTiming);
    submit.lastTelemetry = last;
    return;
  }
  const lookup = lookups.get(message.requestId);
  if (lookup) {
    markRepoWriteChildStarted(lookup.performanceTiming);
    lookup.lastTelemetry = last;
    return;
  }
  direct.recordTelemetry(last);
}

export function repoWriteTelemetryFrames(
  message: RepoWriteTelemetryMessage
): ReadonlyArray<RepoWriteTelemetryFrame> {
  if (message.kind === "telemetry") return [message];
  return message.spans.map((span) => ({
    protocol: message.protocol,
    repoId: message.repoId,
    generation: message.generation,
    kind: "telemetry",
    requestId: message.requestId,
    ...(message.opId ? { opId: message.opId } : {}),
    ...span
  }));
}
