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

export interface RemoteControlEventsPage {
  readonly events: readonly RemoteRuntimeControlEvent[];
  /** Highest repository revision known to have been scanned for this session (e.g. replica cut watermark on partial/empty page). */
  readonly scannedToRevision: number;
}

/**
 * Edge-side event-driven consumer for Center-persisted runtime control requests.
 *
 * Complexity & Reliability (G38, F2, F3, F4, F5):
 * - Zero full-history scans: returns in O(1) when the node holds no active local runtime handles and no pending rejections.
 * - Reads bounded storage-level cursor pages `(runtimeSessionId, afterRevision, limit)` per active session.
 * - Advances `scanCursorBySession` to `scannedToRevision` across empty/non-matching pages so tails are never re-scanned.
 * - Retains deferred requests in a bounded in-memory queue per session instead of re-scanning suffixes from storage.
 * - Durably retries unacknowledged rejection receipts even after the local session exits.
 */
export function createFleetEdgeRuntimeControlConsumer(input: {
  readonly nodeId: () => string;
  readonly activeRuntimeSessionIds: () => readonly string[];
  readonly isRuntimeActive: (runtimeSessionId: string) => boolean;
  readonly readControlEventsPage: (
    runtimeSessionId: string,
    afterRevision: number,
    limit: number,
  ) => Promise<readonly RemoteRuntimeControlEvent[] | RemoteControlEventsPage>;
  readonly executeCancel: (request: RemoteCancelControlRequest) => Promise<void>;
  readonly executeSteer: (request: RemoteSteerControlRequest) => Promise<void>;
  readonly reportSteerRejection?: (
    request: RemoteSteerControlRequest,
    rejection: { readonly code: string; readonly message: string },
  ) => Promise<void>;
  readonly schedule: (work: () => void | Promise<void>) => Promise<void>;
  readonly pageLimit?: number;
  readonly maxPagesPerDrain?: number;
  readonly maxTrackedControlRequests?: number;
}) {
  const maxTracked = Math.max(1, input.maxTrackedControlRequests ?? DEFAULT_MAX_TRACKED_CONTROL_REQUESTS),
    pageLimit = Math.max(1, input.pageLimit ?? 64),
    maxPagesPerDrain = Math.max(1, input.maxPagesPerDrain ?? 4),
    completedOpIds = new Set<string>(),
    scanCursorBySession = new Map<string, number>(),
    deferredBySession = new Map<string, Map<string, RemoteControlRequestEntry>>(),
    pendingRejections = new Map<
      string,
      {
        readonly request: RemoteSteerControlRequest;
        readonly rejection: { readonly code: string; readonly message: string };
      }
    >();

  const rememberCompleted = (opId: string): void => {
    completedOpIds.delete(opId);
    completedOpIds.add(opId);
    while (completedOpIds.size > maxTracked) {
      const oldest = completedOpIds.keys().next().value;
      if (oldest === undefined) break;
      completedOpIds.delete(oldest);
    }
  };

  const enqueueDeferred = (request: RemoteControlRequestEntry): void => {
    let sessionDeferred = deferredBySession.get(request.runtimeSessionId);
    if (!sessionDeferred) {
      sessionDeferred = new Map();
      deferredBySession.set(request.runtimeSessionId, sessionDeferred);
    }
    if (!sessionDeferred.has(request.opId)) sessionDeferred.set(request.opId, request);
  };

  const removeDeferred = (runtimeSessionId: string, opId: string): void => {
    const sessionDeferred = deferredBySession.get(runtimeSessionId);
    if (!sessionDeferred) return;
    sessionDeferred.delete(opId);
    if (sessionDeferred.size === 0) deferredBySession.delete(runtimeSessionId);
  };

  const advanceScanCursor = (runtimeSessionId: string, revision: number): void => {
    const previous = scanCursorBySession.get(runtimeSessionId) ?? 0;
    if (revision > previous) scanCursorBySession.set(runtimeSessionId, revision);
  };

  const flushPendingRejections = async (): Promise<void> => {
    if (!input.reportSteerRejection || pendingRejections.size === 0) return;
    for (const [opId, entry] of [...pendingRejections.entries()]) {
      const reported = await runControlStep(() => input.reportSteerRejection!(entry.request, entry.rejection));
      if (reported.outcome !== "deferred") {
        pendingRejections.delete(opId);
        rememberCompleted(opId);
        removeDeferred(entry.request.runtimeSessionId, opId);
      }
    }
  };

  return {
    drain: async (): Promise<void> => {
      const activeIds = input.activeRuntimeSessionIds();
      for (const sessionId of [...scanCursorBySession.keys()])
        if (!input.isRuntimeActive(sessionId)) {
          scanCursorBySession.delete(sessionId);
          deferredBySession.delete(sessionId);
        }
      if (activeIds.length === 0 && pendingRejections.size === 0) return;

      const localNodeId = input.nodeId();

      for (const runtimeSessionId of activeIds) {
        if (!input.isRuntimeActive(runtimeSessionId)) continue;
        let cursor = scanCursorBySession.get(runtimeSessionId) ?? 0;
        let pagesRead = 0;
        while (pagesRead < maxPagesPerDrain) {
          const existingDeferredCount = deferredBySession.get(runtimeSessionId)?.size ?? 0;
          if (existingDeferredCount >= pageLimit) break;
          const rawPage = await input.readControlEventsPage(runtimeSessionId, cursor, pageLimit);
          pagesRead += 1;
          const paged = !Array.isArray(rawPage) ? (rawPage as RemoteControlEventsPage) : null;
          const events = paged ? paged.events : (rawPage as readonly RemoteRuntimeControlEvent[]);
          let maxRevInPage = cursor;
          for (const event of events) {
            if (event.workspaceRevision > maxRevInPage) maxRevInPage = event.workspaceRevision;
            if (event.payload.runtimeSessionId !== runtimeSessionId) continue;
            const request = extractRemoteControlRequest(event);
            if (request === null || request.targetNodeId !== localNodeId || completedOpIds.has(request.opId)) continue;
            if (pendingRejections.has(request.opId)) continue;
            enqueueDeferred(request);
          }
          const scannedTo = paged ? Math.max(maxRevInPage, paged.scannedToRevision) : maxRevInPage;
          advanceScanCursor(runtimeSessionId, scannedTo);
          if (events.length === 0 || maxRevInPage <= cursor || events.length < pageLimit) break;
          cursor = Math.max(maxRevInPage, scannedTo);
        }
      }

      const pending: RemoteControlRequestEntry[] = [];
      for (const sessionDeferred of deferredBySession.values()) {
        for (const request of sessionDeferred.values()) pending.push(request);
      }
      if (pending.length === 0 && pendingRejections.size === 0) return;
      pending.sort((left, right) => left.workspaceRevision - right.workspaceRevision);

      await input.schedule(async () => {
        await flushPendingRejections();
        for (const request of pending) {
          const { runtimeSessionId, opId } = request;
          if (completedOpIds.has(opId) || pendingRejections.has(opId)) {
            removeDeferred(runtimeSessionId, opId);
            continue;
          }
          if (!input.isRuntimeActive(runtimeSessionId)) {
            rememberCompleted(opId);
            removeDeferred(runtimeSessionId, opId);
            continue;
          }
          if (request.kind === "cancel") {
            const result = await runControlStep(() => input.executeCancel(request));
            if (result.outcome === "applied" || result.outcome === "not_running") {
              rememberCompleted(opId);
              removeDeferred(runtimeSessionId, opId);
            }
            continue;
          }
          const result = await runControlStep(() => input.executeSteer(request));
          if (result.outcome === "applied") {
            rememberCompleted(opId);
            removeDeferred(runtimeSessionId, opId);
          } else if (result.outcome === "deferred") {
            if (!input.isRuntimeActive(runtimeSessionId)) {
              rememberCompleted(opId);
              removeDeferred(runtimeSessionId, opId);
            }
          } else {
            // Terminal refusal (`runtime_steer_target_changed`, `runtime_steer_unsupported`, or `runtime_not_running`).
            if (input.reportSteerRejection && result.outcome === "rejected") {
              const rejection = { code: result.code, message: result.message };
              pendingRejections.set(opId, { request, rejection });
              const reported = await runControlStep(() => input.reportSteerRejection!(request, rejection));
              if (reported.outcome === "deferred") continue;
              pendingRejections.delete(opId);
            }
            rememberCompleted(opId);
            removeDeferred(runtimeSessionId, opId);
          }
        }
      });
    },
  };
}
