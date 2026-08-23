import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { AgentDeclarationV1, SquadDeclarationV1 } from "../../../../../daemon/src/agent-entities.contract.ts";
import { successfulAgentRuntimeResult, type AgentRuntimeSessionDto } from "../../../../../daemon/src/agent-runtime-contract.ts";
import { agentEntityClient, type SquadEntityRow } from "../../agent-entity-client.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { harnessClient } from "../../api-client.ts";
import { buildDispatchSpawnInput, type DispatchRequest } from "../../dispatch-flow.ts";
import { joinRuntimePanorama, runtimeDockRows, type RuntimePanoramaTask } from "../../runtime-panorama.ts";
import { runtimeCommandClient } from "../../runtime-command-client.ts";
import { submitRuntimeSpawn, type RuntimeSpawnSettlement } from "../../runtime-control.ts";
import { runtimeInstanceClient, type RuntimeInstanceCreateInput, type RuntimeInstanceUpdateInput } from "../../runtime-instance-client.ts";
import { createGuiExecutionId } from "../../task-actions.ts";
import { t } from "../../i18n/index.tsx";

export type RuntimeSelection = { readonly type: "runtime" | "agent" | "squad" | "session"; readonly id: string };
const message = (value: unknown): string => value instanceof Error ? value.message : String(value);

// 可寻址选择(W4 路由的运行时段):agent/squad/session 用本名,Runtime 实例在导航
// 引用里叫 provider/<id>(与一级入口「Provider」同名),选择类型仍是 "runtime"。
export function runtimeSelectionRef(selection: RuntimeSelection): string { return selection.type ===
  "runtime" ? `provider/${selection.id}` : `${selection.type}/${selection.id}`; }
export function runtimeSelectionFromRef(ref: string | null): RuntimeSelection | null {
  if (ref === null) return null;
  const separator = ref.indexOf("/"); if (separator < 0) return null;
  const kind = ref.slice(0, separator), id = ref.slice(separator + 1); if (id === "") return null;
  const type = kind === "provider" ? "runtime" : kind === "agent" || kind === "squad" || kind === "session" ? kind : null;
  return type === null ? null : { type, id };
}

// Liveness maps, not point comparisons (dec_8DCD52E98BAB268B0194B1E399): the daemon's
// liveness word decides "is this carrier running anything" through a table lookup alone.
const LIVENESS_LIVE: Record<string, boolean> = { live: true };

// W6 IA 拆分:聚合页撤销后,「运行时」组三个入口各自只读自己的面——每页一个
// hook,一处读失败只降级本页(原聚合页「每区域读自己的源」原则在页粒度上延续)。
// 共享的 busy/feedback 通道与 spawn 收据轮询留在 useRuntimeChannel,三个 hook 都从
// 这里组装;panorama 读保持 W6 收窄(runtimePanoramaTasks 只查 overview 已关联的
// taskId),任何入口都不退回全量查询。

// One busy/feedback channel per runtime page: every mutation reports through the same
// feedback line, the same error line, and (for spawn-shaped actions) the same receipt
// settlement footer. The channel owns no reads; the page hook passes its own refresh.
function useRuntimeChannel(repoId: string, refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null), [settlement, setSettlement] =
    useState<RuntimeSpawnSettlement | null>(null);
  const run = async (label: string, action: () => Promise<unknown>, reread = true): Promise<unknown> => {
    if (busy) return null; setBusy(true); setError(null);
    try { const result = await action(); const record = result as Record<string, unknown> | null, id = String(record?.sessionId ?? record?.opId ?? "applied"); setFeedback(t("agentRuntime.feedbackApplied", { label, id })); if (reread) await refresh(); return result; }
    catch (cause) { consumeKnownError(cause); setFeedback(null); setError(t("agentRuntime.feedbackFailed", { label, error: message(cause) })); return null; }
    finally { setBusy(false); }
  };
  const spawn = async (input: Parameters<typeof runtimeCommandClient.spawn>[1]): Promise<RuntimeSpawnSettlement | null> => {
    if (busy) return null; setBusy(true); setError(null); setSettlement(null);
    try { const result = await submitRuntimeSpawn(input, { spawn: (payload) => leaseAwareSpawn(repoId, payload), showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId), overview: () => agentRuntimeClient.overview(repoId), onPending: setSettlement }); setSettlement(result); await refresh(); return result; }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); return null; }
    finally { setBusy(false); }
  };
  return { busy, feedback, error, settlement, clearFeedback: () => { setFeedback(null); setError(null);
    }, reportError: setError, run, spawn };
}

