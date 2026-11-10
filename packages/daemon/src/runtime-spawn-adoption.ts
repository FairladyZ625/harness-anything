import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
  dispatchOwnerForNode,
  sameWriteSource,
  type DispatchLifecycleView,
} from "@harness-anything/kernel";
import type { ActiveRuntime, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  readDispatchStream,
  readDispatchStreamHeader,
  readDispatchStreamSummary,
  readDispatchStreamHeaders,
  reopenDispatchStream,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { createActiveRuntime, attachActiveRuntime, isRuntimeProcessProvenStopped } from "./runtime-spawn-active.ts";
import { adoptNativeProcess } from "./runtime-spawn-process.ts";
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
import {
  dispatchLifecyclePendingError,
  readActiveDispatchLifecycle,
  readDispatchLifecycle,
} from "./runtime-dispatch-admission.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";

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
    candidates = new Map<string, DispatchLifecycleView>(),
    streamHeaders = readDispatchStreamHeaders(context.input.rootDir);
  const instanceIds = context.input.runtimeInstances?.().map(({ instanceId }) => instanceId) ?? [],
    active = await Promise.all(
      [...new Set([...instanceIds, ...streamHeaders.map(({ instanceId }) => instanceId)])].map((instanceId) =>
        readActiveDispatchLifecycle(
          (query) => readDispatchLifecycle(context, query),
          context.runtimeSpawnError,
          instanceId,
        ),
      ),
    );
  const activeViews = active.flat();
  for (const view of activeViews)
    if (view.attempt.fence.verified && view.attempt.fence.owner === owner)
      candidates.set(view.attempt.runtimeSessionId, view);
  const activeDispatchIds = new Set(activeViews.map(({ attempt }) => attempt.dispatchId)),
    terminalHeaders = new Map(
      streamHeaders
        .filter(({ dispatchId }) => !activeDispatchIds.has(dispatchId))
        .map((header) => [header.dispatchId, header]),
    );
  if (terminalHeaders.size) {
    const lifecycle = await readDispatchLifecycle(context, {
      by: "dispatch",
      dispatchIds: [...terminalHeaders.keys()],
    });
    if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
    for (const view of lifecycle.rows) {
      const header = terminalHeaders.get(view.attempt.dispatchId);
      if (
        view.policy.attemptSettled &&
        header?.runtimeSessionId === view.attempt.runtimeSessionId &&
        header.instanceId === view.attempt.instanceId &&
        view.attempt.fence.verified &&
        view.attempt.fence.owner === owner
      )
        candidates.set(view.attempt.runtimeSessionId, view);
    }
  }
  let pending = recoveries.get(context);
  if (!pending) recoveries.set(context, (pending = new Map()));
  let completed = 0;
  const attempts = [...candidates]
    .filter(([id]) => !options?.runtimeSessionId || id === options.runtimeSessionId)
    .map(([runtimeSessionId, initial]) => {
      const existing = pending.get(runtimeSessionId);
      if (existing && existing.result?.outcome !== "failed") {
        // Retry the durable stream when the aggregate no longer observes a live process.
        if (existing.result?.outcome !== "ready" || initial.attempt.process === "alive") return existing.promise;
        pending.delete(runtimeSessionId);
      }
      let restored = false;
      const dispatchId = initial.attempt.dispatchId;
      const entry: { promise: Promise<RuntimeRecoveryResult>; result?: RuntimeRecoveryResult } = {
        promise: Promise.resolve()
          .then(async () => {
            // The launch may not have written its stream header yet either.
            if (context.ownsModelSlot?.(runtimeSessionId)) return "ready" as const;
            const lifecycle = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [dispatchId!] });
            if (lifecycle.status === "pending")
              throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
            const view = lifecycle.rows.find(({ attempt }) => attempt.dispatchId === dispatchId);
            if (!view)
              throw context.runtimeSpawnError(
                "runtime_recovery_missing_dispatch",
                "Dispatch is missing from its lifecycle.",
              );
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

export async function assertRuntimeRecoveryReady(
  context: RuntimeSpawnerContext,
  runtimeSessionId: string,
  dispatchId?: string | null,
): Promise<boolean> {
  const recovery = recoveries.get(context)?.get(runtimeSessionId);
  if (dispatchId === null || recovery?.result?.outcome === "foreign" || recovery?.result?.outcome === "settled")
    return false;
  if (recovery?.result?.outcome === "failed") {
    const lifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
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
  const streamSummary = readDispatchStreamSummary(context.input.rootDir, header.dispatchId);
  if (header.fallbackAttempt) context.reconcileFallback(streamSummary);
  if (lifecycle.policy.attemptSettled || session?.outcome) {
    if (streamSummary && lifecycle.policy.groupSettled && !lifecycle.policy.successorAdmissible)
      archiveDispatchStream(context.input.rootDir, header.dispatchId);
    removeRuntimeCallbackRelay(header.dispatchId);
    return true;
  }
  const fullStream = readDispatchStream(context.input.rootDir, header.dispatchId),
    stream = fullStream ?? streamSummary;
  if (!stream) return false;
  const processState = stream.process,
    processPid = processState?.pid ?? 0,
    binding = authorizationBinding
      ? { ...authorizationBinding, ...metadata.binding, authorizationDecision: undefined }
      : metadata.binding,
    livenessEvent = {
      type: "runtime_session_liveness_changed",
      payload: {
        runtimeSessionId: stream.header.runtimeSessionId,
        liveness: runtimePidIsAlive(processPid) ? ("live" as const) : ("unknown" as const),
        ...(processPid > 1 ? { processGroupPid: processPid } : {}),
      },
    } as const;
  if (lifecycle.attempt.process !== "exited")
    await context.publishRuntimeEvent(
      livenessEvent.type,
      livenessEvent.payload,
      `runtime-observation-${stream.header.dispatchId}-${randomUUID()}`,
      binding,
    );
  if (context.closed?.()) return false;
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
    binding,
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
  context.input.recordLifecycle?.({
    event: "runtime_spawn",
    runtimeSessionId: active.runtimeSessionId,
    dispatchId: active.dispatchId,
    ...(processState ? { pid: processState.pid } : {}),
  });
  await restoreDurableOutputRecords(context, active, fullStream?.records ?? []);
  if (context.closed?.()) return false;
  const observedLifecycle = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [active.dispatchId] });
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
  if (observedAttempt.policy.attemptSettled) {
    active.process.release?.();
    return true;
  }
  context.processes.set(active.runtimeSessionId, active);
  if (observedAttempt.attempt.process === "alive") {
    if (active.spendCapExceeded) await context.enforceSpendCap(active);
    else if (fullStream) attachAdoptedObservations(context, active);
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
  const stop = await isRuntimeProcessProvenStopped(context, active, observedAttempt.attempt, processPid);
  await consumeDurableOutput(context, active);
  if (stop !== "proven_stopped") {
    context.processes.delete(active.runtimeSessionId);
    active.process.release?.();
    active.releaseAuthorization?.();
    throw context.runtimeSpawnError(
      "runtime_recovery_pending",
      `Runtime ${active.runtimeSessionId} process group is ${stop}; its reservation remains held.`,
    );
  }
  await context.publishExit(active, active.lossExitCode);
  return true;
}

/** Record and rethrow an observation attach failure so recovery cannot leave an unwatched worker. */
function attachAdoptedObservations(context: RuntimeSpawnerContext, active: ActiveRuntime): void {
  try {
    attachActiveRuntime(context, active);
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
    throw error;
  }
}

export async function sweepSettledRuntimeTempDirectories(context: RuntimeSpawnerContext): Promise<void> {
  if (!context.input.reclaimSettledRuntimeTempDirectories || !context.input.listRuntimeTempSessionIds) return;
  const runtimeSessionIds = [...new Set(context.input.listRuntimeTempSessionIds())];
  if (runtimeSessionIds.length === 0) {
    context.input.reclaimSettledRuntimeTempDirectories([]);
    return;
  }
  const lifecycleReads = await Promise.allSettled(
    runtimeSessionIds.map(async (id) => readDispatchLifecycle(context, { by: "session", runtimeSessionId: id })),
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
