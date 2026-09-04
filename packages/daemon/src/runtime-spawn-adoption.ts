import {
  appendRuntimeWorkerRecord,
  readDispatchStream,
  readDispatchStreamHeaders,
  readDispatchStreamSummary,
  reopenDispatchStream,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptNativeProcess, runtimePidIsAlive } from "./runtime-spawn-process.ts";
import { durableOutputRecordCount, restoreDurableOutputRecords } from "./runtime-spawn-provider-stream.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { isRuntimeKindId } from "./runtime-inventory.ts";

export async function adoptRuntimes(context: RuntimeSpawnerContext): Promise<void> {
  const sessions = context.input.remote
    ? await context.input.remote.readRuntimeSessions()
    : context.requiredRuntimeProjection(context.input).readRuntimeSessions();
  const byId = new Map(sessions.map((session) => [session.runtimeSessionId, session]));
  for (const header of readDispatchStreamHeaders(context.input.rootDir)) {
    const fallbackSummary = header.fallbackAttempt
      ? readDispatchStreamSummary(context.input.rootDir, header.dispatchId)
      : null;
    if (fallbackSummary) context.reconcileFallback(fallbackSummary);
    const session = byId.get(header.runtimeSessionId);
    const metadata = adoptableMetadata(header);
    if (
      !session ||
      session.liveness === "exited" ||
      session.outcome !== null ||
      !metadata ||
      !ownedByRuntimeNode(metadata.binding, context.input.runtimeNodeId)
    )
      continue;
    const fullStream = readDispatchStream(context.input.rootDir, header.dispatchId),
      stream = fullStream ?? readDispatchStreamSummary(context.input.rootDir, header.dispatchId);
    if (!stream?.process) continue;
    const runtimeProcess = adoptNativeProcess(
      context.input.rootDir,
      stream.header.dispatchId,
      stream.process.pid,
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
      permissionMode: metadata.permissionMode,
      agent: stream.header.agentId
        ? { id: stream.header.agentId, name: stream.header.agentName ?? stream.header.agentId }
        : null,
      delegatedBy: stream.header.delegatedByAgentId
        ? {
            id: stream.header.delegatedByAgentId,
            name: stream.header.delegatedByAgentName ?? stream.header.delegatedByAgentId,
          }
        : null,
      squadId: stream.header.squadId ?? null,
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
    context.input.recordLifecycle?.({
      event: "runtime_spawn",
      runtimeSessionId: active.runtimeSessionId,
      dispatchId: active.dispatchId,
      pid: active.process.pid,
    });
    await restoreDurableOutputRecords(context, active, fullStream?.records ?? []);
    if (session.liveness !== "live") {
      await context.publishRuntimeEvent(
        "runtime_session_liveness_changed",
        { runtimeSessionId: active.runtimeSessionId, liveness: "live" },
        `${active.dispatchOpId}-adopt-${String(context.input.daemonGeneration)}`,
        active.binding,
      );
    }
    if (fullStream) attachActiveRuntime(context, active);
    const processState = stream.process;
    if (processState && !processState.exited && !runtimePidIsAlive(processState.pid)) {
      const timer = setTimeout(() => {
        const current =
          readDispatchStream(context.input.rootDir, active.dispatchId) ??
          readDispatchStreamSummary(context.input.rootDir, active.dispatchId);
        if (!current?.process?.exited && context.processes.get(active.runtimeSessionId) === active) {
          const reason = `runtime process ${String(processState.pid)} is no longer alive after daemon restart`;
          active.lossReason = reason;
          active.lossExitCode = current?.process?.exitCode ?? null;
          active.lossSignal = current?.process?.signal ?? null;
          appendRuntimeWorkerRecord(context.input.rootDir, active.dispatchId, {
            kind: "process_lost",
            occurredAt: context.input.now(),
            reason,
            exitCode: active.lossExitCode,
            signal: active.lossSignal,
          });
          context.input.schedule(() => context.publishExit(active, active.lossExitCode));
        }
      }, 50);
      timer.unref();
    }
  }
}

function ownedByRuntimeNode(binding: RuntimeBinding, runtimeNodeId: string | undefined): boolean {
  if (runtimeNodeId === undefined) return true;
  const source: unknown = binding.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
  const assignment = source as Record<string, unknown>;
  return assignment.kind === "assignment" && assignment.nodeId === runtimeNodeId;
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
    binding: header.binding,
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
