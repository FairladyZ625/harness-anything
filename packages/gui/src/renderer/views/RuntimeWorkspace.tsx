import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentRuntimeClient } from "../agent-runtime-client.ts";
import { agentEntityClient } from "../agent-entity-client.ts";
import { runtimeCommandClient } from "../runtime-command-client.ts";
import { submitRuntimeSpawn, type RuntimeSpawnInput, type RuntimeSpawnSettlement } from "../runtime-control.ts";
import type { AgentEntityRow, SquadEntityRow } from "../agent-entity-client.ts";
import type { DispatchRequest, DispatchSubject } from "../dispatch-flow.ts";
import { buildDispatchSpawnInput } from "../dispatch-flow.ts";
import { createGuiExecutionId } from "../task-actions.ts";
import { harnessClient } from "../api-client.ts";
import { RuntimeControlPanel } from "../components/RuntimeControlPanel.tsx";
import { RuntimeInstanceManager } from "../components/RuntimeInstanceManager.tsx";
import { EntityLayersPanel } from "../components/EntityLayersPanel.tsx";
import { DispatchDialog } from "../components/DispatchDialog.tsx";
import { OrchestrationPanel } from "../components/OrchestrationPanel.tsx";
import { AgentRuntimeView } from "./agent-runtime-view.tsx";
import { t } from "../i18n/index.tsx";

