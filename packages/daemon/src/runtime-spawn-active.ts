import type { ActiveRuntime, ResumeProcessObservation } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { appendRuntimeWorkerRecord, type DispatchStallEvidence } from "./dispatch-stream.ts";
import { DEFAULT_RUNTIME_STALL_TIMEOUT_MS } from "@harness-anything/kernel";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { noteProviderProgress } from "./runtime-provider-connectivity.ts";
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import { openRuntimeWorkspaceMonitor } from "./runtime-workspace-monitor-thread.ts";
import { createWorkspaceActivityQueue } from "./runtime-workspace-activity-queue.ts";
import { publishActiveDispatchLifecycle } from "./runtime-dispatch-lifecycle.ts";

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
  | "lifecycleAttemptGroupId"
  | "lifecycleVersion"
> & {
  readonly lastProgressAtMs: number;
  readonly lastRealProgressAtMs?: number;
  /** Canonical report restored on adoption so the next real progress can clear it. */
  readonly providerUnreachable?: ActiveRuntime["providerUnreachable"];
  readonly providerSessionId?: string | null;
  readonly fallbackAttempt?: ActiveRuntime["fallbackAttempt"];
  readonly workspaceActivityCount?: number;
  readonly stalledAt?: string | null;
  readonly lifecycleAttemptGroupId?: ActiveRuntime["lifecycleAttemptGroupId"];
  readonly lifecycleVersion?: ActiveRuntime["lifecycleVersion"];
};

