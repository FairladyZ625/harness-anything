import { randomUUID } from "node:crypto";
import { DEFAULT_RUNTIME_STALL_TIMEOUT_MS } from "@harness-anything/kernel";
import type { ActiveRuntime, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import {
  appendRuntimeWorkerRecord,
  readDispatchStream,
  readDispatchStreamHeader,
  readDispatchStreamSummary,
  reopenDispatchStream,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptNativeProcess } from "./runtime-spawn-process.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import {
  consumeDurableOutput,
  durableOutputRecordCount,
  restoreDurableOutputRecords,
} from "./runtime-spawn-provider-stream.ts";
import { runtimeBindingForDispatch, type RuntimeBinding, type RuntimeSpawnerInput } from "./runtime-spawn-types.ts";
import type { RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { isRuntimeKindId } from "./runtime-inventory.ts";

export interface RuntimeRecoveryResult {
  readonly runtimeSessionId: string;
  readonly dispatchId: string | null;
  readonly outcome: "ready" | "failed" | "foreign";
  readonly error?: unknown;
}

const recoveries = new WeakMap<
  RuntimeSpawnerContext,
  Map<
    string,
    {
      readonly promise: Promise<RuntimeRecoveryResult>;
      result?: RuntimeRecoveryResult;
    }
  >
>();

export async function adoptRuntimes(
  context: RuntimeSpawnerContext,
  onProgress?: (completed: number) => void,
  options?: { readonly runtimeSessionId?: string },
): Promise<readonly RuntimeRecoveryResult[]> {
  const sessions = context.input.remote
    ? await context.input.remote.readRuntimeSessions()
    : context.requiredRuntimeProjection(context.input).readRuntimeSessions();
  let pending = recoveries.get(context);
  if (!pending) recoveries.set(context, (pending = new Map()));
  let completed = 0;
  // Point reads, including archived streams, belong to each recovery. A stalled
  // remote header lookup must not delay a sibling's restoration.
  const attempts = sessions
    .filter(
      (session) =>
        session.outcome === null &&
        (!options?.runtimeSessionId || session.runtimeSessionId === options.runtimeSessionId),
    )
    .map((session) => {
      const runtimeSessionId = session.runtimeSessionId;
      const existing = pending.get(runtimeSessionId);
      if (existing && !existing.result) return existing.promise;
      const alreadyOwned =
        context.processes.has(runtimeSessionId) ||
        context.exiting.has(runtimeSessionId) ||
        context.ownsModelSlot?.(runtimeSessionId) === true;
      let dispatchId: string | null = null;
      const entry: { promise: Promise<RuntimeRecoveryResult>; result?: RuntimeRecoveryResult } = {
        promise: Promise.resolve()
          .then(async () => {
            const dispatch = context.input.remote
              ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
              : context.requiredRuntimeProjection(context.input).readRuntimeDispatch(runtimeSessionId);
            dispatchId = dispatch?.payload.dispatchId ?? null;
            if (dispatch && !ownedByRuntimeSpawner(dispatch, context.input.runtimeNode)) return "foreign" as const;
            const header = dispatchId ? readDispatchStreamHeader(context.input.rootDir, dispatchId) : null;
            if (!header)
              throw context.runtimeSpawnError(
                "runtime_recovery_missing_dispatch",
                `Runtime ${runtimeSessionId} has no readable dispatch.`,
              );
            await restoreRuntime(context, header, session);
            return "ready" as const;
          })
          .then(
            (outcome) => ({
              runtimeSessionId,
              dispatchId,
              outcome,
            }),
            (error: unknown) => {
              context.input.recordLifecycle?.({
                event: "runtime_recovery_failed",
                runtimeSessionId,
                ...(dispatchId ? { dispatchId } : {}),
                error: error instanceof Error ? error.message : String(error),
              });
              console.error(`[runtime-recovery] ${runtimeSessionId}`, error);
              return {
                runtimeSessionId,
                dispatchId,
                outcome: "failed" as const,
                error,
              };
            },
          )
          .then((result) => {
            entry.result = result;
            if (result.outcome === "ready" && !alreadyOwned) onProgress?.(++completed);
            return result;
          }),
      };
      pending.set(runtimeSessionId, entry);
      return entry.promise;
    });
  return Promise.all(attempts);
}

/** Admission never waits while holding the writer: an unresolved owner cannot look idle. */
export function assertRuntimeRecoveryReady(context: RuntimeSpawnerContext, runtimeSessionId: string): boolean {
  const recovery = recoveries.get(context)?.get(runtimeSessionId);
  if (recovery?.result?.outcome === "foreign") return false;
  if (recovery?.result?.outcome === "failed") throw recovery.result.error;
  if (recovery && !recovery.result)
    throw context.runtimeSpawnError("runtime_recovery_pending", `Runtime ${runtimeSessionId} is still recovering.`);
  return true;
}

async function restoreRuntime(
  context: RuntimeSpawnerContext,
  header: DispatchStreamHeader,
  session: RuntimeSessionSelection | undefined,
): Promise<void> {
  if (context.closed?.()) return;
  // Canonical publication precedes process registration. Recovery must not reclaim a
  // launch still owned by this spawner's existing slot reservation as a dead predecessor.
  if (context.ownsModelSlot?.(header.runtimeSessionId)) return;
  if (context.processes.has(header.runtimeSessionId) || context.exiting.has(header.runtimeSessionId)) return;
  const metadata = adoptableMetadata(header);
  if (!metadata || !ownedByRuntimeSpawner(metadata.binding, context.input.runtimeNode)) return;
  const fallbackSummary = header.fallbackAttempt
    ? readDispatchStreamSummary(context.input.rootDir, header.dispatchId)
    : null;
  if (fallbackSummary) context.reconcileFallback(fallbackSummary);

  if (session && session.outcome !== null) {
    removeRuntimeCallbackRelay(header.dispatchId);
    return;
  }
  const fullStream = readDispatchStream(context.input.rootDir, header.dispatchId),
    streamSummary = readDispatchStreamSummary(context.input.rootDir, header.dispatchId),
    stream = fullStream ?? streamSummary;
  if (!stream) return;
  const processState = stream.process,
    processPid = processState?.pid ?? 0;
  // A terminal outcome is appended before publication. If a second node opens while the
  // center projection is still catching up, the local stream is the authoritative owner
  // record and must not publish the same terminal transition a second time.
  if (stream.terminalOutcome && processState?.exited && session?.outcome !== null && session?.outcome !== undefined) {
    removeRuntimeCallbackRelay(header.dispatchId);
    return;
  }
  const runtimeProcess = adoptNativeProcess(
    context.input.rootDir,
    stream.header.dispatchId,
    processPid,
    durableOutputRecordCount(fullStream?.records ?? []),
  );
  if (!fullStream) runtimeProcess.release?.();
  const active = createActiveRuntime({
    process: runtimeProcess,
    dispatchId: stream.header.dispatchId,
    runtimeSessionId: stream.header.runtimeSessionId,
    dispatchOpId: metadata.dispatchOpId,
    instanceId: stream.header.instanceId,
    kindId: metadata.kindId,
    resolvedProviderDirectory: stream.header.resolvedProviderDirectory ?? null,
    permissionMode: metadata.permissionMode,
    agent: stream.header.agentId
      ? { id: stream.header.agentId, name: stream.header.agentName ?? stream.header.agentId }
      : null,
    role: stream.header.role ?? null,
    delegatedBy: stream.header.delegatedByAgentId
      ? {
          id: stream.header.delegatedByAgentId,
          name: stream.header.delegatedByAgentName ?? stream.header.delegatedByAgentId,
        }
      : null,
    squadId: stream.header.squadId ?? null,
    publicationOwner: stream.header.publicationOwner ?? "runtime",
    parentRuntimeSessionId: stream.header.parentRuntimeSessionId ?? null,
    binding: metadata.binding,
    task:
      stream.header.taskId && stream.header.executionId
        ? {
            taskId: stream.header.taskId,
            executionId: stream.header.executionId,
            leaseVersion: stream.header.leaseVersion ?? null,
          }
        : null,
    decisionReviewTarget:
      stream.header.reviewTarget?.kind === "decision"
        ? {
            decisionId: stream.header.reviewTarget.decisionId,
            digest: stream.header.reviewTarget.digest,
          }
        : null,
    schedule: stream.header.schedule ?? null,
    cwd: metadata.cwd,
    prompt: metadata.prompt,
    ...(stream.header.promptSource ? { promptSource: stream.header.promptSource } : {}),
    onExitCommand: stream.header.onExitCommand ?? null,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    fast: metadata.fast,
    tokenLimit: stream.header.tokenLimit ?? null,
    stallTimeoutMs: stream.header.stallTimeoutMs ?? DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
    lastProgressAtMs: Date.parse(streamSummary?.lastProgressAt ?? stream.header.startedAt),
    workspaceActivityCount: streamSummary?.workspaceActivityCount ?? 0,
    stalledAt: streamSummary?.stalledAt ?? null,
    startedAt: stream.header.startedAt,
    stream: reopenDispatchStream(context.input.rootDir, stream.header),
    fallbackAttempt: stream.header.fallbackAttempt ?? null,
    resumeProviderSessionId: stream.header.resumeProviderSessionId ?? null,
    providerSessionId: stream.providerSessionId,
  });
  context.processes.set(active.runtimeSessionId, active);
  const processAlive = !!processState && !processState.exited && runtimePidIsAlive(processState.pid);
  const [publication] = await Promise.allSettled([
    (async () => {
      context.input.recordLifecycle?.({
        event: "runtime_spawn",
        runtimeSessionId: active.runtimeSessionId,
        dispatchId: active.dispatchId,
        // A session adopted without a recorded process has no pid to report; the drain count follows
        // live pids, so reporting a placeholder would keep counting a runtime that does not exist.
        ...(processState ? { pid: processState.pid } : {}),
      });
      await restoreDurableOutputRecords(context, active, fullStream?.records ?? []);
      if (context.closed?.()) return;
      if (processAlive && fullStream) {
        const attachmentFailure = attachAdoptedObservations(context, active);
        if (attachmentFailure !== null) {
          throw attachmentFailure;
        }
      }

      // Replaying the durable stream recomputes consumption from the launch cut. A runtime
      // already past its frozen limit must be stopped before liveness is republished, or a
      // daemon restart would hand a capped dispatch a fresh lease on spending.
      if (processAlive && active.spendCapExceeded) {
        await context.enforceSpendCap(active);
        return;
      }
      if (processAlive && session?.liveness !== "live" && session?.liveness !== "exited") {
        await context.publishRuntimeEvent(
          "runtime_session_liveness_changed",
          { runtimeSessionId: active.runtimeSessionId, liveness: "live", processGroupPid: processState.pid },
          randomUUID(),
          active.binding,
        );
      }
      if (!processAlive) {
        const reason = processState
          ? `runtime process ${String(processState.pid)} is no longer alive after daemon restart`
          : "runtime process was never recorded before daemon restart";
        active.lossReason = processState?.exited ? null : reason;
        active.lossExitCode = processState?.exitCode ?? null;
        active.lossSignal = processState?.signal ?? null;
        removeRuntimeCallbackRelay(active.dispatchId);
        if (!processState?.exited)
          appendRuntimeWorkerRecord(context.input.rootDir, active.dispatchId, {
            kind: "process_lost",
            occurredAt: context.input.now(),
            reason,
            exitCode: active.lossExitCode,
            signal: active.lossSignal,
          });
        await consumeDurableOutput(context, active);
        await context.publishExit(active, active.lossExitCode, session?.liveness === "exited");
      }
    })(),
  ]);
  if (publication.status === "rejected") {
    if (!processAlive) {
      if (context.processes.get(active.runtimeSessionId) === active) context.processes.delete(active.runtimeSessionId);
      active.process.release?.();
    }
    throw publication.reason;
  }
}

/**
 * An adopted worker whose liveness surface cannot be established is retired rather than adopted
 * unwatched. The loop owns one session at a time, so the refusal is returned and the remaining
 * streams still adopt; the recorded lost-process fact lets the next adoption pass settle the
 * attempt through the ordinary lost-process path instead of leaving a live worker nobody watches.
 */
function attachAdoptedObservations(context: RuntimeSpawnerContext, active: ActiveRuntime): unknown | null {
  try {
    attachActiveRuntime(context, active);
    return null;
  } catch (error) {
    appendRuntimeWorkerRecord(context.input.rootDir, active.dispatchId, {
      kind: "process_lost",
      occurredAt: context.input.now(),
      reason: `runtime observations could not be attached: ${error instanceof Error ? error.message : String(error)}`,
    });
    context.processes.delete(active.runtimeSessionId);
    active.process.terminate();
    active.process.release?.();
    return error;
  }
}

/** Startup-only retry for this repository's explicitly terminal sessions, independent of
 *  archived dispatch streams. Other repositories share the node's instance store, so an
 *  unknown session must be retained. Locally adopted/settling sessions are still in use. */
export async function sweepSettledRuntimeTempDirectories(context: RuntimeSpawnerContext): Promise<void> {
  if (!context.input.reclaimSettledRuntimeTempDirectories) return;
  const [sessionRead] = await Promise.allSettled([
    Promise.resolve().then(() =>
      context.input.remote
        ? context.input.remote.readRuntimeSessions()
        : context.requiredRuntimeProjection(context.input).readRuntimeSessions(),
    ),
  ]);
  // Without an authoritative session read, settled-ness cannot be verified; leave every
  // directory for the next start instead of guessing.
  if (sessionRead.status !== "fulfilled") return;
  const settledRuntimeSessionIds = sessionRead.value
    .filter(
      (session) =>
        session.outcome !== null &&
        !context.processes.has(session.runtimeSessionId) &&
        !context.exiting.has(session.runtimeSessionId),
    )
    .map((session) => session.runtimeSessionId);
  const reclaimFailures = context.input.reclaimSettledRuntimeTempDirectories(settledRuntimeSessionIds);
  for (const failure of reclaimFailures)
    logRuntimeTempReclaimFailure(failure.instanceId, failure.runtimeSessionId, "by the startup sweep", failure.error);
}

/** A failed launch reclaims immediately. If that fails before registration, no repository
 *  can prove ownership on a later sweep; the directory stays and the refusal is logged. */
export function reclaimFailedLaunchTempDirectory(
  input: Pick<RuntimeSpawnerInput, "reclaimRuntimeTempDirectory">,
  instanceId: string,
  runtimeSessionId: string,
): void {
  const failure = input.reclaimRuntimeTempDirectory?.(instanceId, runtimeSessionId);
  if (failure) logRuntimeTempReclaimFailure(instanceId, runtimeSessionId, "after a failed launch", failure);
}

function logRuntimeTempReclaimFailure(instanceId: string, runtimeSessionId: string, stage: string, error: Error): void {
  console.error(`[runtime-temp] ${instanceId}/${runtimeSessionId} could not be reclaimed ${stage}: ${error.message}`);
}

export function ownedByRuntimeSpawner(
  binding: Pick<RuntimeBinding, "source">,
  runtimeNode: RuntimeSpawnerInput["runtimeNode"],
): boolean {
  if (runtimeNode === undefined) return binding.source === "local";
  const source: unknown = binding.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
  const node = source as Record<string, unknown>;
  return node.kind === "node" && node.nodeId === runtimeNode.nodeId;
}

function adoptableMetadata(header: DispatchStreamHeader): {
  readonly dispatchOpId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly permissionMode: RuntimePermissionMode | null;
  readonly binding: RuntimeBinding;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
} | null {
  if (
    typeof header.dispatchOpId !== "string" ||
    !isRuntimeKindId(header.kindId) ||
    (header.permissionMode !== null &&
      !["bypass", "workspace-write", "read-only"].includes(String(header.permissionMode))) ||
    !isBinding(header.binding) ||
    typeof header.cwd !== "string" ||
    typeof header.prompt !== "string" ||
    typeof header.model !== "string" ||
    (header.fast !== undefined && typeof header.fast !== "boolean") ||
    (header.reasoningEffort !== null && typeof header.reasoningEffort !== "string")
  )
    return null;
  return {
    dispatchOpId: header.dispatchOpId,
    kindId: header.kindId,
    permissionMode: header.permissionMode as RuntimePermissionMode | null,
    binding: runtimeBindingForDispatch(header.binding),
    cwd: header.cwd,
    prompt: header.prompt,
    model: header.model,
    reasoningEffort: header.reasoningEffort,
    fast: header.fast ?? false,
  };
}
function isBinding(value: unknown): value is RuntimeBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const actor = binding.actor;
  return (
    actor !== null &&
    typeof actor === "object" &&
    !Array.isArray(actor) &&
    typeof (actor as { principal?: { personId?: unknown } }).principal?.personId === "string" &&
    binding.source !== undefined
  );
}

/** Instance load is an owner-process observation, never the last canonical live report. */
export function locallyObservedRuntimeSessions(
  sessions: readonly RuntimeSessionSelection[],
  processes: ReadonlyMap<string, Pick<ActiveRuntime, "process">>,
): readonly RuntimeSessionSelection[] {
  return sessions.map((session) => {
    const process = processes.get(session.runtimeSessionId)?.process;
    return {
      ...session,
      liveness:
        session.outcome !== null ? session.liveness : process && runtimePidIsAlive(process.pid) ? "live" : "unknown",
    };
  });
}
