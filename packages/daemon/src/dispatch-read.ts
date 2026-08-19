import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout, type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { readDispatchStream, type DispatchStreamHeader } from "./dispatch-stream.ts";
import type { DaemonTaskDispatchesResult, TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";

export function readTaskDispatches(input: { readonly rootDir: string; readonly projection: TaskProjection; readonly taskId: string }): DaemonTaskDispatchesResult {
  const task = input.projection.read(input.taskId); if (!task.packagePath) throw new Error(`Task ${input.taskId} has no projected package path.`);
  const sessions = new Map(input.projection.readRuntimeSessionsForTask(input.taskId).map((session) => [session.runtimeSessionId, session]));
  const rows = new Map<string, TaskDispatchRow>();
  for (const document of input.projection.readReplicaBasis(null).documents.filter(({ path: target }) => target.startsWith(`${task.packagePath}/artifacts/dispatches/`) && target.endsWith(".json"))) {
    const target = String(document.path), read = input.projection.readDocument(target), archive = read.document ? parseArchive(read.document.body) : null; if (archive?.taskId === input.taskId) rows.set(String(archive.dispatchId), archiveRow(archive, sessions.get(String(archive.runtimeSessionId))));
  }
  const streamRoot = path.join(resolveHarnessLayout(input.rootDir).localRoot, "runtime", "dispatches");
  if (existsSync(streamRoot) && statSync(streamRoot).isDirectory()) for (const name of readdirSync(streamRoot).filter((value) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(value))) {
    const dispatchId = name.slice(0, -6), stream = readDispatchStream(input.rootDir, dispatchId); if (!stream?.header || stream.header.taskId !== input.taskId) continue;
    const current = sessions.get(stream.header.runtimeSessionId); if (!rows.has(dispatchId)) rows.set(dispatchId, liveRow(stream.header, stream.providerSessionId, current));
  }
  const cut = input.projection.list(); return { ok: true, status: cut.status, taskId: input.taskId, dispatches: [...rows.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)), watermark: cut.watermark, sourceRevision: cut.sourceRevision };
}

function archiveRow(value: Record<string, unknown>, session: RuntimeSession | undefined): TaskDispatchRow { return { dispatchId: String(value.dispatchId), taskId: String(value.taskId), executionId: String(value.executionId), runtimeSessionId: String(value.runtimeSessionId), instanceId: String(value.instanceId), ...(typeof value.agentId === "string" ? { agentId: value.agentId, agentName: typeof value.agentName === "string" ? value.agentName : value.agentId } : {}), ...(typeof value.delegatedByAgentId === "string" ? { delegatedByAgentId: value.delegatedByAgentId, delegatedByAgentName: typeof value.delegatedByAgentName === "string" ? value.delegatedByAgentName : value.delegatedByAgentId, squadId: String(value.squadId) } : {}), providerSessionId: typeof value.providerSessionId === "string" ? value.providerSessionId : session?.providerSessionId ?? null, eventStreamRef: typeof value.eventStreamRef === "string" ? value.eventStreamRef : null, startedAt: String(value.startedAt), endedAt: typeof value.endedAt === "string" ? value.endedAt : null, outcome: isOutcome(value.outcome) ? value.outcome : session?.outcome ?? "unknown", status: isOutcome(value.outcome) ? value.outcome : session?.outcome ?? "unknown" }; }
function liveRow(header: DispatchStreamHeader, providerSessionId: string | null, session: RuntimeSession | undefined): TaskDispatchRow { const outcome = session?.outcome ?? null; return { dispatchId: header.dispatchId, taskId: header.taskId!, executionId: header.executionId!, runtimeSessionId: header.runtimeSessionId, instanceId: header.instanceId, ...(header.agentId ? { agentId: header.agentId, agentName: header.agentName ?? header.agentId } : {}), ...(header.delegatedByAgentId ? { delegatedByAgentId: header.delegatedByAgentId, delegatedByAgentName: header.delegatedByAgentName ?? header.delegatedByAgentId, squadId: header.squadId! } : {}), providerSessionId: providerSessionId ?? session?.providerSessionId ?? null, eventStreamRef: header.eventStreamRef, startedAt: header.startedAt, endedAt: null, outcome, status: outcome ?? "running" }; }
function parseArchive(body: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(body); return isRecord(value) && value.schema === "runtime-dispatch/v1" ? value : null; } catch (error) { consumeKnownError(error); return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isOutcome(value: unknown): value is NonNullable<TaskDispatchRow["outcome"]> { return value === "succeeded" || value === "failed" || value === "unknown" || value === "cancelled"; }
