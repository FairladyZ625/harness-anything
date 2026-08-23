import { runtimeTypeMatchesKind, type AgentRuntimeInstanceDto } from "../../../daemon/src/agent-runtime-contract.ts";
import type { TaskDispatchRow, TaskDocumentListEntryRow } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { RuntimeSpawnInput } from "./runtime-control.ts";

// Dispatch flow for the Orchestration surface: one Agent or one Squad is selected in the
// GUI, the mission/cwd/task are authored here, and the daemon runs the same production
// spawn path `ha runtime run` uses. This module stays pure — the dialog renders it, the
// tests pin it, and no renderer code decides outcomes: the daemon's outcome judgment is
// consumed one-to-one.
export type RuntimeKindWord = "claude" | "codex" | "agy";
export interface DispatchAgentRef { readonly agentId: string; readonly agentName: string; readonly runtimeType: string }
export type DispatchSubject = { readonly kind: "agent"; readonly agent: DispatchAgentRef } | { readonly kind: "squad"; readonly squadId: string; readonly squadName: string; readonly leader: DispatchAgentRef; readonly workers: readonly DispatchAgentRef[] };
export type DispatchCwd = { readonly scope: "repo-root" } | { readonly scope: "repo-relative"; readonly path: string };
export type DispatchOutcome = "succeeded" | "failed" | "unknown" | "cancelled";
export type DispatchOutcomeView = DispatchOutcome | "running";
export interface DispatchRequest { readonly subject: DispatchSubject; readonly workerId?: string; readonly runtimeInstanceId?: string; readonly mission: string; readonly cwd: DispatchCwd; readonly taskId: string | null; readonly model?: string; readonly effort?: string; readonly idempotencyKey: string }
export interface DispatchChainCell { readonly dispatchId: string; readonly path: string }
export interface DispatchChainRow { readonly dispatchId: string; readonly mission: DispatchChainCell | null; readonly dispatchRecord: DispatchChainCell | null; readonly report: DispatchChainCell | null; readonly ledger: TaskDispatchRow | null }
export const dispatchExecutorRef = (request: Pick<DispatchRequest, "subject" | "workerId">): DispatchAgentRef | undefined => request.subject.kind === "agent" ? request.subject.agent : request.subject.workers.find((worker) => worker.agentId === request.workerId);
export const dispatchRuntimeType = (request: DispatchRequest): string => dispatchExecutorRef(request)?.runtimeType ?? "";
export function compatibleDispatchInstances(runtimeType: string, instances: readonly AgentRuntimeInstanceDto[]): readonly AgentRuntimeInstanceDto[] { return instances.filter((instance) => instance.enabled && runtimeTypeMatchesKind(runtimeType, instance.kindId)); }
export function compatibleDispatchModels(instances: readonly AgentRuntimeInstanceDto[]): readonly string[] { return [...new Set(instances.flatMap((instance) => instance.models))].sort(); }
export function requireCompatibleDispatchInstance(request: Pick<DispatchRequest, "subject" | "workerId" | "runtimeInstanceId">, instances: readonly AgentRuntimeInstanceDto[]): AgentRuntimeInstanceDto { const executor = dispatchExecutorRef(request), instance = instances.find((row) => row.instanceId === request.runtimeInstanceId); if (!executor) throw new Error("dispatch_executor_missing"); if (!instance || !instance.enabled || !runtimeTypeMatchesKind(executor.runtimeType, instance.kindId)) throw new Error("dispatch_runtime_type_mismatch"); return instance; }
export function buildDispatchSpawnInput(request: DispatchRequest, instances: readonly AgentRuntimeInstanceDto[]): RuntimeSpawnInput {
  const executor = dispatchExecutorRef(request); if (!executor) throw new Error("dispatch_executor_missing"); if (request.runtimeInstanceId) requireCompatibleDispatchInstance(request as DispatchRequest & { readonly runtimeInstanceId: string }, instances); const squadRouting = request.subject.kind === "squad" ? { agentId: request.subject.leader.agentId, targetAgentId: executor.agentId } : { agentId: executor.agentId };
  return { ...(request.runtimeInstanceId ? { runtimeInstanceId: request.runtimeInstanceId } : {}), ...squadRouting, ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), cwd: request.cwd, prompt: request.mission, taskId: request.taskId, idempotencyKey: request.idempotencyKey };
}
export const dispatchOutcomeView = (outcome: DispatchOutcome | null): DispatchOutcomeView => outcome ?? "unknown";
export function dispatchChainFromDocuments(documents: readonly TaskDocumentListEntryRow[], ledger: readonly TaskDispatchRow[]): readonly DispatchChainRow[] {
  const cell = (prefix: string, suffix: string) => (row: TaskDocumentListEntryRow): DispatchChainCell | null => { const path = row.path.slice(row.path.indexOf("artifacts/")); return path.startsWith(prefix) && path.endsWith(suffix) ? { dispatchId: path.slice(prefix.length, path.length - suffix.length), path: row.path } : null; };
  const collect = (prefix: string, suffix: string) => new Map(documents.map(cell(prefix, suffix)).filter((entry): entry is DispatchChainCell => entry !== null).map((entry) => [entry.dispatchId, entry]));
  const missions = collect("artifacts/missions/", ".md"), dispatchRecords = collect("artifacts/dispatches/", ".json"), reports = collect("artifacts/reports/", ".md"), ledgerRows = new Map(ledger.map((row) => [row.dispatchId, row]));
  const ids = [...new Set([...ledger.map((row) => row.dispatchId), ...missions.keys(), ...dispatchRecords.keys(), ...reports.keys()])].sort().reverse();
  return ids.map((dispatchId) => ({ dispatchId, mission: missions.get(dispatchId) ?? null, dispatchRecord: dispatchRecords.get(dispatchId) ?? null, report: reports.get(dispatchId) ?? null, ledger: ledgerRows.get(dispatchId) ?? null }));
}
