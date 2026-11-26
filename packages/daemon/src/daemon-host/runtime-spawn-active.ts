import {
  SETTINGS_FIELD_DECLARATIONS,
  type SettingsFieldDeclaration,
} from "@harness-anything/kernel/internal/domain/settings-field-declarations.ts";
import { randomUUID } from "node:crypto";
import type {
  ActiveRuntime,
  ResumeProcessObservation,
  RuntimeBinding,
  RuntimeProcessObservation,
} from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeader, type DispatchStallEvidence } from "./dispatch-stream.ts";
import {
  markSteerReceiptAcked,
  readAllPendingSteerReceipts,
  readPendingSteerReceipts,
  recordPendingSteerReceipt,
  steerReceiptOpId,
} from "./dispatch-steer-state.ts";
import { DEFAULT_RUNTIME_STALL_TIMEOUT_MS, type DispatchLifecycleView } from "@harness-anything/kernel";
import { dispatchLifecyclePendingError, readDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { noteProviderProgress } from "./runtime-provider-connectivity.ts";
import { runtimeErrorCode } from "../runtime-engine/runtime-spawn-errors.ts";
import { sweepUntilProvenStopped, type ProviderGroupSweepVerdict } from "./runtime/process-group-reconciler.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { openRuntimeWorkspaceMonitor } from "../runtime-engine/runtime-workspace-monitor-thread.ts";
import { createWorkspaceActivityQueue } from "../runtime-engine/runtime-workspace-activity-queue.ts";

type ActiveRuntimeBase = Omit<
  ActiveRuntime,
  | "buffer"
  | "durableOutputCount"
  | "stdoutObserved"
  | "errorBuffer"
  | "errorOverflowed"
  | "providerSessionId"
  | "finalText"
  | "failureText"
  | "providerOutcome"
  | "writeItemObserved"
  | "strayWritePaths"
  | "planObserved"
  | "planIncomplete"
  | "protocolError"
  | "cancelRequested"
  | "cancelBinding"
  | "cancelOpId"
  | "spendCapExceeded"
  | "lastProgressAtMs"
  | "lastRealProgressAtMs"
  | "providerUnreachable"
  | "workspaceActivityCount"
  | "stalledAt"
  | "recordProviderProgress"
  | "recordWorkspaceProgress"
  | "lossReason"
  | "lossSignal"
  | "lossExitCode"
  | "toolCallObserved"
  | "localCommandSucceeded"
  | "nonEmptyAgentOutputObserved"
  | "providerUsageEmpty"
  | "providerFault"
  | "providerReconnectCount"
  | "lastProviderReconnect"
  | "successfulToolCallAfterReconnect"
  | "finalAgentMessageAfterReconnect"
  | "inputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "outputTokens"
  | "toolCallCount"
  | "usageReported"
  | "providerToolSteps"
  | "compacted"
  | "rawUsage"
  | "fallbackAttempt"
> & {
  readonly lastProgressAtMs: number;
  readonly lastRealProgressAtMs?: number;
  /** Canonical report restored on adoption so the next real progress can clear it. */
  readonly providerUnreachable?: ActiveRuntime["providerUnreachable"];
  readonly providerSessionId?: string | null;
  readonly fallbackAttempt?: ActiveRuntime["fallbackAttempt"];
  readonly workspaceActivityCount?: number;
  readonly stalledAt?: string | null;
};

const runtimeStallMinimumMs = (SETTINGS_FIELD_DECLARATIONS as readonly SettingsFieldDeclaration[]).find(
  ({ path }) => path[0] === "runtime" && path[1] === "stallTimeoutMs",
)!.minimum!;

export function createActiveRuntime(base: ActiveRuntimeBase): ActiveRuntime {
  const stallTimeoutMs =
      Number.isSafeInteger(base.stallTimeoutMs) && base.stallTimeoutMs >= runtimeStallMinimumMs
        ? base.stallTimeoutMs
        : DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
    lastProgressAtMs = Number.isFinite(base.lastProgressAtMs) ? base.lastProgressAtMs : Date.now(),
    lastRealProgressAtMs = Number.isFinite(base.lastRealProgressAtMs)
      ? (base.lastRealProgressAtMs as number)
      : lastProgressAtMs;
  return {
    ...base,
    steerReceiptCapable: base.steerReceiptCapable ?? true,
    releaseAuthorization: base.binding.retainAuthorization?.(),
    stallTimeoutMs,
    fallbackAttempt: base.fallbackAttempt ?? null,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: false,
    errorBuffer: "",
    errorOverflowed: false,
    providerSessionId: base.providerSessionId ?? null,
    finalText: null,
    failureText: null,
    providerOutcome: null,
    writeItemObserved: false,
    strayWritePaths: [],
    planObserved: false,
    planIncomplete: false,
    protocolError: false,
    cancelRequested: false,
    cancelBinding: null,
    cancelOpId: null,
    spendCapExceeded: false,
    lastProgressAtMs,
    lastRealProgressAtMs,
    providerUnreachable: base.providerUnreachable ?? null,
    workspaceActivityCount: base.workspaceActivityCount ?? 0,
    stalledAt: base.stalledAt ?? null,
    recordProviderProgress: null,
    recordWorkspaceProgress: null,
    lossReason: null,
    lossSignal: null,
    lossExitCode: null,
    toolCallObserved: false,
    localCommandSucceeded: false,
    nonEmptyAgentOutputObserved: false,
    providerUsageEmpty: false,
    providerFault: null,
    providerReconnectCount: 0,
    lastProviderReconnect: null,
    successfulToolCallAfterReconnect: false,
    finalAgentMessageAfterReconnect: false,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    toolCallCount: 0,
    usageReported: false,
    providerToolSteps: new Set(),
    compacted: false,
    rawUsage: {},
  };
}

type RuntimeObservationHandles = {
  timer: NodeJS.Timeout | null;
  monitor: ReturnType<typeof openRuntimeWorkspaceMonitor> | null;
  disposed: boolean;
  flushOnExit: boolean;
};

const observationHandles = new WeakMap<ActiveRuntime, RuntimeObservationHandles>();
const stallSettlementStarted = new WeakSet<ActiveRuntime>();

function releaseActiveRuntimeObservations(active: ActiveRuntime, flushOnExit: boolean): Promise<number | null> {
  const handles = observationHandles.get(active);
  if (!handles) return Promise.resolve(null);
  handles.flushOnExit = flushOnExit;
  handles.disposed = true;
  if (handles.timer) clearTimeout(handles.timer);
  active.recordProviderProgress = null;
  active.recordWorkspaceProgress = null;
  observationHandles.delete(active);
  return handles.monitor?.close() ?? Promise.resolve(null);
}

export function disposeActiveRuntimeObservations(active: ActiveRuntime): Promise<void> {
  return releaseActiveRuntimeObservations(active, false).then(
    () => undefined,
    (error: unknown) => {
      console.error("[runtime-observation] watcher termination failed", error);
    },
  );
}

export async function isRuntimeProcessProvenStopped(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  attempt: Pick<DispatchLifecycleView["attempt"], "stopProof">,
  pid = active.process.pid,
): Promise<ProviderGroupSweepVerdict> {
  if (attempt.stopProof === "proven_stopped") return "proven_stopped";
  if (pid === undefined || pid <= 1) return "unknown_unreachable";
  return sweepUntilProvenStopped({ pid, dispatch: { rootDir: context.input.rootDir, dispatchId: active.dispatchId } });
}

export async function settleStalledRuntime(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  if (active.exitSettlement || context.exiting.has(active.runtimeSessionId) || stallSettlementStarted.has(active))
    return;
  const lifecycle = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [active.dispatchId] });
  if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
  const current = lifecycle.rows[0];
  if (!current || current.policy.attemptSettled || current.attempt.process !== "alive") return;
  stallSettlementStarted.add(active);
  const newlyStalled = active.stalledAt === null,
    stalledAt = active.stalledAt ?? context.input.now();
  active.stalledAt ??= stalledAt;
  const liveProcessPids = newlyStalled ? await liveDescendantPids(active) : null;
  active.lossReason = `Dispatch stalled after ${String(active.stallTimeoutMs)} ms without provider or workspace progress.`;
  if (newlyStalled) active.stream.appendStalled?.(stalledAt, stallEvidence(active, stalledAt, liveProcessPids));
  if (active.process.cloud) return context.publishExit(active, null);
  await context.publishRuntimeEvent(
    "runtime_session_cancelled",
    { runtimeSessionId: active.runtimeSessionId },
    `runtime-stall-${active.dispatchId}`,
    active.binding,
  );
  if (active.process.terminateTree) await active.process.terminateTree();
  else if (!active.process.cloud) active.process.terminate();
  await consumeDurableOutput(context, active);
  await context.publishExit(active, null);
}

