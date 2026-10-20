import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRuntimeOverviewResult, AgentRuntimeSessionGroupDto } from "@harness-anything/daemon/protocol";
import { artifactsClient, artifactsQueryKeys } from "./artifacts-client.ts";
import { harnessClient, type TaskDispatchMemberRead } from "./api-client.ts";
import { agentRuntimeClient, pollSessionEventsOnce, runtimeQueryKeys } from "./agent-runtime-client.ts";
import { cadenceEventOf, type CadenceFeedEvent } from "./model/cadence.ts";
import { observeTailRequest } from "./daemon-observe-model.ts";
import { AGENT_LANES_ACTIVE_AGENTS, AGENT_LANES_MEMBER_PAGE, AGENT_LANES_WINDOW_MS } from "./views/overview-model.ts";
import { QUERY_PACING_MS } from "./query-pacing.ts";
import { sessionEventTimeline } from "./sessions-model.ts";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";

/**
 * 总览(S3)自持的读面 + 复用的 runtime overview 读:都只挂在总览页挂载期间,
 * 且都有界(CI 观察窗 ≤30 run;事件一页 history,不进 follow 循环)。agenda、工作索引、
 * 台账摘要由 App 常驻挂载,经 props 进来。
 */

const eventsQueryKeys = {
  recent: (repoId: string) => ["overview-recent-events", repoId] as const,
};

/** 最近变化:一页 history(最新端,升序),不跟流——总览不做事件 follow 循环(cadence 页才做)。
 * 事件页只喂给与工作页共用的 workDayGroups 收束;runtime_* 等内部事件不产步骤,不进总览。 */
export function useOverviewRecentEvents(repoId: string | null) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: eventsQueryKeys.recent(selectedRepoId),
    queryFn: async () => {
      const page = await harnessClient.tailObservability(observeTailRequest(selectedRepoId, "events", "history", null));
      if (page.status === "unavailable") return [] as readonly CadenceFeedEvent[];
      return page.items.map((item) => cadenceEventOf(item)) as readonly CadenceFeedEvent[];
    },
    enabled: repoId !== null,
    staleTime: 30_000,
    retry: 1,
  });
}

/** repo 级 runtime overview 的读法(只含未退出的会话):总览与项目管理页共用同一 key 去重。 */
export function overviewRuntimeQuery(repoId: string) {
  return {
    queryKey: runtimeQueryKeys.overviewAll(repoId),
    queryFn: (): Promise<AgentRuntimeOverviewResult> => agentRuntimeClient.overview(repoId),
    staleTime: 4_000,
  };
}

/** 执行中:repo 级 runtime overview(与研发态势同一读面,key 共享去重;cut 扇出覆盖)。 */
export function useOverviewRuntime(repoId: string | null) {
  return useQuery({ ...overviewRuntimeQuery(repoId ?? "unselected"), enabled: repoId !== null });
}

/**
 * 最新 HTML 产物速览架的读面(task_8a83698):与产物页共用同一条 `repo.artifacts.list`
 * 缓存(artifactsQueryKeys 同 key),台账 cut 扇出失效它,这里不立任何轮询。
 */
export function useOverviewArtifacts(repoId: string | null) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: artifactsQueryKeys.list(selectedRepoId, "html"),
    queryFn: () => artifactsClient.list(selectedRepoId, "html"),
    enabled: repoId !== null,
    staleTime: 60_000,
    gcTime: 300_000,
    retry: 1,
  });
}

/* ------------------------------------------------------------------ Agent 泳道读面(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2/CH4) */

/**
 * 泳道读面的三段组合(W2-T1):① sessionGroups 按 agent 分组的一次聚合读给泳道集合;
 * ② runningCount>0 的活跃 agent 各读一页成员派工(有界扇,任务块的真 startedAt/endedAt
 * 与跨 Agent 委托边只有派工行上有);③ 运行块的会话各读一条增量事件流,给块内
 * CacheTimer 的触达时间。三段全部骑既有 query key 家族(dispatches / session-groups /
 * runtime-session-events),台账 cut 的失效扇出与别的视图共享同一份缓存。
 */

/** ① 泳道集合:sessionGroups(groupBy=agent,6h 窗)。 */
export function useOverviewAgentGroups(repoId: string | null) {
  // since 进 key:窗口锚点在挂载期固定,不随渲染漂移(每帧新 key 会变成持续重取)。
  const since = useMemo(
    () => new Date(Date.now() - AGENT_LANES_WINDOW_MS).toISOString(),
    // 窗口锚点按仓库切换重置一次,其余渲染复用同一锚点(同一 key 命中同一缓存)。
    [repoId],
  );
  const q = useQuery({
    queryKey: [...runtimeQueryKeys.sessionGroupsAll(repoId ?? "unselected"), "agent", since, "overview-lanes"],
    queryFn: () => agentRuntimeClient.sessionGroups(repoId!, { groupBy: "agent", since, limit: 60 }),
    enabled: repoId !== null,
    staleTime: 4_000,
  });
  return q;
}

