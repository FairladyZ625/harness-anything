import { randomUUID } from "node:crypto";
import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { runFleetEdgeTaskCommand, runFleetEdgeWrite, runFleetTaskCommandClient } from "./fleet-edge-write.ts";

export interface FleetEdgeSteerReceiptPump {
  readonly trigger: () => void;
  readonly close: () => void;
}

/**
 * F13: Dedicated non-blocking steer-receipt uplink pump completely decoupled from
 * control drain, workQueue, and runtime settlement.
 */
export function createFleetEdgeSteerReceiptPump(input: {
  readonly hasPending: () => boolean;
  readonly flushPending: () => Promise<void>;
  readonly retryDelayMs?: number;
}): FleetEdgeSteerReceiptPump {
  let inFlight: Promise<void> | null = null,
    dirty = false,
    closed = false,
    retryTimer: NodeJS.Timeout | null = null;
  const retryDelayMs = input.retryDelayMs ?? 250;

  const scheduleRetry = (): void => {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      trigger();
    }, retryDelayMs);
    retryTimer.unref?.();
  };

  const flushOnce = async (): Promise<{ readonly flushed: boolean }> => {
    try {
      await input.flushPending();
      return { flushed: true };
    } catch (error) {
      console.error("[runtime-steer-receipts] background flush deferred:", error);
      return { flushed: false };
    }
  };

  const trigger = (): void => {
    if (closed) return;
    dirty = true;
    if (inFlight !== null) return;
    inFlight = (async () => {
      while (dirty && !closed) {
        dirty = false;
        if (!input.hasPending()) break;
        const result = await flushOnce();
        if (!result.flushed) {
          if (input.hasPending()) scheduleRetry();
          break;
        }
      }
    })().finally(() => {
      inFlight = null;
      if (dirty && !closed) trigger();
    });
  };

  return {
    trigger,
    close: () => {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}

export async function forwardFleetEdgeRemoteRuntimeControl(input: {
  readonly kind: "runtime-cancel" | "runtime-steer";
  readonly action: JsonObject;
  readonly requestAuth?: DaemonAuthenticationContext;
  readonly centerWriteWaitMs: number;
  readonly request: {
    readonly viewRoot: string;
    readonly repoId: string;
    readonly nodeId: string;
  };
  readonly writePeer: Omit<
    Parameters<typeof runFleetTaskCommandClient>[0],
    "signal" | "executionCredential" | "repoId" | "taskId" | "opId" | "waitMs" | "timeoutMs" | "action"
  >;
}): Promise<JsonObject> {
  const { kind, action, requestAuth, centerWriteWaitMs, request, writePeer } = input,
    connectionSignal = requestAuth?.connectionSignal;
  if (requestAuth?.executionPrincipal && !requestAuth.executionCredential) throw executionCredentialRejected();
  const { executor: _executor, ...wireAction } = action,
    opId = typeof action.idempotencyKey === "string" ? action.idempotencyKey : randomUUID(),
    deadline = Date.now() + centerWriteWaitMs,
    executionCredential = requestAuth?.executionCredential;
  const forwarded = await runFleetEdgeTaskCommand({
    timeoutMs: centerWriteWaitMs,
    readOnly: false,
    ...(connectionSignal ? { signal: connectionSignal } : {}),
    write: () => {
      throw new Error("Remote runtime control settles through runFleetEdgeWrite.");
    },
    settle: () => {
      const remaining = Math.max(1, deadline - Date.now());
      return runFleetEdgeWrite({
        viewRoot: request.viewRoot,
        repoId: request.repoId,
        nodeId: request.nodeId,
        timeoutMs: remaining,
        ...(connectionSignal ? { signal: connectionSignal } : {}),
        write: () =>
          runFleetTaskCommandClient({
            ...writePeer,
            ...(connectionSignal ? { signal: connectionSignal } : {}),
            ...(executionCredential ? { executionCredential } : {}),
            repoId: request.repoId,
            taskId: null,
            opId,
            waitMs: remaining,
            timeoutMs: remaining + daemonProtocolFleetPolicy.defaultValue.fleet.receiptResponseOverheadMs,
            action: { kind, ...wireAction } as { kind: string },
          }),
      });
    },
  });
  return forwarded.receipt as JsonObject;
}