/** The dispatch-stream record that lets an operator replay why this attempt was cancelled. */
function stallEvidence(
  active: ActiveRuntime,
  stalledAt: string,
  liveProcessPids: readonly number[] | null,
): DispatchStallEvidence {
  return {
    lastProgressAt: new Date(active.lastProgressAtMs).toISOString(),
    stallTimeoutMs: active.stallTimeoutMs,
    idleMs: Math.max(0, Date.parse(stalledAt) - active.lastProgressAtMs),
    liveProcessPids,
  };
}

async function liveDescendantPids(active: ActiveRuntime): Promise<readonly number[] | null> {
  const probe = await active.process.liveDescendantPids?.();
  // Unavailable stays null: the record must say the process table could not be read, and the
  // caller keeps its historical deadline instead of treating silence as an empty subtree.
  return probe?.available ? probe.pids : null;
}

function armStallDeadline(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  handles: RuntimeObservationHandles,
  deadlineOverride?: number,
): void {
  if (handles.disposed || active.stalledAt !== null) return;
  if (handles.timer) clearTimeout(handles.timer);
  const deadline = deadlineOverride ?? active.lastProgressAtMs + active.stallTimeoutMs,
    remaining = Math.max(0, deadline - Date.now());
  handles.timer = setTimeout(() => {
    context.input.schedule(async () => {
      if (active.exitSettlement || context.exiting.has(active.runtimeSessionId)) return;
      if (Date.now() < deadline) {
        armStallDeadline(context, active, handles);
        return;
      }
      // An active descendant keeps a silent provider dispatch under observation.
      const childPids = await liveDescendantPids(active);
      if (childPids !== null && childPids.length > 0) {
        armStallDeadline(context, active, handles, Date.now() + active.stallTimeoutMs);
        return;
      }
      await settleStalledRuntime(context, active);
    }, active.binding);
  }, remaining);
  handles.timer.unref();
}

