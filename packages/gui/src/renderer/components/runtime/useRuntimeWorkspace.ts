import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { AgentDeclarationV1, SquadDeclarationV1 } from "../../../../../daemon/src/agent-entities.contract.ts";
import { agentEntityClient, type SquadEntityRow } from "../../agent-entity-client.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { harnessClient } from "../../api-client.ts";
import { buildDispatchSpawnInput, type DispatchRequest } from "../../dispatch-flow.ts";
import { joinRuntimePanorama, runtimeDockRows, type RuntimeDockRow, type RuntimePanoramaTask } from "../../runtime-panorama.ts";
import { runtimeCommandClient } from "../../runtime-command-client.ts";
import { submitRuntimeSpawn, type RuntimeSpawnSettlement } from "../../runtime-control.ts";
import { runtimeInstanceClient, type RuntimeInstanceCreateInput, type RuntimeInstanceUpdateInput } from "../../runtime-instance-client.ts";
import { createGuiExecutionId } from "../../task-actions.ts";
import { t } from "../../i18n/index.tsx";

export type RuntimeSelection = { readonly type: "runtime" | "agent" | "squad" | "orchestration" | "session"; readonly id: string };
const message = (value: unknown): string => value instanceof Error ? value.message : String(value);

export function useRuntimeWorkspace(repoId: string, tasks: readonly RuntimePanoramaTask[]) {
  const client = useQueryClient();
  const machine = useQuery({ queryKey: ["runtime-instances", "machine"], queryFn: runtimeInstanceClient.list, staleTime: 2_000 });
  const listedInstances = machine.data?.instances ?? [];
  const authProbes = useQueries({ queries: listedInstances.map((instance) => { const needsProbe = instance.authReadiness.code === "runtime_auth_not_checked"; return { queryKey: ["runtime-instance-auth", instance.instanceId, machine.dataUpdatedAt], queryFn: () => runtimeInstanceClient.probe(instance.instanceId), enabled: needsProbe, retry: false, staleTime: 2_000, ...(needsProbe ? {} : { initialData: instance }) }; }) });
  const instances = listedInstances.map((instance, index) => authProbes[index]?.data ?? instance);
  const authProbeErrors = new Map<string, string>(listedInstances.flatMap((instance, index) => { const error = authProbes[index]?.error; return error === null || error === undefined ? [] : [[instance.instanceId, message(error)] as const]; }));
  const overview = useQuery({ queryKey: ["runtime-control", repoId, "overview"], queryFn: () => agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const agents = useQuery({ queryKey: ["agents", repoId], queryFn: () => agentEntityClient.listAgents(repoId), staleTime: 4_000 });
  const squadQuery = { queryKey: ["squads", repoId], queryFn: () => agentEntityClient.listSquads(repoId), staleTime: 4_000 } as const;
  const squads = useQuery(squadQuery);
  const panorama = useQuery({ queryKey: ["runtime-panorama", repoId, tasks.map((task) => task.taskId).join(",")], queryFn: () => readPanorama(repoId, tasks, { listSquads: () => client.fetchQuery(squadQuery), getTaskDispatches: (taskIds) => harnessClient.getTaskDispatches({ repoId, taskIds }) }), staleTime: 4_000 });
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [settlement, setSettlement] = useState<RuntimeSpawnSettlement | null>(null);

  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["runtime-instances", "machine"] }), client.invalidateQueries({ queryKey: ["runtime-control", repoId] }), client.invalidateQueries({ queryKey: ["runtime-panorama", repoId] })]); };
  const run = async (label: string, action: () => Promise<unknown>, reread = true): Promise<unknown> => {
    if (busy) return null; setBusy(true); setError(null);
    try { const result = await action(); const record = result as Record<string, unknown> | null, id = String(record?.sessionId ?? record?.opId ?? "applied"); setFeedback(t("agentRuntime.feedbackApplied", { label, id })); if (reread) await refresh(); return result; }
    catch (cause) { consumeKnownError(cause); setFeedback(null); setError(t("agentRuntime.feedbackFailed", { label, error: message(cause) })); return null; }
    finally { setBusy(false); }
  };
  const spawn = async (input: Parameters<typeof runtimeCommandClient.spawn>[1]): Promise<RuntimeSpawnSettlement | null> => {
    if (busy) return null; setBusy(true); setError(null); setSettlement(null);
    try { const result = await submitRuntimeSpawn(input, { spawn: (payload) => leaseAwareSpawn(repoId, payload), showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId), overview: () => agentRuntimeClient.overview(repoId), onPending: setSettlement }); setSettlement(result); await refresh(); await client.invalidateQueries({ queryKey: ["orchestration", repoId] }); return result; }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); return null; }
    finally { setBusy(false); }
  };

  const rows: readonly RuntimeDockRow[] = runtimeDockRows(panorama.data ?? [], overview.data?.sessions ?? []);
  return {
    machine, instances, authProbeErrors, overview, agents, squads, panorama, dockRows: rows, busy, feedback, error, settlement, clearFeedback: () => { setFeedback(null); setError(null); },
    createInstance: async (input: RuntimeInstanceCreateInput) => { const created = await run(t("agentRuntime.opInstanceCreated"), () => runtimeInstanceClient.create(input), false); if (!created) return null; if (input.authMode === "subscription") { const probed = await run(t("agentRuntime.opAuthChecked"), () => runtimeInstanceClient.probe(input.instanceId), false); if (subscriptionCreationNeedsLogin(input, probed)) await run(t("agentRuntime.opSignIn"), () => runtimeInstanceClient.auth(repoId, input.instanceId, "login"), false); } await refresh(); return created; },
    updateInstance: (input: RuntimeInstanceUpdateInput) => run(t("agentRuntime.opInstanceUpdated"), () => runtimeInstanceClient.update(input)),
    setInstanceEnabled: (instanceId: string, enabled: boolean) => run(t(enabled ? "agentRuntime.opInstanceEnabled" : "agentRuntime.opInstanceDisabled"), () => runtimeInstanceClient.setEnabled(instanceId, enabled)),
    deleteInstance: (instanceId: string) => run(t("agentRuntime.opInstanceDeleted"), () => runtimeInstanceClient.delete(instanceId)),
    validateInstance: (instanceId: string) => run(t("agentRuntime.opAuthChecked"), () => runtimeInstanceClient.probe(instanceId)),
    authInstance: (instanceId: string, action: "login" | "reauth" | "logout") => run(t(action === "logout" ? "agentRuntime.opSignOut" : action === "reauth" ? "agentRuntime.opReauth" : "agentRuntime.opSignIn"), () => runtimeInstanceClient.auth(repoId, instanceId, action), false),
    saveAgent: async (declaration: AgentDeclarationV1) => { const saved = await run(t("agentRuntime.opAgentSaved"), () => agentEntityClient.saveAgent(repoId, declaration), false); await client.invalidateQueries({ queryKey: ["agents", repoId] }); await client.invalidateQueries({ queryKey: ["agent-detail", repoId] }); return saved; },
    saveSquad: async (declaration: SquadDeclarationV1) => { const saved = await run(t("agentRuntime.opSquadSaved"), () => agentEntityClient.saveSquad(repoId, declaration), false); await client.invalidateQueries({ queryKey: ["squads", repoId] }); await client.invalidateQueries({ queryKey: ["squad-detail", repoId] }); return saved; },
    cancelSession: (runtimeSessionId: string) => run(t("agentRuntime.opSessionCancelled"), () => runtimeCommandClient.cancel(repoId, runtimeSessionId)),
    dispatch: (request: DispatchRequest) => spawn(buildDispatchSpawnInput(request, overview.data?.instances ?? []))
  };
}