// The dispatch-ledger panorama, narrowed to the task ids the overview already associates
// with runtime sessions (W6) and shared verbatim between the sessions and agent entries —
// one cache key, one batched task-dispatches read.
function useRuntimePanorama(repoId: string, tasks: readonly RuntimePanoramaTask[], sessions: readonly
  AgentRuntimeSessionDto[]) {
  const client = useQueryClient(), panoramaTasks = runtimePanoramaTasks(tasks, sessions);
  const squadQuery = { queryKey: ["squads", repoId], queryFn: () =>
    agentEntityClient.listSquads(repoId), staleTime: 4_000 } as const;
  return useQuery({ queryKey: ["runtime-panorama", repoId, panoramaTasks.map((task) =>
    task.taskId).join(",")], queryFn: () => readPanorama(repoId, panoramaTasks, { listSquads: () =>
    client.fetchQuery(squadQuery), getTaskDispatches: (taskIds) => harnessClient.getTaskDispatches({
    repoId, taskIds }) }), staleTime: 4_000 });
}

// 会话入口:overview + 收窄 panorama → dock rows。rail 分组、主区会话详情、inspector
// 兄弟会话全部从这两面派生;唯一的写是 cancel。
export function useSessionsWorkspace(repoId: string, tasks: readonly RuntimePanoramaTask[]) {
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ["runtime-control", repoId, "overview"], queryFn: () =>
    agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const sessions = () => overview.data?.sessions ?? [];
  const panorama = useRuntimePanorama(repoId, tasks, sessions());
  const channel = useRuntimeChannel(repoId, async () => { await Promise.all([client.invalidateQueries({
    queryKey: ["runtime-control", repoId] }), client.invalidateQueries({ queryKey: ["runtime-panorama",
    repoId] })]); });
  return { overview, panorama, dockRows: runtimeDockRows(panorama.data ?? [], sessions()), busy:
    channel.busy, feedback: channel.feedback, error: channel.error, clearFeedback: channel.clearFeedback,
    cancelSession: (runtimeSessionId: string) => channel.run(t("agentRuntime.opSessionCancelled"), () =>
      runtimeCommandClient.cancel(repoId, runtimeSessionId)) };
}