function attachRuntimeObservations(context: RuntimeSpawnerContext, active: ActiveRuntime): void {
  const handles: RuntimeObservationHandles = { timer: null, monitor: null, disposed: false, flushOnExit: false };
  observationHandles.set(active, handles);
  const observe = (work: () => void | Promise<void>, workspace = false): void => {
    context.input.schedule(() => {
      if ((handles.disposed && !(workspace && handles.flushOnExit)) || active.exitSettlement) return;
      try {
        return work();
      } catch (error) {
        retireObservationFault(context, active, error, handles.flushOnExit);
        throw error;
      }
    }, active.binding);
  };
  const progress = (workspaceChanged: boolean, observationAtMs?: number): void | Promise<void> => {
    if ((handles.disposed && !handles.flushOnExit) || active.exitSettlement || active.stalledAt !== null) return;
    const observedAtMs = observationAtMs ?? Date.now();
    active.lastProgressAtMs = Math.max(active.lastProgressAtMs, observedAtMs);
    if (workspaceChanged) {
      active.workspaceActivityCount += 1;
      active.lastRealProgressAtMs = Math.max(active.lastRealProgressAtMs, observedAtMs);
      active.stream.appendWorkspaceActivity?.(new Date(observedAtMs).toISOString());
      const publication = noteProviderProgress(context, active, observedAtMs);
      armStallDeadline(context, active, handles);
      return publication;
    }
    armStallDeadline(context, active, handles);
  };
  active.recordProviderProgress = () => progress(false);
  active.recordWorkspaceProgress = (observedAtMs) => progress(true, observedAtMs);
  if (active.stalledAt === null) armStallDeadline(context, active, handles);
  const queueWorkspace = createWorkspaceActivityQueue(
    (work) => observe(work, true),
    (observedAtMs) => progress(true, observedAtMs),
  );
  handles.monitor = openRuntimeWorkspaceMonitor(context.input.rootDir, active.cwd, (record) => {
    if (record.kind === "workspace_activity") {
      queueWorkspace(Date.parse(record.occurredAt));
    } else if (record.kind === "workspace_removed") {
      observe(() => {
        active.recordWorkspaceProgress = null;
      });
    } else if (record.kind === "workspace_observation_failed") {
      const error = Object.assign(new Error(record.message), record.code ? { code: record.code } : {});
      observe(() => {
        throw error;
      }, true);
    }
  });
}