export function subscriptionCreationNeedsLogin(input: Pick<RuntimeInstanceCreateInput, "authMode">, probed: unknown): boolean { return input.authMode === "subscription" && typeof probed === "object" && probed !== null && "authState" in probed && probed.authState === "unauthenticated"; }

export function useAgentDetail(repoId: string, agentId: string | null) { return useQuery({ queryKey: ["agent-detail", repoId, agentId], queryFn: () => agentEntityClient.showAgent(repoId, agentId ?? ""), enabled: agentId !== null, staleTime: 4_000 }); }
export function useSquadDetail(repoId: string, squadId: string | null) { return useQuery({ queryKey: ["squad-detail", repoId, squadId], queryFn: () => agentEntityClient.showSquad(repoId, squadId ?? ""), enabled: squadId !== null, staleTime: 4_000 }); }

export async function readPanorama(repoId: string, tasks: readonly RuntimePanoramaTask[], reads: { readonly listSquads: () => Promise<readonly SquadEntityRow[]>; readonly getTaskDispatches: (taskIds: readonly string[]) => ReturnType<typeof harnessClient.getTaskDispatches> } = { listSquads: () => agentEntityClient.listSquads(repoId), getTaskDispatches: (taskIds) => harnessClient.getTaskDispatches({ repoId, taskIds }) }) {
  if (tasks.length === 0) return [];
  const chunks = chunkTaskIds(tasks.map(({ taskId }) => taskId)), squadPromise = reads.listSquads(), dispatchPromises = chunks.map((taskIds) => reads.getTaskDispatches(taskIds)), [squadRead] = await Promise.allSettled([squadPromise]), dispatchReads = await Promise.allSettled(dispatchPromises);
  for (const read of [squadRead, ...dispatchReads]) if (read?.status === "rejected") consumeKnownError(read.reason);
  const squads = squadRead?.status === "fulfilled" ? squadRead.value : [], dispatches = dispatchReads.flatMap((read) => read.status === "fulfilled" ? read.value.dispatches : []);
  return joinRuntimePanorama(tasks, dispatches, new Map(squads.map((squad) => [squad.id, squad])));
}
function chunkTaskIds(taskIds: readonly string[]): readonly (readonly string[])[] { const chunks: string[][] = []; for (let offset = 0; offset < taskIds.length; offset += 500) chunks.push(taskIds.slice(offset, offset + 500)); return chunks; }

// A task-bound dispatch spawns first; only a runtime_task_lease_required rejection triggers
// one lease acquisition and one resubmit under the same idempotency key — the first attempt
// wrote no ledger event, so the retry is not a duplicate dispatch.
async function leaseAwareSpawn(repoId: string, input: Parameters<typeof runtimeCommandClient.spawn>[1]): Promise<unknown> {
  const first = await runtimeCommandClient.spawn(repoId, input);
  if (input.taskId === null || !rejectedWith(first, "runtime_task_lease_required")) return first;
  const started = await harnessClient.startTask({ repoId, taskId: input.taskId, executionId: createGuiExecutionId() });
  return started.outcome === "applied" || started.outcome === "pending" ? runtimeCommandClient.spawn(repoId, input) : first;
}
function rejectedWith(value: unknown, code: string): boolean { return typeof value === "object" && value !== null && (value as { readonly outcome?: unknown }).outcome === "op_rejected" && String((value as { readonly code?: unknown }).code ?? ((value as { readonly error?: { readonly code?: unknown } }).error?.code)) === code; }
