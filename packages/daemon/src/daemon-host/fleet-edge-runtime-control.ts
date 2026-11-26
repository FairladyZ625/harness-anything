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
const DEFAULT_MAX_OUT_OF_ORDER_STEERS = 64;

const retryableControlCodes = new Set([
  "runtime_steer_unavailable",
  "stop_unconfirmed",
  "dispatch_lifecycle_pending",
  "fleet_peer_unavailable",
  "fleet_transport_closed",
  "fleet_timeout",
  "fleet_busy",
  "replica_lag_timeout",
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
 * Complexity & Reliability (G38, F2, F3, F4, F5, F12, F13, F14):
 * - Zero full-history scans: returns in O(1) when the node holds no active local runtime handles and no pending rejections.
 * - Reads bounded storage-level cursor pages `(runtimeSessionId, afterRevision, limit)` per active session.
 * - Persists the contiguous settled revision cursor (`advanceDurableCursor`) so daemon restarts and >512 opId sessions never re-deliver earlier steers (F12).
 * - Preserves an independent cancel discovery path (`readCancelControlEvent` + `cancelScanCursorBySession`) and executes cancels before deferred steers/rejections so a full page of deferred steers NEVER starves cancel (F13).
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
  readonly readCancelControlEvent?: (
    runtimeSessionId: string,
    afterRevision: number,
    limit: number,
  ) => Promise<{ readonly event: RemoteRuntimeControlEvent | null; readonly scannedToRevision: number }>;
  readonly readDurableCursor?: (runtimeSessionId: string) => number;
  readonly advanceDurableCursor?: (runtimeSessionId: string, revision: number) => void;
  /** Durable out-of-order settled control opIds strictly above the contiguous cursor (F12). */
  readonly readSettledAboveCursor?: (
    runtimeSessionId: string,
  ) => readonly { readonly opId: string; readonly revision: number }[];
  readonly recordSettledAboveCursor?: (runtimeSessionId: string, opId: string, revision: number) => void;
  /** Explicit steer backpressure (e.g. pending receipt backlog >= 512); never blocks cancel (F12 & F13). */
  readonly isSteerBackpressured?: () => boolean;
  readonly maxOutOfOrderSteers?: number;
  readonly executeCancel: (request: RemoteCancelControlRequest) => Promise<void>;
  readonly executeSteer: (request: RemoteSteerControlRequest) => Promise<void>;
  readonly reportSteerRejection?: (
    request: RemoteSteerControlRequest,
    rejection: { readonly code: string; readonly message: string },
  ) => void | Promise<void>;
  readonly schedule: (work: () => void | Promise<void>) => Promise<void>;
  readonly pageLimit?: number;
  readonly maxPagesPerDrain?: number;
  readonly maxTrackedControlRequests?: number;
}) {
  const maxTracked = Math.max(1, input.maxTrackedControlRequests ?? DEFAULT_MAX_TRACKED_CONTROL_REQUESTS),
    pageLimit = Math.max(1, input.pageLimit ?? 64),
    maxPagesPerDrain = Math.max(1, input.maxPagesPerDrain ?? 4),
    maxOutOfOrderSteers = Math.max(1, input.maxOutOfOrderSteers ?? DEFAULT_MAX_OUT_OF_ORDER_STEERS),
    completedOpIds = new Set<string>(),
    durableCursorBySession = new Map<string, number>(),
    settledAboveCursorBySession = new Map<string, Map<string, number>>(),
    scanCursorBySession = new Map<string, number>(),
    cancelScanCursorBySession = new Map<string, number>(),
    pendingCancelBySession = new Map<string, RemoteCancelControlRequest>(),
    deferredSteersBySession = new Map<string, Map<string, RemoteSteerControlRequest>>(),
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

  const isCompleted = (runtimeSessionId: string, opId: string): boolean =>
    completedOpIds.has(opId) || settledAboveCursorBySession.get(runtimeSessionId)?.has(opId) === true;

  const markSettled = (runtimeSessionId: string, opId: string, revision: number): void => {
    rememberCompleted(opId);
    const durable = durableCursorBySession.get(runtimeSessionId) ?? 0;
    if (revision > durable) {
      let above = settledAboveCursorBySession.get(runtimeSessionId);
      if (!above) {
        above = new Map();
        settledAboveCursorBySession.set(runtimeSessionId, above);
      }
      if (!above.has(opId)) {
        above.set(opId, revision);
        input.recordSettledAboveCursor?.(runtimeSessionId, opId, revision);
      }
    }
  };

  const enqueueDeferredSteer = (request: RemoteSteerControlRequest): void => {
    let sessionDeferred = deferredSteersBySession.get(request.runtimeSessionId);
    if (!sessionDeferred) {
      sessionDeferred = new Map();
      deferredSteersBySession.set(request.runtimeSessionId, sessionDeferred);
    }
    if (!sessionDeferred.has(request.opId)) sessionDeferred.set(request.opId, request);
  };

  const removeDeferredSteer = (runtimeSessionId: string, opId: string): void => {
    const sessionDeferred = deferredSteersBySession.get(runtimeSessionId);
    if (!sessionDeferred) return;
    sessionDeferred.delete(opId);
    if (sessionDeferred.size === 0) deferredSteersBySession.delete(runtimeSessionId);
  };

  const advanceScanCursor = (runtimeSessionId: string, revision: number): void => {
    const previous = scanCursorBySession.get(runtimeSessionId) ?? 0;
    if (revision > previous) scanCursorBySession.set(runtimeSessionId, revision);
    const prevCancel = cancelScanCursorBySession.get(runtimeSessionId) ?? 0;
    if (revision > prevCancel) cancelScanCursorBySession.set(runtimeSessionId, revision);
  };

  const advanceCancelCursor = (runtimeSessionId: string, revision: number): void => {
    const prevCancel = cancelScanCursorBySession.get(runtimeSessionId) ?? 0;
    if (revision > prevCancel) cancelScanCursorBySession.set(runtimeSessionId, revision);
  };

  /** Persists the highest contiguous revision with zero unsettled deferred steers, pending cancels, or unpersisted rejections. */
  const persistContiguousCursor = (runtimeSessionId: string): void => {
    const scanned = scanCursorBySession.get(runtimeSessionId) ?? 0;
    if (scanned <= 0) return;
    let lowestUnsettled = Number.POSITIVE_INFINITY;
    const pendingCancel = pendingCancelBySession.get(runtimeSessionId);
    if (pendingCancel && pendingCancel.workspaceRevision < lowestUnsettled)
      lowestUnsettled = pendingCancel.workspaceRevision;
    const sessionDeferred = deferredSteersBySession.get(runtimeSessionId);
    if (sessionDeferred) {
      for (const req of sessionDeferred.values()) {
        if (req.workspaceRevision < lowestUnsettled) lowestUnsettled = req.workspaceRevision;
      }
    }
    for (const entry of pendingRejections.values()) {
      if (entry.request.runtimeSessionId === runtimeSessionId && entry.request.workspaceRevision < lowestUnsettled)
        lowestUnsettled = entry.request.workspaceRevision;
    }
    const contiguous = Number.isFinite(lowestUnsettled) ? Math.max(0, lowestUnsettled - 1) : scanned;
    const previousDurable = durableCursorBySession.get(runtimeSessionId) ?? 0;
    if (contiguous > previousDurable) {
      durableCursorBySession.set(runtimeSessionId, contiguous);
      const above = settledAboveCursorBySession.get(runtimeSessionId);
      if (above) {
        for (const [opId, rev] of [...above.entries()]) {
          if (rev <= contiguous) above.delete(opId);
        }
        if (above.size === 0) settledAboveCursorBySession.delete(runtimeSessionId);
      }
      input.advanceDurableCursor?.(runtimeSessionId, contiguous);
    }
  };

  /** Durably records a steer rejection BEFORE settling or advancing cursor (F12). */
  const persistSteerRejection = async (
    request: RemoteSteerControlRequest,
    rejection: { readonly code: string; readonly message: string },
  ): Promise<boolean> => {
    if (!input.reportSteerRejection) return true;
    const reported = await runControlStep(async () => {
      await input.reportSteerRejection!(request, rejection);
    });
    if (reported.outcome !== "deferred") {
      pendingRejections.delete(request.opId);
      return true;
    }
    pendingRejections.set(request.opId, { request, rejection });
    return false;
  };

  const flushPendingRejections = async (skipOpIds?: ReadonlySet<string>): Promise<void> => {
    if (!input.reportSteerRejection || pendingRejections.size === 0) return;
    for (const [opId, entry] of [...pendingRejections.entries()]) {
      if (skipOpIds?.has(opId)) continue;
      const persisted = await persistSteerRejection(entry.request, entry.rejection);
      if (persisted) {
        markSettled(entry.request.runtimeSessionId, opId, entry.request.workspaceRevision);
        removeDeferredSteer(entry.request.runtimeSessionId, opId);
        persistContiguousCursor(entry.request.runtimeSessionId);
      }
    }
  };

  const initSessionCursors = (runtimeSessionId: string): void => {
    if (!scanCursorBySession.has(runtimeSessionId)) {
      const durable = Math.max(0, input.readDurableCursor?.(runtimeSessionId) ?? 0);
      durableCursorBySession.set(runtimeSessionId, durable);
      scanCursorBySession.set(runtimeSessionId, durable);
      cancelScanCursorBySession.set(runtimeSessionId, durable);
      const settled = input.readSettledAboveCursor?.(runtimeSessionId) ?? [];
      if (settled.length > 0) {
        const map = new Map<string, number>();
        for (const entry of settled) {
          if (entry.revision > durable) map.set(entry.opId, entry.revision);
        }
        if (map.size > 0) settledAboveCursorBySession.set(runtimeSessionId, map);
      }
    }
  };

  const isOutOfOrderBackpressured = (runtimeSessionId: string): boolean =>
    (settledAboveCursorBySession.get(runtimeSessionId)?.size ?? 0) >= maxOutOfOrderSteers;

  const minSettledAboveCursor = (runtimeSessionId: string): number => {
    const above = settledAboveCursorBySession.get(runtimeSessionId);
    if (!above || above.size === 0) return Number.POSITIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (const rev of above.values()) {
      if (rev < lowest) lowest = rev;
    }
    return lowest;
  };

  return {
    drain: async (): Promise<void> => {
      const activeIds = input.activeRuntimeSessionIds();
      for (const sessionId of [...scanCursorBySession.keys()])
        if (!input.isRuntimeActive(sessionId)) {
          scanCursorBySession.delete(sessionId);
          cancelScanCursorBySession.delete(sessionId);
          durableCursorBySession.delete(sessionId);
          settledAboveCursorBySession.delete(sessionId);
          pendingCancelBySession.delete(sessionId);
          deferredSteersBySession.delete(sessionId);
        }
      if (activeIds.length === 0 && pendingRejections.size === 0) return;

      const localNodeId = input.nodeId();
      const receiptBackpressured = input.isSteerBackpressured?.() === true;

      for (const runtimeSessionId of activeIds) {
        if (!input.isRuntimeActive(runtimeSessionId)) continue;
        initSessionCursors(runtimeSessionId);
        let cursor = scanCursorBySession.get(runtimeSessionId) ?? 0;
        let pagesRead = 0;
        const oooGapBoundary = minSettledAboveCursor(runtimeSessionId);
        let steerBacklogFull =
          receiptBackpressured || (isOutOfOrderBackpressured(runtimeSessionId) && cursor >= oooGapBoundary);
        while (!steerBacklogFull && pagesRead < maxPagesPerDrain) {
          const existingDeferredCount = deferredSteersBySession.get(runtimeSessionId)?.size ?? 0;
          if (existingDeferredCount >= pageLimit) {
            steerBacklogFull = true;
            break;
          }
          const rawPage = await input.readControlEventsPage(runtimeSessionId, cursor, pageLimit);
          pagesRead += 1;
          const paged = !Array.isArray(rawPage) ? (rawPage as RemoteControlEventsPage) : null;
          const events = paged ? paged.events : (rawPage as readonly RemoteRuntimeControlEvent[]);
          let maxRevInPage = cursor;
          for (const event of events) {
            if (event.workspaceRevision > maxRevInPage) maxRevInPage = event.workspaceRevision;
            if (event.payload.runtimeSessionId !== runtimeSessionId) continue;
            const request = extractRemoteControlRequest(event);
            if (request === null || request.targetNodeId !== localNodeId || isCompleted(runtimeSessionId, request.opId))
              continue;
            if (pendingRejections.has(request.opId)) continue;
            if (request.kind === "cancel") {
              if (!pendingCancelBySession.has(runtimeSessionId)) pendingCancelBySession.set(runtimeSessionId, request);
            } else {
              enqueueDeferredSteer(request);
            }
          }
          const scannedTo = paged ? Math.max(maxRevInPage, paged.scannedToRevision) : maxRevInPage;
          advanceScanCursor(runtimeSessionId, scannedTo);
          if (maxRevInPage <= cursor || events.length < pageLimit) break;
          cursor = Math.max(maxRevInPage, scannedTo);
          if (isOutOfOrderBackpressured(runtimeSessionId) && cursor >= oooGapBoundary) {
            steerBacklogFull = true;
            break;
          }
        }
        // F13: When deferred steers saturate `pageLimit`, steer backpressure is active, or
        // maxPagesPerDrain was reached without finding a cancel, ALWAYS probe forward for a
        // pending cancel so steer backlog or receipt backpressure can NEVER starve cancellation.
        const deferredCountAfterPages = deferredSteersBySession.get(runtimeSessionId)?.size ?? 0;
        if (
          (steerBacklogFull || deferredCountAfterPages >= pageLimit || pagesRead >= maxPagesPerDrain) &&
          !pendingCancelBySession.has(runtimeSessionId)
        ) {
          let cancelCursor = Math.max(
            cancelScanCursorBySession.get(runtimeSessionId) ?? 0,
            scanCursorBySession.get(runtimeSessionId) ?? 0,
          );
          if (input.readCancelControlEvent) {
            const probed = await input.readCancelControlEvent(runtimeSessionId, cancelCursor, pageLimit);
            const found = probed.event ? extractRemoteControlRequest(probed.event) : null;
            if (
              found &&
              found.kind === "cancel" &&
              found.runtimeSessionId === runtimeSessionId &&
              found.targetNodeId === localNodeId &&
              !isCompleted(runtimeSessionId, found.opId)
            ) {
              pendingCancelBySession.set(runtimeSessionId, found);
            }
            advanceCancelCursor(
              runtimeSessionId,
              Math.max(cancelCursor, probed.event?.workspaceRevision ?? 0, probed.scannedToRevision),
            );
          } else {
            let cancelPages = 0;
            while (cancelPages < maxPagesPerDrain && !pendingCancelBySession.has(runtimeSessionId)) {
              const rawPage = await input.readControlEventsPage(runtimeSessionId, cancelCursor, pageLimit);
              cancelPages += 1;
              const paged = !Array.isArray(rawPage) ? (rawPage as RemoteControlEventsPage) : null;
              const events = paged ? paged.events : (rawPage as readonly RemoteRuntimeControlEvent[]);
              let maxRevInPage = cancelCursor;
              for (const event of events) {
                if (event.workspaceRevision > maxRevInPage) maxRevInPage = event.workspaceRevision;
                if (event.payload.runtimeSessionId !== runtimeSessionId) continue;
                const request = extractRemoteControlRequest(event);
                if (
                  request !== null &&
                  request.kind === "cancel" &&
                  request.targetNodeId === localNodeId &&
                  !isCompleted(runtimeSessionId, request.opId)
                ) {
                  pendingCancelBySession.set(runtimeSessionId, request);
                  break;
                }
              }
              const scannedTo = paged ? Math.max(maxRevInPage, paged.scannedToRevision) : maxRevInPage;
              advanceCancelCursor(runtimeSessionId, scannedTo);
              if (maxRevInPage <= cancelCursor || events.length < pageLimit) break;
              cancelCursor = Math.max(maxRevInPage, scannedTo);
            }
          }
        }
        persistContiguousCursor(runtimeSessionId);
      }

      const pendingCancels = [...pendingCancelBySession.values()].sort(
        (left, right) => left.workspaceRevision - right.workspaceRevision,
      );
      const pendingSteers: RemoteSteerControlRequest[] = [];
      for (const sessionDeferred of deferredSteersBySession.values()) {
        for (const request of sessionDeferred.values()) pendingSteers.push(request);
      }
      pendingSteers.sort((left, right) => left.workspaceRevision - right.workspaceRevision);

      if (pendingCancels.length === 0 && pendingSteers.length === 0 && pendingRejections.size === 0) return;

      await input.schedule(async () => {
        const attemptedRejectionsThisDrain = new Set<string>();
        // Phase 1 (F13): Execute ALL pending cancels FIRST — never behind deferred steers,
        // steer backpressure, or rejection persistence.
        for (const cancelReq of pendingCancels) {
          const { runtimeSessionId, opId } = cancelReq;
          if (isCompleted(runtimeSessionId, opId)) {
            pendingCancelBySession.delete(runtimeSessionId);
            continue;
          }
          const supersededSteers = [...(deferredSteersBySession.get(runtimeSessionId)?.values() ?? [])];
          if (!input.isRuntimeActive(runtimeSessionId)) {
            let allSupersededPersisted = true;
            for (const steered of supersededSteers) {
              attemptedRejectionsThisDrain.add(steered.opId);
              const persisted = await persistSteerRejection(steered, {
                code: "runtime_cancelled",
                message: "Remote steer was superseded by session cancellation.",
              });
              if (persisted) {
                markSettled(runtimeSessionId, steered.opId, steered.workspaceRevision);
                removeDeferredSteer(runtimeSessionId, steered.opId);
              } else {
                allSupersededPersisted = false;
              }
            }
            markSettled(runtimeSessionId, opId, cancelReq.workspaceRevision);
            pendingCancelBySession.delete(runtimeSessionId);
            if (allSupersededPersisted) deferredSteersBySession.delete(runtimeSessionId);
            persistContiguousCursor(runtimeSessionId);
            continue;
          }
          const result = await runControlStep(() => input.executeCancel(cancelReq));
          if (result.outcome === "applied" || result.outcome === "not_running") {
            let allSupersededPersisted = true;
            for (const steered of supersededSteers) {
              attemptedRejectionsThisDrain.add(steered.opId);
              const persisted = await persistSteerRejection(steered, {
                code: "runtime_cancelled",
                message: "Remote steer was superseded by session cancellation.",
              });
              if (persisted) {
                markSettled(runtimeSessionId, steered.opId, steered.workspaceRevision);
                removeDeferredSteer(runtimeSessionId, steered.opId);
              } else {
                allSupersededPersisted = false;
              }
            }
            markSettled(runtimeSessionId, opId, cancelReq.workspaceRevision);
            pendingCancelBySession.delete(runtimeSessionId);
            if (allSupersededPersisted) deferredSteersBySession.delete(runtimeSessionId);
            advanceScanCursor(runtimeSessionId, cancelReq.workspaceRevision);
            persistContiguousCursor(runtimeSessionId);
          }
        }

        // Phase 2: Execute deferred steers for still-active, non-cancelled sessions in revision order.
        // Under receipt backpressure, pause admitting/executing steers (cancel still ran above).
        // Under out-of-order window backpressure, only retry the oldest pinned deferred steer so
        // the gap can close without evicting settled opIds above the cursor.
        const steerBackpressuredNow = input.isSteerBackpressured?.() === true;
        for (const request of pendingSteers) {
          const { runtimeSessionId, opId } = request;
          if (pendingCancelBySession.has(runtimeSessionId)) continue;
          if (isCompleted(runtimeSessionId, opId) || pendingRejections.has(opId)) {
            removeDeferredSteer(runtimeSessionId, opId);
            persistContiguousCursor(runtimeSessionId);
            continue;
          }
          if (!input.isRuntimeActive(runtimeSessionId)) {
            attemptedRejectionsThisDrain.add(opId);
            const persisted = await persistSteerRejection(request, {
              code: "runtime_not_running",
              message: "Runtime session is no longer running on the target node.",
            });
            if (persisted) {
              markSettled(runtimeSessionId, opId, request.workspaceRevision);
              removeDeferredSteer(runtimeSessionId, opId);
              persistContiguousCursor(runtimeSessionId);
            }
            continue;
          }
          if (steerBackpressuredNow) continue;
          if (isOutOfOrderBackpressured(runtimeSessionId)) {
            const sessionDeferred = deferredSteersBySession.get(runtimeSessionId);
            let lowestDeferred = Number.POSITIVE_INFINITY;
            if (sessionDeferred) {
              for (const req of sessionDeferred.values()) {
                if (req.workspaceRevision < lowestDeferred) lowestDeferred = req.workspaceRevision;
              }
            }
            if (request.workspaceRevision > lowestDeferred) continue;
          }
          const result = await runControlStep(() => input.executeSteer(request));
          if (result.outcome === "applied") {
            markSettled(runtimeSessionId, opId, request.workspaceRevision);
            removeDeferredSteer(runtimeSessionId, opId);
            persistContiguousCursor(runtimeSessionId);
          } else if (result.outcome === "deferred") {
            if (!input.isRuntimeActive(runtimeSessionId)) {
              attemptedRejectionsThisDrain.add(opId);
              const persisted = await persistSteerRejection(request, {
                code: "runtime_not_running",
                message: "Runtime session exited before remote steer could be applied.",
              });
              if (persisted) {
                markSettled(runtimeSessionId, opId, request.workspaceRevision);
                removeDeferredSteer(runtimeSessionId, opId);
                persistContiguousCursor(runtimeSessionId);
              }
            }
          } else {
            // Terminal refusal (`runtime_steer_target_changed`, `runtime_steer_unsupported`, or `runtime_not_running`).
            // F12: Durably persist rejection BEFORE removing deferred steer or advancing cursor.
            attemptedRejectionsThisDrain.add(opId);
            const persisted = await persistSteerRejection(request, {
              code: result.code,
              message: result.message,
            });
            if (persisted) {
              markSettled(runtimeSessionId, opId, request.workspaceRevision);
              removeDeferredSteer(runtimeSessionId, opId);
              persistContiguousCursor(runtimeSessionId);
            }
          }
        }

        // Phase 3: Retry any locally deferred rejection persistence (skipping opIds already tried in this drain).
        await flushPendingRejections(attemptedRejectionsThisDrain);
      });
    },
  };
}