type TaskOption = { readonly taskId: string; readonly title: string; readonly heldLease: boolean };
type DialogState = { readonly subject: DispatchSubject; readonly prompts: readonly string[] };
export function RuntimeWorkspace({ repoId, tasks }: { readonly repoId: string; readonly tasks: readonly TaskOption[] }) {
  const queryClient = useQueryClient(), key = ["runtime-control", repoId, "overview"] as const, overview = useQuery({ queryKey: key, queryFn: () => agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const [busy, setBusy] = useState(false), [settlement, setSettlement] = useState<RuntimeSpawnSettlement | null>(null), [revision, setRevision] = useState(0), [error, setError] = useState<string | null>(null), [dialog, setDialog] = useState<DialogState | null>(null), [focus, setFocus] = useState<{ readonly sessionId: string; readonly nonce: number } | null>(null);
  const reread = async () => { await queryClient.fetchQuery({ queryKey: key, queryFn: () => agentRuntimeClient.overview(repoId), staleTime: 0 }); setRevision((value) => value + 1); };
  const spawn = async (input: RuntimeSpawnInput) => { if (busy) return; setBusy(true); setSettlement(null); setError(null); try { const result = await submitRuntimeSpawn(input, { spawn: (payload) => runtimeCommandClient.spawn(repoId, payload), showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId), overview: () => agentRuntimeClient.overview(repoId), onPending: setSettlement }); setSettlement(result); await reread(); } catch (cause) { consumeKnownError(cause); setError(message(cause)); } finally { setBusy(false); } };
  // The prototype's "派出时将自动获取执行租约": a task-bound dispatch spawns first, and only a
  // runtime_task_lease_required rejection triggers one lease acquisition and one resubmit with
  // the same idempotency key — the first attempt wrote no ledger event, so the retry is not a
  // duplicate dispatch.
  const dispatch = async (request: DispatchRequest) => { if (busy) return; setBusy(true); setError(null); try { const result = await submitRuntimeSpawn(buildDispatchSpawnInput(request, overview.data?.instances ?? []), { spawn: (payload) => leaseAwareSpawn(repoId, payload), showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId), overview: () => agentRuntimeClient.overview(repoId), onPending: setSettlement }); setSettlement(result); if (result.runtimeSessionId) setFocus({ sessionId: result.runtimeSessionId, nonce: Date.now() }); setDialog(null); await queryClient.invalidateQueries({ queryKey: ["orchestration-dispatches", repoId] }); await queryClient.invalidateQueries({ queryKey: ["orchestration-documents", repoId] }); await reread(); } catch (cause) { consumeKnownError(cause); setError(message(cause)); } finally { setBusy(false); } };
  const openAgentDialog = async (agent: AgentEntityRow) => { setDialog({ subject: { kind: "agent", agent: { agentId: agent.id, agentName: agent.name, runtimeType: agent.runtimeType } }, prompts: [] }); try { const detail = await agentEntityClient.showAgent(repoId, agent.id); setDialog((current) => current?.subject.kind === "agent" && current.subject.agent.agentId === agent.id ? { ...current, prompts: detail.prompts } : current); } catch (cause) { consumeKnownError(cause); } };
  const openSquadDialog = async (squad: SquadEntityRow) => { setDialog({ subject: { kind: "squad", squadId: squad.id, squadName: squad.name, leader: { agentId: squad.leader, agentName: squad.leader, runtimeType: "" }, workers: squad.workers.map((worker) => ({ agentId: worker, agentName: worker, runtimeType: "" })) }, prompts: [] }); try { const agents = await agentEntityClient.listAgents(repoId), detail = await agentEntityClient.showSquad(repoId, squad.id), byId = new Map(agents.map((agent) => [agent.id, agent])); setDialog((current) => current?.subject.kind === "squad" && current.subject.squadId === squad.id ? { ...current, subject: { ...current.subject, leader: { agentId: detail.leader, agentName: byId.get(detail.leader)?.name ?? detail.leader, runtimeType: byId.get(detail.leader)?.runtimeType ?? "" }, workers: detail.workers.map((worker) => ({ agentId: worker, agentName: byId.get(worker)?.name ?? worker, runtimeType: byId.get(worker)?.runtimeType ?? "" })) } } : current); } catch (cause) { consumeKnownError(cause); } };
  if (overview.isError) return <section className="p-6 text-status-blocked">{t("views.agentRuntimeView.runtimeReadFailed", { error: message(overview.error) })}</section>;
  if (!overview.data) return <section className="p-6 text-text-faint">{t("views.agentRuntimeView.loadingRuntimeProjection")}</section>;
  const runtimeInstances = overview.data.instances;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="max-h-[62dvh] shrink-0 overflow-y-auto"><RuntimeInstanceManager repoId={repoId}/><EntityLayersPanel repoId={repoId} onDispatchAgent={(agent) => { void openAgentDialog(agent); }} onDispatchSquad={(squad) => { void openSquadDialog(squad); }}/>{error && <p role="alert" className="border-b border-border bg-status-blocked/10 px-4 py-2 text-xs text-status-blocked">{error}</p>}<RuntimeControlPanel overview={overview.data} tasks={tasks} busy={busy} settlement={settlement} onSpawn={spawn}/><OrchestrationPanel repoId={repoId} tasks={tasks} revision={revision} onFocusSession={(sessionId) => setFocus({ sessionId, nonce: Date.now() })}/></div><AgentRuntimeView key={`${repoId}:${revision}`} repoId={repoId} tasks={tasks} focus={focus}/>{dialog && <DispatchDialog subject={dialog.subject} instances={runtimeInstances} tasks={tasks} prompts={dialog.prompts} busy={busy} notice={settlement?.state === "pending" ? settlement.hint : null} onCancel={() => setDialog(null)} onSubmit={(request) => { void dispatch(request); }}/>}</div>;
}
async function leaseAwareSpawn(repoId: string, input: RuntimeSpawnInput): Promise<unknown> { const first = await runtimeCommandClient.spawn(repoId, input); if (input.taskId === null || !rejectedWith(first, "runtime_task_lease_required")) return first; const started = await harnessClient.startTask({ repoId, taskId: input.taskId, executionId: createGuiExecutionId() }); return started.outcome === "applied" || started.outcome === "pending" ? runtimeCommandClient.spawn(repoId, input) : first; }
function rejectedWith(value: unknown, code: string): boolean { return typeof value === "object" && value !== null && (value as { readonly outcome?: unknown }).outcome === "op_rejected" && String((value as { readonly code?: unknown }).code ?? ((value as { readonly error?: { readonly code?: unknown } }).error?.code)) === code; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function consumeKnownError(value: unknown): void { void value; }