/** 读成员页的活跃 agent(超窗截断,截断即泳道少画,不猜)。纳入在跑或挂待批/阻塞(awaits/blocked)的 agent。 */
export function activeAgentIdsOf(
  groups: readonly AgentRuntimeSessionGroupDto[],
  hasAwaits?: ReadonlyMap<string, unknown> | ReadonlySet<string> | ((group: AgentRuntimeSessionGroupDto) => boolean),
): readonly { readonly agentId: string; readonly runningCount: number }[] {
  const isAwaitingOrBlocked = (group: AgentRuntimeSessionGroupDto): boolean => {
    if (group.latestStatus === "blocked" || group.latestRound?.status === "blocked") return true;
    if (hasAwaits === undefined) return false;
    if (typeof hasAwaits === "function") return hasAwaits(group);
    if (group.taskId !== undefined) {
      return hasAwaits instanceof Set ? hasAwaits.has(group.taskId) : hasAwaits.has(group.taskId);
    }
    return false;
  };

  return groups
    .filter((group) => group.agentId !== undefined && (group.runningCount > 0 || isAwaitingOrBlocked(group)))
    .sort((left, right) => {
      const leftAwaiting = isAwaitingOrBlocked(left);
      const rightAwaiting = isAwaitingOrBlocked(right);
      return (
        Number(rightAwaiting) - Number(leftAwaiting) ||
        right.runningCount - left.runningCount ||
        right.latestActivityAt.localeCompare(left.latestActivityAt)
      );
    })
    .slice(0, AGENT_LANES_ACTIVE_AGENTS)
    .map((group) => ({ agentId: group.agentId!, runningCount: group.runningCount }));
}

/** ② 活跃 agent 的成员派工页(repo.task.dispatches 的 agent 选择器,一次一页)。 */
export function useOverviewAgentMemberPages(
  repoId: string,
  agents: readonly { readonly agentId: string }[],
): ReadonlyMap<
  string,
  { readonly rows: readonly TaskDispatchProjectionRow[]; readonly titleOf: ReadonlyMap<string, string> }
> {
  const queries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: [...runtimeQueryKeys.dispatchesAll(repoId), "agent", agent.agentId, AGENT_LANES_MEMBER_PAGE],
      queryFn: async () => {
        const page = (await harnessClient.getTaskDispatches({
          repoId,
          agentId: agent.agentId,
          limit: AGENT_LANES_MEMBER_PAGE,
        })) as TaskDispatchMemberRead;
        return {
          rows: page.dispatches as readonly TaskDispatchProjectionRow[],
          titleOf: new Map(page.taskLabels.map((label) => [label.taskId, label.title] as const)),
        };
      },
      staleTime: 4_000,
    })),
  });
  return useMemo(() => {
    const pages = new Map<
      string,
      { rows: readonly TaskDispatchProjectionRow[]; titleOf: ReadonlyMap<string, string> }
    >();
    agents.forEach((agent, index) => {
      const data = queries[index]?.data;
      if (data !== undefined) pages.set(agent.agentId, data);
    });
    return pages;
  }, [agents, queries]);
}
export function useOverviewSessionTouches(
  repoId: string,
  runtimeSessionIds: readonly string[],
): ReadonlyMap<string, number | null> {
  const queryClient = useQueryClient();
  const queries = useQueries({
    queries: runtimeSessionIds.map((runtimeSessionId) => ({
      queryKey: runtimeQueryKeys.events(repoId, runtimeSessionId),
      queryFn: () => pollSessionEventsOnce(queryClient, repoId, runtimeSessionId),
      staleTime: 4_000,
      // 缓存触达/状态推进发生在派工流里,不一定推台账 cut:挂载期低频自持节拍(与
      // tokenUsage 同档),离开总览即停。
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    })),
  });
  return useMemo(() => {
    const touches = new Map<string, number | null>();
    runtimeSessionIds.forEach((runtimeSessionId, index) => {
      const events = queries[index]?.data?.events;
      if (events === undefined) return;
      touches.set(runtimeSessionId, sessionEventTimeline(events).lastCacheTouchAt);
    });
    return touches;
  }, [runtimeSessionIds, queries]);
}

export { eventsQueryKeys };
