import {
  readDispatchStream,
  readDispatchStreams,
  reopenDispatchStream,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptNativeProcess, runtimePidIsAlive } from "./runtime-spawn-process.ts";
import { durableOutputRecordCount, restoreDurableOutputRecords } from "./runtime-spawn-provider-stream.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { RuntimePermissionMode } from "./runtime-permissions.ts";

export async function adoptRuntimes(context: any): Promise<void> {
  const sessions = context.input.remote
    ? await context.input.remote.readRuntimeSessions()
    : context.requiredRuntimeProjection(context.input).readRuntimeSessions();
  const byId = new Map(sessions.map(
    (session: { readonly runtimeSessionId: string }) => [session.runtimeSessionId, session],
  ));
  for (const stream of readDispatchStreams(context.input.rootDir)) {
    const session = byId.get(stream.header.runtimeSessionId) as
      | { readonly liveness: string; readonly outcome: string | null }
      | undefined;
    const metadata = adoptableMetadata(stream.header);
    if (!session || session.liveness === "exited" || session.outcome !== null || !stream.process || !metadata) continue;
    const runtimeProcess = adoptNativeProcess(
      context.input.rootDir,
      stream.header.dispatchId,
      stream.process.pid,
      durableOutputRecordCount(stream.records),
    );
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
      binding: metadata.binding,
      task: stream.header.taskId && stream.header.executionId
        ? { taskId: stream.header.taskId, executionId: stream.header.executionId }
        : null,
      cwd: metadata.cwd,
      prompt: metadata.prompt,
      ...(stream.header.promptSource ? { promptSource: stream.header.promptSource } : {}),
      onExitCommand: stream.header.onExitCommand ?? null,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
      startedAt: stream.header.startedAt,
      stream: reopenDispatchStream(context.input.rootDir, stream.header),
      resumeProviderSessionId: stream.header.resumeProviderSessionId ?? null,
      providerSessionId: stream.providerSessionId,
    });
    context.processes.set(active.runtimeSessionId, active);
    await restoreDurableOutputRecords(context, active, stream.records);
    if (session.liveness !== "live") {
      await context.publishRuntimeEvent(
        "runtime_session_liveness_changed",
        { runtimeSessionId: active.runtimeSessionId, liveness: "live" },
        `${active.dispatchOpId}-adopt-${String(context.input.daemonGeneration)}`,
        active.binding,
      );
    }
    attachActiveRuntime(context, active);
    if (!stream.process.exited && !runtimePidIsAlive(stream.process.pid)) {
      const timer = setTimeout(() => {
        const current = readDispatchStream(context.input.rootDir, active.dispatchId);
        if (!current?.process?.exited && context.processes.get(active.runtimeSessionId) === active) {
          context.input.schedule(() => context.publishExit(active, null));
        }
      }, 50);
      timer.unref();
    }
  }
}

function adoptableMetadata(header: DispatchStreamHeader): {
  readonly dispatchOpId: string;
  readonly kindId: "claude" | "codex" | "agy";
  readonly permissionMode: RuntimePermissionMode | null;
  readonly binding: RuntimeBinding;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
} | null {
  if (
    typeof header.dispatchOpId !== "string"
    || !["claude", "codex", "agy"].includes(String(header.kindId))
    || header.permissionMode !== null
      && !["bypass", "workspace-write", "read-only"].includes(String(header.permissionMode))
    || !isBinding(header.binding)
    || typeof header.cwd !== "string"
    || typeof header.prompt !== "string"
    || typeof header.model !== "string"
    || header.reasoningEffort !== null && typeof header.reasoningEffort !== "string"
  ) return null;
  return {
    dispatchOpId: header.dispatchOpId,
    kindId: header.kindId as "claude" | "codex" | "agy",
    permissionMode: header.permissionMode as RuntimePermissionMode | null,
    binding: header.binding,
    cwd: header.cwd,
    prompt: header.prompt,
    model: header.model,
    reasoningEffort: header.reasoningEffort,
  };
}
function isBinding(value: unknown): value is RuntimeBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const actor = binding.actor;
  return actor !== null
    && typeof actor === "object"
    && !Array.isArray(actor)
    && typeof (actor as { principal?: { personId?: unknown } }).principal?.personId === "string"
    && binding.source !== undefined;
}