// Agent 入口(含 Squad 面):身份层读写 + 派工。兼容 Runtime 实例列表来自 machine
// 目录;dispatch 的实例校验来自 overview;inspector 的相关会话按 agentId/squadId 过滤
// panorama 行(收窄读,与会话入口共享缓存键)。
export function useAgentSquadWorkspace(repoId: string, tasks: readonly RuntimePanoramaTask[]) {
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ["runtime-control", repoId, "overview"], queryFn: () =>
    agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const agents = useQuery({ queryKey: ["agents", repoId], queryFn: () =>
    agentEntityClient.listAgents(repoId), staleTime: 4_000 });
  const squads = useQuery({ queryKey: ["squads", repoId], queryFn: () =>
    agentEntityClient.listSquads(repoId), staleTime: 4_000 });
  const machine = useQuery({ queryKey: ["runtime-instances", "machine"], queryFn:
    runtimeInstanceClient.list, staleTime: 2_000 });
  const sessions = () => overview.data?.sessions ?? [];
  const panorama = useRuntimePanorama(repoId, tasks, sessions());
  const channel = useRuntimeChannel(repoId, async () => { await Promise.all([client.invalidateQueries({
    queryKey: ["runtime-control", repoId] }), client.invalidateQueries({ queryKey: ["runtime-panorama",
    repoId] })]); });
  return { overview, agents, squads, machine, instances: machine.data?.instances ?? [], dockRows:
    runtimeDockRows(panorama.data ?? [], sessions()), busy: channel.busy, feedback: channel.feedback,
    error: channel.error, settlement: channel.settlement, clearFeedback: channel.clearFeedback,
    saveAgent: async (declaration: AgentDeclarationV1) => { const saved = await
      channel.run(t("agentRuntime.opAgentSaved"), () => agentEntityClient.saveAgent(repoId,
      declaration), false); if (saved === null) return null; await client.invalidateQueries({ queryKey:
      ["agents", repoId] }); await client.invalidateQueries({ queryKey: ["agent-detail", repoId] }); return saved; },
    saveSquad: async (declaration: SquadDeclarationV1) => { const saved = await
      channel.run(t("agentRuntime.opSquadSaved"), () => agentEntityClient.saveSquad(repoId,
      declaration), false); if (saved === null) return null; await client.invalidateQueries({ queryKey:
      ["squads", repoId] }); await client.invalidateQueries({ queryKey: ["squad-detail", repoId] }); return saved; },
    dispatch: (request: DispatchRequest) => channel.spawn(buildDispatchSpawnInput(request,
      overview.data?.instances ?? [])) };
}

