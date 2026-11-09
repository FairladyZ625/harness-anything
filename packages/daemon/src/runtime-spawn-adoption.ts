import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
  dispatchOwnerForNode,
  sameWriteSource,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
} from "@harness-anything/kernel";
import type { ActiveRuntime, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
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
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import { dispatchLifecyclePendingError, readActiveDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { sweepOrphanedProcessGroup } from "./runtime/process-group-reconciler.ts";

export interface RuntimeRecoveryResult {
  readonly runtimeSessionId: string;
  readonly dispatchId: string | null;
  readonly outcome: "ready" | "settled" | "failed" | "foreign";
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
  options?: { readonly runtimeSessionId?: string; readonly authorizationBinding?: RuntimeBinding },
): Promise<readonly RuntimeRecoveryResult[]> {
  const owner = dispatchOwnerForNode(context.input.runtimeNode?.nodeId),
    candidates = new Map<string, DispatchLifecycleView>();
  for (const view of await readActiveDispatchLifecycle(
    (query) => readDispatch(context, query),
    context.runtimeSpawnError,
  ))
    if (view.attempt.fence.verified && view.attempt.fence.owner === owner)
      candidates.set(view.attempt.runtimeSessionId, view);
  let pending = recoveries.get(context);
  if (!pending) recoveries.set(context, (pending = new Map()));
  let completed = 0;
  // Point reads, including archived streams, belong to each recovery. A stalled
  // remote header lookup must not delay a sibling's restoration.
  const attempts = [...candidates]
    .filter(([id]) => !options?.runtimeSessionId || id === options.runtimeSessionId)
    .map(([runtimeSessionId, initial]) => {
      const existing = pending.get(runtimeSessionId);
      if (existing) return existing.promise;
      let restored = false;
      const dispatchId = initial.attempt.dispatchId;
      const entry: { promise: Promise<RuntimeRecoveryResult>; result?: RuntimeRecoveryResult } = {
        promise: Promise.resolve()
          .then(async () => {
            // The launch may not have written its stream header yet either.
            if (context.ownsModelSlot?.(runtimeSessionId)) return "ready" as const;
            const lifecycle = await readDispatch(context, { by: "dispatch", dispatchIds: [dispatchId!] });
            if (lifecycle.status === "pending")
              throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
            const view = lifecycle.rows.find(({ attempt }) => attempt.dispatchId === dispatchId);
            if (!view || view.policy.attemptSettled) return "settled" as const;
            if (!view.attempt.fence.verified || view.attempt.fence.owner !== owner) return "foreign" as const;
            const session = context.input.remote
              ? await context.input.remote.readRuntimeSession(runtimeSessionId)
              : context.requiredRuntimeProjection(context.input).readRuntimeSession(runtimeSessionId);
            if (!session) return "foreign" as const;
            const header = readDispatchStreamHeader(context.input.rootDir, dispatchId!);
            if (!header) {
              if (view.attempt.stopProof === "proven_stopped") {
                const dispatch = context.input.remote
                  ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
                  : context.requiredRuntimeProjection(context.input).readRuntimeDispatch(runtimeSessionId);
                if (dispatch?.actor) {
                  await settleMissingDispatchStream(context, session, dispatchId!, {
                    actor: dispatch.actor,
                    source: dispatch.source,
                  });
                  return "settled" as const;
                }
              }
              throw context.runtimeSpawnError(
                "runtime_recovery_missing_dispatch",
                `Runtime ${runtimeSessionId} has no readable dispatch.`,
              );
            }
            const settled = await restoreRuntime(context, header, session, view, options?.authorizationBinding);
            restored = !settled;
            return settled ? ("settled" as const) : ("ready" as const);
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
                code: runtimeErrorCode(error) ?? "runtime_recovery_failed",
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
            if (result.outcome === "ready" && restored) onProgress?.(++completed);
            return result;
          }),
      };
      pending.set(runtimeSessionId, entry);
      return entry.promise;
    });
  return Promise.all(attempts);
}

async function readDispatch(
  context: RuntimeSpawnerContext,
  query: import("@harness-anything/kernel").DispatchLifecycleQuery,
): Promise<DispatchLifecycleRead> {
  return context.input.remote
    ? context.input.remote.readDispatchLifecycle(query)
    : context.requiredRuntimeProjection(context.input).readDispatchLifecycle(query);
}

/** Admission never waits while holding the writer: an unresolved owner cannot look idle. */
export async function assertRuntimeRecoveryReady(
  context: RuntimeSpawnerContext,
  runtimeSessionId: string,
  dispatchId?: string | null,
): Promise<boolean> {
  const recovery = recoveries.get(context)?.get(runtimeSessionId);
  if (dispatchId === null || recovery?.result?.outcome === "foreign" || recovery?.result?.outcome === "settled")
    return false;
  if (recovery?.result?.outcome === "failed") {
    const lifecycle = await readDispatch(context, { by: "session", runtimeSessionId });
    if (lifecycle.status === "pending") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
    if (lifecycle.rows.some(({ policy }) => policy.attemptSettled)) return false;
    throw recovery.result.error;
  }
  if (recovery && !recovery.result)
    throw context.runtimeSpawnError("runtime_recovery_pending", `Runtime ${runtimeSessionId} is still recovering.`);
  return true;
}

async function settleMissingDispatchStream(
  context: RuntimeSpawnerContext,
  session: RuntimeSessionSelection,
  dispatchId: string,
  binding: RuntimeBinding,
): Promise<void> {
  const resultBody = "Runtime session lost: runtime process was no longer alive after daemon restart.",
    resultSha256 = createHash("sha256").update(resultBody).digest("hex"),
    opId = `runtime-recovery-${dispatchId}`;
  await context.publishRuntimeEvent(
    "runtime_session_exited",
    { runtimeSessionId: session.runtimeSessionId },
    `${opId}-exited`,
    binding,
  );
  await context.publishRuntimeEvent(
    "runtime_session_outcome_observed",
    {
      runtimeSessionId: session.runtimeSessionId,
      outcome: "unknown",
      exitCode: null,
      resultRef: `artifact:runtime-result/sha256/${resultSha256}`,
      result: { sha256: resultSha256, size: Buffer.byteLength(resultBody), mediaType: context.resultMediaType },
      dispatchId,
      endedAt: context.input.now(),
    },
    `${opId}-outcome`,
    binding,
    resultBody,
  );
}

async function restoreRuntime(
  context: RuntimeSpawnerContext,
  header: DispatchStreamHeader,
  session: RuntimeSessionSelection | undefined,
  lifecycle: DispatchLifecycleView,
  authorizationBinding?: RuntimeBinding,
): Promise<boolean> {
  if (context.closed?.()) return false;
  // Canonical publication precedes process registration. Recovery must not reclaim a
  // launch still owned by this spawner's existing slot reservation as a dead predecessor.
  if (context.ownsModelSlot?.(header.runtimeSessionId)) return false;
  const metadata = adoptableMetadata(header);
  if (!metadata) return false;
  if (
    authorizationBinding &&
    authorizationBinding.actor.principal.personId !== metadata.binding.actor.principal.personId
  )
    throw context.runtimeSpawnError(
      "execution_scope_mismatch",
      "Only the original runtime owner can authorize recovery.",
    );
  if (lifecycle.policy.attemptSettled) {
    const stream = readDispatchStreamSummary(context.input.rootDir, header.dispatchId);
    if (stream && lifecycle.policy.groupSettled && !lifecycle.policy.successorAdmissible)
      archiveDispatchStream(context.input.rootDir, header.dispatchId);
    removeRuntimeCallbackRelay(header.dispatchId);
    return true;
  }
  const fullStream = readDispatchStream(context.input.rootDir, header.dispatchId),
    streamSummary = readDispatchStreamSummary(context.input.rootDir, header.dispatchId),
    stream = fullStream ?? streamSummary;
  if (!stream) return false;
  const processState = stream.process,
    processPid = processState?.pid ?? 0;
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
    // Explicit owner cancellation supplies fresh credentials, while the original actor/source
    // remain the settlement fence. Startup recovery never borrows a local operator session.
    binding: authorizationBinding
      ? { ...authorizationBinding, ...metadata.binding, authorizationDecision: undefined }
      : metadata.binding,
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
    lastRealProgressAtMs: Date.parse(streamSummary?.lastProgressAt ?? stream.header.startedAt),
    providerUnreachable: session?.providerUnreachable ?? null,
    workspaceActivityCount: streamSummary?.workspaceActivityCount ?? 0,
    stalledAt: streamSummary?.stalledAt ?? null,
    startedAt: stream.header.startedAt,
    stream: reopenDispatchStream(context.input.rootDir, stream.header),
    fallbackAttempt: stream.header.fallbackAttempt ?? null,
    resumeProviderSessionId: stream.header.resumeProviderSessionId ?? null,
    providerSessionId: stream.providerSessionId,
  });
  context.processes.set(active.runtimeSessionId, active);
  const processObservation = {
    type: "runtime_session_liveness_changed" as const,
    payload: {
      runtimeSessionId: active.runtimeSessionId,
      liveness:
        processState && !processState.exited && runtimePidIsAlive(processState.pid)
          ? ("live" as const)
          : ("unknown" as const),
    },
  };
  context.input.recordLifecycle?.({
    event: "runtime_spawn",
    runtimeSessionId: active.runtimeSessionId,
    dispatchId: active.dispatchId,
    ...(processState ? { pid: processState.pid } : {}),
  });
  await restoreDurableOutputRecords(context, active, fullStream?.records ?? []);
  if (context.closed?.()) return false;
  await context.publishRuntimeEvent(
    processObservation.type,
    {
      ...processObservation.payload,
      ...(processState && processState.pid > 1 ? { processGroupPid: processState.pid } : {}),
    },
    randomUUID(),
    active.binding,
  );
  const observedLifecycle = await readDispatch(context, { by: "dispatch", dispatchIds: [active.dispatchId] });
  if (observedLifecycle.status !== "ready")
    throw dispatchLifecyclePendingError(observedLifecycle, context.runtimeSpawnError);
  const observedAttempt = observedLifecycle.rows.find(
    ({ attempt }) => attempt.runtimeSessionId === active.runtimeSessionId,
  );
  if (!observedAttempt)
    throw context.runtimeSpawnError(
      "runtime_recovery_pending",
      `Runtime ${active.runtimeSessionId} is missing from its dispatch lifecycle after observation.`,
    );
  if (observedAttempt.policy.attemptSettled) return true;
  if (observedAttempt.attempt.process === "alive") {
    if (active.spendCapExceeded) await context.enforceSpendCap(active);
    else if (fullStream) {
      const attachmentFailure = attachAdoptedObservations(context, active);
      if (attachmentFailure !== null) throw attachmentFailure;
    }
    return false;
  }
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
  const stop = processState
    ? sweepOrphanedProcessGroup({
        pid: processState.pid,
        dispatch: { rootDir: context.input.rootDir, dispatchId: active.dispatchId },
      })
    : "unknown_unreachable";
  if (stop !== "proven_stopped") {
    await consumeDurableOutput(context, active);
    context.processes.delete(active.runtimeSessionId);
    active.process.release?.();
    active.releaseAuthorization?.();
    throw context.runtimeSpawnError(
      "runtime_recovery_pending",
      `Runtime ${active.runtimeSessionId} process group is ${stop}; its reservation remains held.`,
    );
  }
  await consumeDurableOutput(context, active);
  await context.publishExit(active, null);
  return true;
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
    active.releaseAuthorization?.();
    return error;
  }
}

