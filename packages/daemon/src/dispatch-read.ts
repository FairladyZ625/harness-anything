import { consumeKnownError, type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { readDispatchStream, type DispatchStreamHeader } from "./dispatch-stream.ts";
import type { DaemonTaskDispatchesPayload, DaemonTaskDispatchesResult, TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";

export function readTaskDispatches(input: { readonly rootDir: string; readonly projection: TaskProjection } & DaemonTaskDispatchesPayload): DaemonTaskDispatchesResult {
  const singleTaskId = input.taskId, query = singleTaskId === undefined ? { taskIds: input.taskIds, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) } : { taskIds: [singleTaskId] }, batch = input.projection.readTaskRuntimeBatch(query), tasks = new Map(batch.rows.map((row) => [row.taskId, row]));
  if (singleTaskId !== undefined && !batch.rows[0]?.packagePath) throw new Error(`Task ${singleTaskId} has no projected package path.`);
  const candidates = new Map<string, { readonly session: RuntimeSession; readonly packagePaths: readonly string[] }>();
  for (const task of batch.rows) for (const session of task.sessions) {
    const event = input.projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
    if (!event) continue;
    const dispatchId = event.payload.dispatchId,
      known = candidates.get(dispatchId),
      packagePaths = task.packagePath === null ? [] : [task.packagePath];
    candidates.set(dispatchId, {
      session,
      packagePaths: [...new Set([...(known?.packagePaths ?? []), ...packagePaths])],
    });
  }
  const rows = new Map<string, TaskDispatchRow>();
  for (const [dispatchId, candidate] of candidates) {
    for (const packagePath of candidate.packagePaths) {
      const read = input.projection.readDocument(`${packagePath}/artifacts/dispatches/${dispatchId}.json`),
        archive = read.document ? parseArchive(read.document.body) : null;
      if (archive?.taskId && tasks.has(String(archive.taskId))) {
        rows.set(dispatchId, archiveRow(archive, candidate.session));
        break;
      }
    }
    if (rows.has(dispatchId) || !/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) continue;
    const stream = readDispatchStream(input.rootDir, dispatchId);
    if (!stream?.header?.taskId || !tasks.has(stream.header.taskId)) continue;
    rows.set(
      dispatchId,
      liveRow(stream.header, stream.providerSessionId, candidate.session, stream.process?.exited === false),
    );
  }
  const dispatches = [...rows.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return singleTaskId === undefined
    ? { ok: true, status: batch.status, taskIds: batch.taskIds, unavailableTaskIds: batch.taskIds.filter((taskId) => !tasks.get(taskId)?.packagePath), dispatches, page: batch.page, watermark: batch.watermark, sourceRevision: batch.sourceRevision }
    : { ok: true, status: batch.status, taskId: singleTaskId, dispatches, watermark: batch.watermark, sourceRevision: batch.sourceRevision };
}

function archiveRow(value: Record<string, unknown>, session: RuntimeSession | undefined): TaskDispatchRow { return { dispatchId: String(value.dispatchId), taskId: String(value.taskId), executionId: String(value.executionId), runtimeSessionId: String(value.runtimeSessionId), instanceId: String(value.instanceId), ...(typeof value.agentId === "string" ? { agentId: value.agentId, agentName: typeof value.agentName === "string" ? value.agentName : value.agentId } : {}), ...(typeof value.delegatedByAgentId === "string" ? { delegatedByAgentId: value.delegatedByAgentId, delegatedByAgentName: typeof value.delegatedByAgentName === "string" ? value.delegatedByAgentName : value.delegatedByAgentId, squadId: String(value.squadId) } : {}), providerSessionId: typeof value.providerSessionId === "string" ? value.providerSessionId : session?.providerSessionId ?? null, eventStreamRef: typeof value.eventStreamRef === "string" ? value.eventStreamRef : null, startedAt: String(value.startedAt), endedAt: typeof value.endedAt === "string" ? value.endedAt : null, outcome: isOutcome(value.outcome) ? value.outcome : session?.outcome ?? "unknown", status: isOutcome(value.outcome) ? value.outcome : session?.outcome ?? "unknown" }; }
function liveRow(
  header: DispatchStreamHeader,
  providerSessionId: string | null,
  session: RuntimeSession | undefined,
  processRunning: boolean,
): TaskDispatchRow {
  const outcome = session?.outcome ?? null;
  return {
    dispatchId: header.dispatchId,
    taskId: header.taskId!,
    executionId: header.executionId!,
    runtimeSessionId: header.runtimeSessionId,
    instanceId: header.instanceId,
    ...(header.agentId ? { agentId: header.agentId, agentName: header.agentName ?? header.agentId } : {}),
    ...(header.delegatedByAgentId
      ? {
        delegatedByAgentId: header.delegatedByAgentId,
        delegatedByAgentName: header.delegatedByAgentName ?? header.delegatedByAgentId,
        squadId: header.squadId!,
      }
      : {}),
    providerSessionId: providerSessionId ?? session?.providerSessionId ?? null,
    eventStreamRef: header.eventStreamRef,
    startedAt: header.startedAt,
    endedAt: null,
    outcome,
    status: outcome ?? (session?.liveness === "live" || processRunning ? "running" : "unknown"),
  };
}
function parseArchive(body: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(body); return isRecord(value) && value.schema === "runtime-dispatch/v1" ? value : null; } catch (error) { consumeKnownError(error); return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isOutcome(value: unknown): value is NonNullable<TaskDispatchRow["outcome"]> { return value === "succeeded" || value === "failed" || value === "unknown" || value === "cancelled"; }
