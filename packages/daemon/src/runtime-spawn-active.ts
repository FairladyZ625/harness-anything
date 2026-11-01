import type { ActiveRuntime, ResumeProcessObservation } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { DispatchStallEvidence } from "./dispatch-stream.ts";
import { statSync, watch, type FSWatcher } from "node:fs";
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

function attachRuntimeObservations(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
): "watching" | "workspace-removed" {
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
    const observedAtMs = Date.now();
    active.lastProgressAtMs = observedAtMs;
    if (workspaceChanged) {
      active.workspaceActivityCount += 1;
      active.stream.appendWorkspaceActivity?.(context.input.now());
    }
    armStallDeadline(context, active, handles);
  };
  active.recordProviderProgress = () => progress(false);
  active.recordWorkspaceProgress = () => progress(true);
  // Workspaces can be reclaimed independently of the durable dispatch. Observe only a workspace
  // that still exists; its removal must not prevent the repository from restoring this runtime.
  const workspaceRemoved = (): boolean => {
      if (statSync(active.cwd, { throwIfNoEntry: false })) return false;
      handles.watcher?.close();
      handles.watcher = null;
      return true;
    },
    watchError = (error: NodeJS.ErrnoException): void => {
      // Windows reports deletion as EPERM; only an absent root makes it an ordinary removal.
      if ((error.code !== "ENOENT" && error.code !== "EPERM") || !workspaceRemoved()) throw error;
    };
  const workspaceChanged = (eventType: string, filename: string | Buffer | null): void => {
    if (eventType === "rename" && workspaceRemoved()) {
      active.recordWorkspaceProgress = null;
      return;
    }
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
  };
  if (active.stalledAt === null) armStallDeadline(context, active, handles);
  try {
    handles.watcher = watch(active.cwd, { recursive: true }, workspaceChanged);
    handles.watcher.on("error", (error: NodeJS.ErrnoException) => {
      watchError(error);
      active.recordWorkspaceProgress = null;
    });
    handles.watcher.unref?.();
  } catch (error) {
    // Check the directory after watch refuses it as well: deletion can race registration.
    // Other watcher errors, including ENOENT below a workspace that still exists, stay faults.
    watchError(error as NodeJS.ErrnoException);
    return "workspace-removed";
  }
  return "watching";
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
  // disposable registration instead of one created after disposal. A present workspace the watcher cannot
  // open is a real fault: it travels out of here, and the launcher's failed-launch path terminates
  // the process and retires the dispatch.
  try {
    if (attachRuntimeObservations(context, active) === "workspace-removed") active.recordWorkspaceProgress = null;
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