/** Startup-only retry for this repository's explicitly terminal sessions, independent of
 *  archived dispatch streams. Other repositories share the node's instance store, so an
 *  unknown session must be retained. Locally adopted/settling sessions are still in use. */
export async function sweepSettledRuntimeTempDirectories(context: RuntimeSpawnerContext): Promise<void> {
  if (!context.input.reclaimSettledRuntimeTempDirectories || !context.input.listRuntimeTempSessionIds) return;
  // Local temp directories are the only reclaim candidates. Point-reading exactly those names
  // keeps startup maintenance at D reads instead of reading the repository's whole session table.
  const runtimeSessionIds = [...new Set(context.input.listRuntimeTempSessionIds())];
  if (runtimeSessionIds.length === 0) {
    context.input.reclaimSettledRuntimeTempDirectories([]);
    return;
  }
  const lifecycleReads = await Promise.allSettled(
    runtimeSessionIds.map((runtimeSessionId) => readDispatch(context, { by: "session", runtimeSessionId })),
  );
  const settledRuntimeSessionIds: string[] = [];
  for (const [index, read] of lifecycleReads.entries()) {
    if (read.status !== "fulfilled" || read.value.status !== "ready") continue;
    if (!read.value.rows.some(({ policy }) => policy.groupSettled)) continue;
    settledRuntimeSessionIds.push(runtimeSessionIds[index]!);
  }
  if (settledRuntimeSessionIds.length === 0) return;
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
  binding: Pick<RuntimeBinding, "source"> & Partial<Pick<RuntimeBinding, "actor">>,
  runtimeNode: RuntimeSpawnerInput["runtimeNode"],
  header?: DispatchStreamHeader | null,
): boolean {
  if (header?.binding) {
    if (!sameWriteSource(binding.source, header.binding.source)) return false;
    if (binding.actor && binding.actor.principal.personId !== header.binding.actor.principal.personId) return false;
    if (header.executionOwner !== undefined)
      return header.executionOwner === "local"
        ? runtimeNode === undefined
        : header.executionOwner.nodeId === runtimeNode?.nodeId;
    // Historical center-local streams predate executionOwner. This spool is written only
    // by the local launcher, never replicated from a node. Its presence proves execution
    // here even when the initiating request carried a node source.
    if (runtimeNode === undefined) return true;
  }
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
