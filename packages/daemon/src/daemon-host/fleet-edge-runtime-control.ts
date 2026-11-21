import type { AgentRuntimeEventV1, RuntimeControlRequest } from "@harness-anything/kernel";
import { runtimeErrorCode, runtimeErrorMessage } from "../runtime-engine/runtime-spawn-errors.ts";

export type RemoteRuntimeControlEvent = Extract<
  AgentRuntimeEventV1,
  { readonly type: "runtime_cancel_requested" | "runtime_steer_requested" | "runtime_session_liveness_changed" }
>;

export interface RemoteCancelControlRequest {
  readonly kind: "cancel";
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly runtimeSessionId: string;
  readonly controlRequestId: string;
  readonly targetNodeId: string;
  readonly reason?: string;
}

export interface RemoteSteerControlRequest {
  readonly kind: "steer";
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly controlRequestId: string;
  readonly targetNodeId: string;
  readonly prompt: string;
  readonly expected?: Extract<RuntimeControlRequest, { readonly action: "steer" }>["expected"];
}

export type RemoteControlRequestEntry = RemoteCancelControlRequest | RemoteSteerControlRequest;

const DEFAULT_MAX_TRACKED_CONTROL_REQUESTS = 4096;

const retryableControlCodes = new Set([
  "runtime_steer_unavailable",
  "dispatch_lifecycle_pending",
  "fleet_peer_unavailable",
  "fleet_transport_closed",
  "fleet_timeout",
  "fleet_busy",
  "busy",
  "daemon_closed",
  "client_disconnected",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ABORT_ERR",
  "ERR_SOCKET_CLOSED",
]);

function errorCodeOf(error: unknown): string | null {
  const known = runtimeErrorCode(error);
  if (known !== null) return known;
  if (error instanceof Error && error.name === "AbortError") return "ABORT_ERR";
  if (typeof error === "object" && error !== null && "cause" in error)
    return errorCodeOf((error as { readonly cause?: unknown }).cause);
  return null;
}

type ControlStepOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "not_running"; readonly code: string; readonly message: string }
  | { readonly outcome: "rejected"; readonly code: string; readonly message: string }
  | { readonly outcome: "deferred"; readonly code: string; readonly message: string };

async function runControlStep(work: () => Promise<void>): Promise<ControlStepOutcome> {
  try {
    await work();
    return { outcome: "applied" };
  } catch (error) {
    const code = errorCodeOf(error),
      message = runtimeErrorMessage(error);
    if (code === "runtime_not_running") return { outcome: "not_running", code, message };
    if (code === "runtime_steer_unsupported" || code === "runtime_steer_target_changed")
      return { outcome: "rejected", code, message };
    const transient =
      (code !== null && retryableControlCodes.has(code)) ||
      (error instanceof Error &&
        (error.message.includes("ECONNREFUSED") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("EPIPE") ||
          error.message.includes("socket hang up") ||
          error.message.includes("Premature close")));
    if (transient) return { outcome: "deferred", code: code ?? "transient_error", message };
    throw error;
  }
}