function retireObservationFault(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  error: unknown,
  providerExited = false,
): void {
  active.observationError = error instanceof Error ? error : new Error(String(error));
  active.lossReason = `Runtime workspace observation failed (${runtimeErrorCode(error)}): ${active.observationError.message}`;
  context.input.recordLifecycle?.({
    event: "runtime_observation_failed",
    runtimeSessionId: active.runtimeSessionId,
    dispatchId: active.dispatchId,
    error: active.lossReason,
  });
  disposeActiveRuntimeObservations(active);
  if (providerExited) return;
  // Termination runs outside the writer queue.
  void Promise.resolve()
    .then(async () => {
      if (active.process.terminateTree) await active.process.terminateTree();
      else if (!active.process.cloud) active.process.terminate();
      context.input.schedule(async () => {
        if (active.exitSettlement || context.exiting.has(active.runtimeSessionId)) return;
        appendRuntimeWorkerRecord(context.input.rootDir, active.dispatchId, {
          kind: "process_lost",
          occurredAt: context.input.now(),
          reason: active.lossReason!,
        });
        await consumeDurableOutput(context, active);
        await context.publishExit(active, null);
      }, active.binding);
    })
    .catch((terminationError: unknown) => console.error("[runtime-observation] termination failed", terminationError));
}

export function attachActiveRuntime(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  resumeObservation?: ResumeProcessObservation,
): void {
  if (context.closed?.()) {
    context.processes.delete(active.runtimeSessionId);
    active.process.release?.();
    active.releaseAuthorization?.();
    return;
  }
  const runtimeSessionId = active.runtimeSessionId,
    exitState: {
      closed?: Promise<number | null>;
      recordProgress?: ActiveRuntime["recordWorkspaceProgress"];
    } = {},
    handlers = {
      output: (chunk: string, persisted = false) => {
        if (!active.exitSettlement && !context.closed?.())
          return context.input.schedule(async () => {
            if (!active.exitSettlement && !context.closed?.()) {
              active.stdoutObserved ||= chunk.length > 0;
              await context.consumeChunk(active, chunk, false, persisted);
              if (active.spendCapExceeded && !context.exiting.has(runtimeSessionId))
                await context.enforceSpendCap(active);
            }
          }, active.binding);
      },
      error: (chunk: string) => {
        if (!active.exitSettlement && !context.closed?.()) {
          return context.input.schedule(() => context.captureErrorOutput(active, chunk), active.binding);
        }
      },
      exit: (code: number | null, lossReason?: string, processObservation?: RuntimeProcessObservation) => {
        if (processObservation) {
          if (context.closed?.() || active.exitSettlement) return;
          context.input.schedule(async () => {
            if (context.closed?.() || active.exitSettlement) return;
            await context.publishRuntimeEvent(
              "runtime_session_liveness_changed",
              processObservation,
              `runtime-observation-${active.dispatchId}-${randomUUID()}`,
              active.binding,
            );
            const lifecycle = await readDispatchLifecycle(context, {
              by: "dispatch",
              dispatchIds: [active.dispatchId],
            });
            if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
            const attempt = lifecycle.rows.find(({ attempt }) => attempt.runtimeSessionId === runtimeSessionId);
            if (!attempt || attempt.policy.attemptSettled || attempt.attempt.process !== "unknown") return;
            if ((await isRuntimeProcessProvenStopped(context, active, attempt.attempt)) !== "proven_stopped") return;
            active.lossReason = lossReason ?? "runtime process group was lost";
            removeRuntimeCallbackRelay(active.dispatchId);
            await consumeDurableOutput(context, active);
            await context.publishExit(active, null);
          }, active.binding);
          return;
        }
        if (!active.exitSettlement && !context.closed?.()) {
          if (!exitState.closed) {
            exitState.recordProgress = active.recordWorkspaceProgress;
            exitState.closed = releaseActiveRuntimeObservations(active, true);
          }
          void exitState.closed.then(
            (finalProgressAt) => {
              context.input.schedule(async () => {
                if (active.exitSettlement || context.closed?.()) return;
                if (finalProgressAt !== null) await exitState.recordProgress?.(finalProgressAt);
                if (lossReason && !active.observationError) active.lossReason = lossReason;
                await context.consumeChunk(active, "", true);
                await context.publishExit(active, code);
              }, active.binding);
            },
            (error: unknown) => {
              context.input.schedule(async () => {
                if (active.exitSettlement || context.closed?.()) return;
                retireObservationFault(context, active, error, true);
                await context.consumeChunk(active, "", true);
                await context.publishExit(active, code);
              }, active.binding);
            },
          );
        }
      },
    };
  try {
    attachRuntimeObservations(context, active);
  } catch (error) {
    disposeActiveRuntimeObservations(active);
    throw error;
  }
  active.process.cloud?.onLiveness((live) =>
    context.input.schedule(async () => {
      if (active.exitSettlement || context.closed?.()) return;
      await context.publishRuntimeEvent(
        "runtime_session_liveness_changed",
        { runtimeSessionId, liveness: live ? "live" : "unknown" },
        `runtime-observation-${active.dispatchId}-${randomUUID()}`,
        active.binding,
      );
    }, active.binding),
  );
  if (resumeObservation) resumeObservation.activate(handlers);
  else {
    active.process.onOutput(handlers.output);
    active.process.onErrorOutput(handlers.error);
    active.process.onExit(handlers.exit);
  }
  active.process.onSteerOutcome?.((outcome) => {
    recordPendingSteerReceipt(
      context.input.rootDir,
      active.dispatchId,
      context.input.repoId,
      runtimeSessionId,
      outcome,
    );
    if (context.closed?.()) return;
    // F13: Never queue receipt uplink RPCs on the control workQueue; wake the dedicated
    // non-blocking receipt pump (or detached async flush when standalone).
    if (context.triggerSteerReceiptFlush) {
      context.triggerSteerReceiptFlush();
      return;
    }
    void flushPendingSteerReceipts(context, active.dispatchId, runtimeSessionId, active.binding).catch(
      (error: unknown) => console.error("[runtime-steer-receipts] background flush deferred:", error),
    );
  });
  if (active.stalledAt !== null) context.input.schedule(() => settleStalledRuntime(context, active), active.binding);
}