// Provider 入口:实例目录 + auth 探测 + 实例读写。live 计数取 overview 的 session
// liveness(daemon 自己的在跑投影),不为此读 dispatch 台账;self-test 走与会话派工
// 同一条 spawn 收据链。agents 目录只为实例卡上的「兼容 Agents」区服务(跨页出口的
// 数据面),与 Agent 入口共享缓存键。
export function useProviderWorkspace(repoId: string) {
  const client = useQueryClient();
  const machine = useQuery({ queryKey: ["runtime-instances", "machine"], queryFn:
    runtimeInstanceClient.list, staleTime: 2_000 });
  const agents = useQuery({ queryKey: ["agents", repoId], queryFn: () =>
    agentEntityClient.listAgents(repoId), staleTime: 4_000 });
  const listedInstances = machine.data?.instances ?? [];
  const authProbes = useQueries({ queries: listedInstances.map((instance) => { const needsProbe =
    instance.authReadiness.code === "runtime_auth_not_checked"; return { queryKey:
    ["runtime-instance-auth", instance.instanceId, machine.dataUpdatedAt], queryFn: () =>
    runtimeInstanceClient.probe(instance.instanceId), enabled: needsProbe, retry: false, staleTime:
    2_000, ...(needsProbe ? {} : { initialData: instance }) }; }) });
  const instances = listedInstances.map((instance, index) => authProbes[index]?.data ?? instance);
  const authProbeErrors = new Map<string, string>(listedInstances.flatMap((instance, index) => { const
    error = authProbes[index]?.error; return error === null || error === undefined ? [] :
    [[instance.instanceId, message(error)] as const]; }));
  const overview = useQuery({ queryKey: ["runtime-control", repoId, "overview"], queryFn: () =>
    agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const liveByInstance = new Map<string, number>();
  for (const session of overview.data?.sessions ?? []) if (LIVENESS_LIVE[session.liveness])
    liveByInstance.set(session.instanceId, (liveByInstance.get(session.instanceId) ?? 0) + 1);
  const channel = useRuntimeChannel(repoId, async () => { await Promise.all([client.invalidateQueries({
    queryKey: ["runtime-instances", "machine"] }), client.invalidateQueries({ queryKey:
    ["runtime-control", repoId] })]); });
  const selfTest = async (instanceId: string, model: string): Promise<string | null> => {
    const result = await channel.spawn(runtimeSelfTestSpawnInput(instanceId, model,
      `gui-runtime-self-test-${instanceId}-${crypto.randomUUID()}`));
    if (!result?.runtimeSessionId) return null;
    try {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const snapshot = await agentRuntimeClient.session(repoId, result.runtimeSessionId);
        const successfulResult = successfulAgentRuntimeResult(snapshot);
        if (successfulResult) return successfulResult;
        if (snapshot.session.activity.outcome !== null) throw new Error(t("agentRuntime.selfTestFailed", { outcome: snapshot.session.activity.outcome }));
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      throw new Error(t("agentRuntime.selfTestTimeout"));
    } catch (cause) {
      consumeKnownError(cause); channel.reportError(t("agentRuntime.feedbackFailed", { label:
        t("agentRuntime.selfTestTitle"), error: message(cause) })); return null;
    }
  };
  return { machine, agents, instances, authProbeErrors, overview, liveByInstance, busy: channel.busy,
    feedback: channel.feedback, error: channel.error, settlement: channel.settlement, clearFeedback:
    channel.clearFeedback,
    createInstance: async (input: RuntimeInstanceCreateInput) => { const created = await
      channel.run(t("agentRuntime.opInstanceCreated"), () => runtimeInstanceClient.create(input),
      false); if (!created) return null; if (input.authMode === "subscription") { const probed = await
      channel.run(t("agentRuntime.opAuthChecked"), () => runtimeInstanceClient.probe(input.instanceId),
      false); if (subscriptionCreationNeedsLogin(input, probed)) await
      channel.run(t("agentRuntime.opSignIn"), () => runtimeInstanceClient.auth(repoId, input.instanceId,
      "login"), false); } await client.invalidateQueries({ queryKey: ["runtime-instances", "machine"]
      }); await client.invalidateQueries({ queryKey: ["runtime-control", repoId] }); return created; },
    updateInstance: (input: RuntimeInstanceUpdateInput) =>
      channel.run(t("agentRuntime.opInstanceUpdated"), () => runtimeInstanceClient.update(input)),
    setInstanceEnabled: (instanceId: string, enabled: boolean) => channel.run(t(enabled ?
      "agentRuntime.opInstanceEnabled" : "agentRuntime.opInstanceDisabled"), () =>
      runtimeInstanceClient.setEnabled(instanceId, enabled)),
    deleteInstance: (instanceId: string) => channel.run(t("agentRuntime.opInstanceDeleted"), () =>
      runtimeInstanceClient.delete(instanceId)),
    validateInstance: (instanceId: string) => channel.run(t("agentRuntime.opAuthChecked"), () =>
      runtimeInstanceClient.probe(instanceId)),
    authInstance: (instanceId: string, action: "login" | "logout") => channel.run(t(action === "logout"
      ? "agentRuntime.opSignOut" : "agentRuntime.opSignIn"), () => runtimeInstanceClient.auth(repoId,
      instanceId, action), false),
    selfTest };
}
export function runtimeSelfTestSpawnInput(instanceId: string, model: string, idempotencyKey: string) { return { runtimeInstanceId: instanceId, model, permissionMode: "read-only" as const, cwd: { scope: "repo-root" as const }, prompt: "Reply with exactly: runtime connectivity ok", taskId: null, idempotencyKey }; }

export function subscriptionCreationNeedsLogin(input: Pick<RuntimeInstanceCreateInput, "authMode">, probed: unknown): boolean { return input.authMode === "subscription" && typeof probed === "object" && probed !== null && "authState" in probed && probed.authState === "unauthenticated"; }

export function runtimePanoramaTasks(tasks: readonly RuntimePanoramaTask[], sessions: readonly AgentRuntimeSessionDto[]): readonly RuntimePanoramaTask[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task])), taskIds = new Set(sessions.flatMap((session) => session.associations.map((association) => association.taskId)));
  return [...taskIds].sort().map((taskId) => tasksById.get(taskId) ?? { taskId, title: taskId });
}

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