export function extractRemoteControlRequest(event: RemoteRuntimeControlEvent): RemoteControlRequestEntry | null {
  if (event.type === "runtime_cancel_requested") {
    return {
      kind: "cancel",
      opId: event.opId,
      workspaceRevision: event.workspaceRevision,
      runtimeSessionId: event.payload.runtimeSessionId,
      controlRequestId: event.payload.controlRequestId,
      targetNodeId: event.payload.targetNodeId,
      ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
    };
  }
  if (event.type === "runtime_steer_requested") {
    return {
      kind: "steer",
      opId: event.opId,
      workspaceRevision: event.workspaceRevision,
      runtimeSessionId: event.payload.runtimeSessionId,
      dispatchId: event.payload.dispatchId,
      controlRequestId: event.payload.controlRequestId,
      targetNodeId: event.payload.targetNodeId,
      prompt: event.payload.prompt,
      ...(event.payload.expected !== undefined ? { expected: event.payload.expected } : {}),
    };
  }
  const control = event.payload.controlRequest;
  if (!control) return null;
  if (control.action === "cancel") {
    return {
      kind: "cancel",
      opId: event.opId,
      workspaceRevision: event.workspaceRevision,
      runtimeSessionId: event.payload.runtimeSessionId,
      controlRequestId: control.controlRequestId,
      targetNodeId: control.targetNodeId,
      ...(control.reason !== undefined ? { reason: control.reason } : {}),
    };
  }
  return {
    kind: "steer",
    opId: event.opId,
    workspaceRevision: event.workspaceRevision,
    runtimeSessionId: event.payload.runtimeSessionId,
    dispatchId: control.dispatchId,
    controlRequestId: control.controlRequestId,
    targetNodeId: control.targetNodeId,
    prompt: control.prompt,
    ...(control.expected !== undefined ? { expected: control.expected } : {}),
  };
}

/**
 * Edge-side event-driven consumer for Center-persisted runtime control requests.
 *
 * Complexity & Reliability (G38, F2, F3, F4):
 * - Zero full-history scans: returns in O(1) when the node holds no active local runtime handles.
 * - Reads bounded storage-level cursor pages `(runtimeSessionId, afterRevision, limit)` per active session.
 * - O(1) local active handle membership checks via `isRuntimeActive(runtimeSessionId)`.
 * - Deduplicates by canonical event `opId` (scoped to repo + session + action + controlRequestId).
 * - Advances each session's contiguous watermark only after every earlier event reaches a terminal disposition,
 *   never dropping pending controls across transient disconnects or out-of-order batch deferrals.
 */