const permanentSteerReceiptRejectionCodes = new Set([
  "invalid_control_receipt",
  "control_receipt_conflict",
  "control_request_not_found",
  "execution_scope_mismatch",
  "execution_credential_rejected",
]);

/** Durably publish all unacknowledged steer control receipts for a dispatch, clearing each only after Center ACKs. */
export async function flushPendingSteerReceipts(
  context: RuntimeSpawnerContext,
  dispatchId: string,
  runtimeSessionId: string,
  binding: RuntimeBinding,
): Promise<void> {
  const pending = readPendingSteerReceipts(context.input.rootDir, dispatchId);
  for (const outcome of pending) {
    const receiptOpId = steerReceiptOpId(context.input.repoId, runtimeSessionId, outcome.requestOpId);
    try {
      await context.publishRuntimeEvent(
        "runtime_session_liveness_changed",
        {
          runtimeSessionId,
          liveness: "unknown",
          controlReceipt: {
            action: "steer",
            controlRequestId: outcome.controlRequestId,
            requestOpId: outcome.requestOpId,
            status: outcome.status,
            dispatchId,
            ...(outcome.steerVersion !== undefined ? { steerVersion: outcome.steerVersion } : {}),
            ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
            ...(outcome.message ? { message: outcome.message } : {}),
          },
        },
        receiptOpId,
        binding,
      );
      markSteerReceiptAcked(context.input.rootDir, dispatchId, context.input.repoId, runtimeSessionId, receiptOpId);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      if (code !== null && permanentSteerReceiptRejectionCodes.has(code)) {
        markSteerReceiptAcked(context.input.rootDir, dispatchId, context.input.repoId, runtimeSessionId, receiptOpId);
        console.error(`[runtime-steer-receipts] permanently rejected receipt ${receiptOpId} (${code}):`, error);
        continue;
      }
      throw error;
    }
  }
}

export async function flushAllPendingSteerReceipts(
  context: RuntimeSpawnerContext,
  activeBinding: (runtimeSessionId: string) => RuntimeBinding | undefined,
  defaultBinding?: RuntimeBinding,
): Promise<void> {
  const entries = readAllPendingSteerReceipts(context.input.rootDir);
  if (entries.length === 0) return;
  const dispatches = new Map<string, string>();
  for (const entry of entries) {
    if (!dispatches.has(entry.dispatchId)) dispatches.set(entry.dispatchId, entry.runtimeSessionId);
  }
  for (const [dispatchId, runtimeSessionId] of dispatches) {
    const binding =
      activeBinding(runtimeSessionId) ??
      readDispatchStreamHeader(context.input.rootDir, dispatchId)?.binding ??
      defaultBinding;
    if (!binding) continue;
    await flushPendingSteerReceipts(context, dispatchId, runtimeSessionId, binding);
  }
}
