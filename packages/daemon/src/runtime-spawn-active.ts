import type { ActiveRuntime, ResumeProcessObservation } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_STALL_TIMEOUT_MS, resolveHarnessLayout } from "@harness-anything/kernel";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";

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
  | "planObserved"
  | "planIncomplete"
  | "protocolError"
  | "cancelRequested"
  | "cancelBinding"
  | "cancelOpId"
  | "spendCapExceeded"
  | "lastProgressAtMs"
  | "workspaceActivityCount"
  | "stalledAt"
  | "recordProviderProgress"
  | "recordWorkspaceProgress"
  | "lossReason"
  | "lossSignal"
  | "lossExitCode"
  | "toolCallObserved"
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
  readonly providerSessionId?: string | null;
  readonly fallbackAttempt?: ActiveRuntime["fallbackAttempt"];
  readonly workspaceActivityCount?: number;
  readonly stalledAt?: string | null;
};

export function createActiveRuntime(base: ActiveRuntimeBase): ActiveRuntime {
  const stallTimeoutMs =
      Number.isSafeInteger(base.stallTimeoutMs) && base.stallTimeoutMs >= 10_000
        ? base.stallTimeoutMs
        : DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
    lastProgressAtMs = Number.isFinite(base.lastProgressAtMs) ? base.lastProgressAtMs : Date.now();
  return {
    ...base,
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
    planObserved: false,
    planIncomplete: false,
    protocolError: false,
    cancelRequested: false,
    cancelBinding: null,
    cancelOpId: null,
    spendCapExceeded: false,
    lastProgressAtMs,
    workspaceActivityCount: base.workspaceActivityCount ?? 0,
    stalledAt: base.stalledAt ?? null,
    recordProviderProgress: null,
    recordWorkspaceProgress: null,
    lossReason: null,
    lossSignal: null,
    lossExitCode: null,
    toolCallObserved: false,
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
  watcher: FSWatcher | null;
  disposed: boolean;
};

const observationHandles = new WeakMap<ActiveRuntime, RuntimeObservationHandles>();
const stallSettlementStarted = new WeakSet<ActiveRuntime>();

export function disposeActiveRuntimeObservations(active: ActiveRuntime): void {
  const handles = observationHandles.get(active);
  if (!handles) return;
  handles.disposed = true;
  if (handles.timer) clearTimeout(handles.timer);
  handles.watcher?.close();
  active.recordProviderProgress = null;
  active.recordWorkspaceProgress = null;
  observationHandles.delete(active);
}

export async function settleStalledRuntime(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  if (
    context.processes.get(active.runtimeSessionId) !== active ||
    context.exiting.has(active.runtimeSessionId) ||
    stallSettlementStarted.has(active)
  )
    return;
  stallSettlementStarted.add(active);
  const newlyStalled = active.stalledAt === null;
  active.stalledAt ??= context.input.now();
  active.lossReason = `Dispatch stalled after ${String(active.stallTimeoutMs)} ms without provider or workspace progress.`;
  if (newlyStalled) active.stream.appendStalled?.(active.stalledAt);
  // One termination path: the process tree when the launch can enumerate it, otherwise the
  // process group. A termination failure is a real fault and propagates to the scheduling
  // boundary instead of being replaced by a second kill attempt that hides it.
  if (active.process.terminateTree) await active.process.terminateTree();
  else active.process.terminate();
  await consumeDurableOutput(context, active);
  await context.publishExit(active, null);
}

function armStallDeadline(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  handles: RuntimeObservationHandles,
): void {
  if (handles.disposed || active.stalledAt !== null) return;
  if (handles.timer) clearTimeout(handles.timer);
  const remaining = Math.max(0, active.stallTimeoutMs - (Date.now() - active.lastProgressAtMs));
  handles.timer = setTimeout(() => {
    context.input.schedule(async () => {
      if (context.processes.get(active.runtimeSessionId) !== active || context.exiting.has(active.runtimeSessionId))
        return;
      const elapsed = Date.now() - active.lastProgressAtMs;
      if (elapsed < active.stallTimeoutMs) {
        armStallDeadline(context, active, handles);
        return;
      }
      await settleStalledRuntime(context, active);
    }, active.binding);
  }, remaining);
  handles.timer.unref();
}

function attachRuntimeObservations(context: RuntimeSpawnerContext, active: ActiveRuntime): void {
  const handles: RuntimeObservationHandles = { timer: null, watcher: null, disposed: false };
  const localRoot =
      typeof context.input.rootDir === "string" ? resolveHarnessLayout(context.input.rootDir).localRoot : null,
    localRootRelative = localRoot === null ? null : path.relative(active.cwd, localRoot),
    ignoredRoot =
      localRootRelative === null
        ? null
        : (localRootRelative === "." || localRootRelative === ""
            ? path.join("runtime", "dispatches")
            : localRootRelative
          ).replaceAll(path.sep, "/");
  observationHandles.set(active, handles);
  const progress = (workspaceChanged: boolean): void => {
    if (handles.disposed || context.processes.get(active.runtimeSessionId) !== active || active.stalledAt !== null)
      return;
    if (Date.now() - active.lastProgressAtMs >= active.stallTimeoutMs) {
      context.input.schedule(() => settleStalledRuntime(context, active), active.binding);
      return;
    }
    active.lastProgressAtMs = Date.now();
    if (workspaceChanged) {
      active.workspaceActivityCount += 1;
      active.stream.appendWorkspaceActivity?.(context.input.now());
    }
    armStallDeadline(context, active, handles);
  };
  active.recordProviderProgress = () => progress(false);
  active.recordWorkspaceProgress = () => progress(true);
  // Recursive watching is supported on every platform this repository runs on, so a workspace it
  // cannot watch is a real fault of this dispatch: it throws out of the attach instead of quietly
  // reducing the watchdog to provider events. A later watcher fault reaches the process as the
  // emitter's own error (the same policy as the edge read's watcher) — no layer here invents a
  // degraded liveness mode, and the ordinary exit/adoption settlement still owns the attempt.
  handles.watcher = watch(active.cwd, { recursive: true }, (_eventType, filename) => {
    const relative = typeof filename === "string" ? filename : String(filename ?? "");
    // The daemon's own stream/cache writes are observations about the dispatch, not worker
    // progress. Ignoring the local runtime root also prevents appendWorkspaceActivity from
    // feeding its own watcher and extending the deadline indefinitely.
    const normalized = relative?.replaceAll(path.sep, "/");
    if (
      !normalized ||
      (ignoredRoot !== null &&
        (normalized === ignoredRoot || (ignoredRoot !== "" && normalized.startsWith(`${ignoredRoot}/`))))
    )
      return;
    active.recordWorkspaceProgress?.();
  });
  handles.watcher.unref?.();
  if (active.stalledAt === null) armStallDeadline(context, active, handles);
}

export function attachActiveRuntime(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  resumeObservation?: ResumeProcessObservation,
): void {
  const runtimeSessionId = active.runtimeSessionId,
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
          disposeActiveRuntimeObservations(active);
          context.input.schedule(async () => {
            if (context.processes.get(runtimeSessionId) !== active) return;
            if (lossReason) active.lossReason = lossReason;
            await context.consumeChunk(active, "", true);
            await context.publishExit(active, code);
          }, active.binding);
        }
      },
    };
  // Observations first: the watchdog and its workspace watcher belong to this registration, so a
  // provider exit that arrives while the process handlers are being wired already finds a
  // disposable registration instead of one created after disposal. A workspace the watcher cannot
  // open is a real fault: it travels out of here, and the launcher's failed-launch path terminates
  // the process and retires the dispatch.
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