export function createFleetEdgeRuntimeControlConsumer(input: {
  readonly nodeId: () => string;
  readonly activeRuntimeSessionIds: () => readonly string[];
  readonly isRuntimeActive: (runtimeSessionId: string) => boolean;
  readonly readControlEventsPage: (
    runtimeSessionId: string,
    afterRevision: number,
    limit: number,
  ) => Promise<readonly RemoteRuntimeControlEvent[]>;
  readonly executeCancel: (request: RemoteCancelControlRequest) => Promise<void>;
  readonly executeSteer: (request: RemoteSteerControlRequest) => Promise<void>;
  readonly reportSteerRejection?: (
    request: RemoteSteerControlRequest,
    rejection: { readonly code: string; readonly message: string },
  ) => Promise<void>;
  readonly schedule: (work: () => void | Promise<void>) => Promise<void>;
  readonly pageLimit?: number;
  readonly maxTrackedControlRequests?: number;
}) {
  const maxTracked = Math.max(1, input.maxTrackedControlRequests ?? DEFAULT_MAX_TRACKED_CONTROL_REQUESTS),
    pageLimit = Math.max(1, input.pageLimit ?? 64),
    completedOpIds = new Set<string>(),
    contiguousRevisionBySession = new Map<string, number>();

  const rememberCompleted = (opId: string): void => {
    completedOpIds.delete(opId);
    completedOpIds.add(opId);
    while (completedOpIds.size > maxTracked) {
      const oldest = completedOpIds.keys().next().value;
      if (oldest === undefined) break;
      completedOpIds.delete(oldest);
    }
  };

  const advanceContiguousRevision = (
    blockedSessions: ReadonlySet<string>,
    runtimeSessionId: string,
    revision: number,
  ): void => {
    if (blockedSessions.has(runtimeSessionId)) return;
    const previous = contiguousRevisionBySession.get(runtimeSessionId) ?? 0;
    if (revision > previous) contiguousRevisionBySession.set(runtimeSessionId, revision);
  };

  return {
    drain: async (): Promise<void> => {
      const activeIds = input.activeRuntimeSessionIds();
      for (const sessionId of contiguousRevisionBySession.keys())
        if (!input.isRuntimeActive(sessionId)) contiguousRevisionBySession.delete(sessionId);
      if (activeIds.length === 0) return;

      const localNodeId = input.nodeId(),
        pending: RemoteControlRequestEntry[] = [],
        blockedSessions = new Set<string>(),
        highestScannedRevisionBySession = new Map<string, number>(),
        advanceCandidates = new Map<string, number>();

      for (const runtimeSessionId of activeIds) {
        if (!input.isRuntimeActive(runtimeSessionId)) continue;
        let cursor = contiguousRevisionBySession.get(runtimeSessionId) ?? 0;
        let hasPendingForSession = false;
        for (;;) {
          const page = await input.readControlEventsPage(runtimeSessionId, cursor, pageLimit);
          if (page.length === 0) break;
          let maxRevInPage = cursor;
          for (const event of page) {
            if (event.workspaceRevision > maxRevInPage) maxRevInPage = event.workspaceRevision;
            if (event.payload.runtimeSessionId !== runtimeSessionId) continue;
            highestScannedRevisionBySession.set(
              runtimeSessionId,
              Math.max(highestScannedRevisionBySession.get(runtimeSessionId) ?? 0, event.workspaceRevision),
            );
            const request = extractRemoteControlRequest(event);
            if (request === null || request.targetNodeId !== localNodeId || completedOpIds.has(request.opId)) {
              if (!hasPendingForSession) advanceCandidates.set(runtimeSessionId, event.workspaceRevision);
              continue;
            }
            hasPendingForSession = true;
            pending.push(request);
          }
          if (maxRevInPage <= cursor || page.length < pageLimit) break;
          cursor = maxRevInPage;
        }
      }

      for (const [sessionId, revision] of advanceCandidates)
        advanceContiguousRevision(blockedSessions, sessionId, revision);

      if (pending.length === 0) return;
      pending.sort((left, right) => left.workspaceRevision - right.workspaceRevision);

      await input.schedule(async () => {
        for (const request of pending) {
          const { runtimeSessionId, opId, workspaceRevision } = request;
          if (completedOpIds.has(opId)) {
            advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
            continue;
          }
          if (!input.isRuntimeActive(runtimeSessionId)) {
            rememberCompleted(opId);
            advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
            continue;
          }
          if (request.kind === "cancel") {
            const result = await runControlStep(() => input.executeCancel(request));
            if (result.outcome === "applied" || result.outcome === "not_running") {
              rememberCompleted(opId);
              advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
            } else {
              // Retryable disconnect/lifecycle failure while process is still alive: keep pending.
              blockedSessions.add(runtimeSessionId);
            }
            continue;
          }
          const result = await runControlStep(() => input.executeSteer(request));
          if (result.outcome === "applied") {
            rememberCompleted(opId);
            advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
          } else if (result.outcome === "deferred") {
            if (input.isRuntimeActive(runtimeSessionId)) {
              blockedSessions.add(runtimeSessionId);
            } else {
              rememberCompleted(opId);
              advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
            }
          } else {
            // Terminal refusal (`runtime_steer_target_changed`, `runtime_steer_unsupported`, or `runtime_not_running`).
            if (input.reportSteerRejection && result.outcome === "rejected") {
              const reported = await runControlStep(() =>
                input.reportSteerRejection!(request, { code: result.code, message: result.message }),
              );
              if (reported.outcome === "deferred" && input.isRuntimeActive(runtimeSessionId)) {
                blockedSessions.add(runtimeSessionId);
                continue;
              }
            }
            rememberCompleted(opId);
            advanceContiguousRevision(blockedSessions, runtimeSessionId, workspaceRevision);
          }
        }
        // Once every pending event for a session completes without deferrals, advance its contiguous
        // watermark past any already-completed trailing events scanned in this batch.
        for (const [sessionId, scannedRevision] of highestScannedRevisionBySession)
          advanceContiguousRevision(blockedSessions, sessionId, scannedRevision);
      });
    },
  };
}
