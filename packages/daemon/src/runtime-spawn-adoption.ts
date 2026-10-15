import { randomUUID } from "node:crypto";
import type { ActiveRuntime, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import {
  appendRuntimeWorkerRecord,
  readDispatchStream,
  readDispatchStreamHeaders,
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

export async function adoptRuntimes(
  context: RuntimeSpawnerContext,
  onProgress?: (completed: number) => void,
  options?: { readonly sweepTempDirectories?: boolean },
): Promise<void> {
  // Reconstruct owner handles even when the center cannot answer. Publication errors remain
  // errors; they cannot erase independently verified local process control.
  const [sessionRead] = await Promise.allSettled([
    Promise.resolve().then(() =>
      context.input.remote
        ? context.input.remote.readRuntimeSessions()
        : context.requiredRuntimeProjection(context.input).readRuntimeSessions(),
    ),
  ]);
  const byId = new Map(
    sessionRead.status === "fulfilled" ? sessionRead.value.map((session) => [session.runtimeSessionId, session]) : [],
  );
  const failures: unknown[] = sessionRead.status === "rejected" ? [sessionRead.reason] : [];
  let completed = 0;
  for (const header of readDispatchStreamHeaders(context.input.rootDir)) {
    if (context.processes.has(header.runtimeSessionId) || context.exiting.has(header.runtimeSessionId)) continue;
    const metadata = adoptableMetadata(header);
    if (!metadata || !ownedByRuntimeSpawner(metadata.binding, context.input.runtimeNode)) continue;
    const fallbackSummary = header.fallbackAttempt
      ? readDispatchStreamSummary(context.input.rootDir, header.dispatchId)
      : null;
    if (fallbackSummary) context.reconcileFallback(fallbackSummary);
    const session = byId.get(header.runtimeSessionId);
    if (sessionRead.status === "fulfilled" && (!session || session.outcome !== null)) {
      removeRuntimeCallbackRelay(context.input.rootDir, header.dispatchId);
      continue;
    }
    const fullStream = readDispatchStream(context.input.rootDir, header.dispatchId),
      stream = fullStream ?? readDispatchStreamSummary(context.input.rootDir, header.dispatchId);
    if (!stream) continue;
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
      startedAt: stream.header.startedAt,
      stream: reopenDispatchStream(context.input.rootDir, stream.header),
      fallbackAttempt: stream.header.fallbackAttempt ?? null,
      resumeProviderSessionId: stream.header.resumeProviderSessionId ?? null,
      providerSessionId: stream.providerSessionId,
    });
    context.processes.set(active.runtimeSessionId, active);
    const processAlive = !!processState && !processState.exited && runtimePidIsAlive(processState.pid);
    if (processAlive && fullStream) attachActiveRuntime(context, active);
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
        if (processAlive && session?.liveness !== "live" && session?.liveness !== "exited") {
          await context.publishRuntimeEvent(
            "runtime_session_liveness_changed",
            { runtimeSessionId: active.runtimeSessionId, liveness: "live" },
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
          removeRuntimeCallbackRelay(context.input.rootDir, active.dispatchId);
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
        if (context.processes.get(active.runtimeSessionId) === active)
          context.processes.delete(active.runtimeSessionId);
        active.process.release?.();
      }
      failures.push(publication.reason);
    } else {
      // Settlement must finish before it can renew the startup inactivity budget.
      onProgress?.(++completed);
    }
  }
  // The sweep runs after the header loop, so sessions re-adopted above are live in
  // context.processes and their directories are skipped. Startup adoption (daemon open, or an
  // edge's readiness gate) passes the flag; cancel's mid-operation adoption call does not — a
  // just-minted directory whose dispatch event has not committed yet would be
  // indistinguishable here from an orphaned one.
  if (options?.sweepTempDirectories) await sweepSettledRuntimeTempDirectories(context);
  if (failures.length > 0) throw failures[0];
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
  binding: RuntimeBinding,
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