export function createActiveRuntime(base: ActiveRuntimeBase): ActiveRuntime {
  const stallTimeoutMs =
      Number.isSafeInteger(base.stallTimeoutMs) && base.stallTimeoutMs >= 10_000
        ? base.stallTimeoutMs
        : DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
    lastProgressAtMs = Number.isFinite(base.lastProgressAtMs) ? base.lastProgressAtMs : Date.now(),
    lastRealProgressAtMs = Number.isFinite(base.lastRealProgressAtMs)
      ? (base.lastRealProgressAtMs as number)
      : lastProgressAtMs;
  return {
    ...base,
    releaseAuthorization: base.binding.retainAuthorization?.(),
    stallTimeoutMs,
    fallbackAttempt: base.fallbackAttempt ?? null,
    lifecycleAttemptGroupId: base.lifecycleAttemptGroupId ?? null,
    lifecycleVersion: base.lifecycleVersion ?? null,
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

export function disposeActiveRuntimeObservations(active: ActiveRuntime): void {
  void releaseActiveRuntimeObservations(active, false).catch((error: unknown) =>
    console.error("[runtime-observation] watcher termination failed", error),
  );
}

export async function settleStalledRuntime(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  if (
    context.processes.get(active.runtimeSessionId) !== active ||
    context.exiting.has(active.runtimeSessionId) ||
    stallSettlementStarted.has(active)
  )
    return;
  stallSettlementStarted.add(active);
  const newlyStalled = active.stalledAt === null,
    stalledAt = active.stalledAt ?? context.input.now();
  // Freeze the judgment before the probe: a provider frame that lands while `ps` runs is later
  // than the deadline this settlement already decided, so it must not move the progress clock
  // the evidence quotes.
  active.stalledAt ??= stalledAt;
  // The evidence names what the judgment saw before anything is terminated: the deadline's
  // inputs and the process subtree that a real long tool would still be running in.
  const liveProcessPids = newlyStalled ? await liveDescendantPids(active) : null;
  active.lossReason = `Dispatch stalled after ${String(active.stallTimeoutMs)} ms without provider or workspace progress.`;
  if (newlyStalled) active.stream.appendStalled?.(stalledAt, stallEvidence(active, stalledAt, liveProcessPids));
  // One termination path: the process tree when the launch can enumerate it, otherwise the
  // process group. A termination failure is a real fault and propagates to the scheduling
  // boundary instead of being replaced by a second kill attempt that hides it.
  if (active.process.terminateTree) await active.process.terminateTree();
  else active.process.terminate();
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
      if (context.processes.get(active.runtimeSessionId) !== active || context.exiting.has(active.runtimeSessionId))
        return;
      if (Date.now() < deadline) {
        armStallDeadline(context, active, handles);
        return;
      }
      // Provider frames are an incomplete view of work: a command may produce no frame until it
      // exits, or the provider may not announce it in a structured form. The OS process tree is
      // the single liveness source; an active descendant keeps this dispatch under observation.
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
  // Worker messages are already coalesced. Enter the single writer only once per observation.
  const observe = (work: () => void | Promise<void>, workspace = false): void => {
    context.input.schedule(() => {
      if (
        (handles.disposed && !(workspace && handles.flushOnExit)) ||
        context.processes.get(active.runtimeSessionId) !== active
      )
        return;
      try {
        return work();
      } catch (error) {
        retireObservationFault(context, active, error, handles.flushOnExit);
        throw error;
      }
    }, active.binding);
  };
  const progress = (workspaceChanged: boolean, observationAtMs?: number): void | Promise<void> => {
    if (
      (handles.disposed && !handles.flushOnExit) ||
      context.processes.get(active.runtimeSessionId) !== active ||
      active.stalledAt !== null
    )
      return;
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
  // Termination may wait on another process. It must not hold the ledger writer; only
  // the prepared loss record and normal terminal settlement return to its existing queue.
  void Promise.resolve()
    .then(async () => {
      if (active.process.terminateTree) await active.process.terminateTree();
      else active.process.terminate();
      context.input.schedule(async () => {
        if (context.processes.get(active.runtimeSessionId) !== active || context.exiting.has(active.runtimeSessionId))
          return;
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
  const runtimeSessionId = active.runtimeSessionId,
    exitState: {
      closed?: Promise<number | null>;
      recordProgress?: ActiveRuntime["recordWorkspaceProgress"];
    } = {},
    handlers = {
      output: (chunk: string, persisted = false) => {
        if (context.processes.get(runtimeSessionId) === active)
          context.input.schedule(async () => {
            if (context.processes.get(runtimeSessionId) === active) {
              active.stdoutObserved ||= chunk.length > 0;
              await context.consumeChunk(active, chunk, false, persisted);
              if (active.spendCapExceeded && !context.exiting.has(runtimeSessionId))
                await context.enforceSpendCap(active);
            }
          }, active.binding);
      },
      error: (chunk: string) => {
        if (context.processes.get(runtimeSessionId) === active) {
          context.input.schedule(() => context.captureErrorOutput(active, chunk), active.binding);
        }
      },
      exit: (code: number | null, lossReason?: string) => {
        if (context.processes.get(runtimeSessionId) === active) {
          if (!exitState.closed) {
            exitState.recordProgress = active.recordWorkspaceProgress;
            exitState.closed = releaseActiveRuntimeObservations(active, true);
          }
          void exitState.closed.then(
            (finalProgressAt) => {
              context.input.schedule(async () => {
                if (context.processes.get(runtimeSessionId) !== active) return;
                if (finalProgressAt !== null) await exitState.recordProgress?.(finalProgressAt);
                if (lossReason && !active.observationError) active.lossReason = lossReason;
                await context.consumeChunk(active, "", true);
                await publishActiveDispatchLifecycle(context, active, {
                  type: lossReason ? "process_lost" : "process_exit",
                });
                await context.publishExit(active, code);
              }, active.binding);
            },
            (error: unknown) => {
              context.input.schedule(async () => {
                if (context.processes.get(runtimeSessionId) !== active) return;
                retireObservationFault(context, active, error, true);
                await context.consumeChunk(active, "", true);
                await publishActiveDispatchLifecycle(context, active, { type: "process_lost" });
                await context.publishExit(active, code);
              }, active.binding);
            },
          );
        }
      },
    };
  // Register observations before process handlers so an immediate exit can dispose them.
  try {
    attachRuntimeObservations(context, active);
  } catch (error) {
    disposeActiveRuntimeObservations(active);
    throw error;
  }
  if (resumeObservation) resumeObservation.activate(handlers);
  else {
    active.process.onOutput(handlers.output);
    active.process.onErrorOutput(handlers.error);
    active.process.onExit(handlers.exit);
  }
  if (active.stalledAt !== null) context.input.schedule(() => settleStalledRuntime(context, active), active.binding);
}
