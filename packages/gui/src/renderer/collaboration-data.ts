import { useQuery } from "@tanstack/react-query";
import { agentRuntimeClient, runtimeQueryKeys } from "./agent-runtime-client.ts";
import { agentIndexOfSessionGroups, EMPTY_SESSION_AGENT_INDEX, type SessionAgentIndex } from "./model/collaboration.ts";
import { leaseRuntimeSessionIdOf, type CollaborationTask } from "./model/collaboration.ts";

/**
 * 协作页的会话→Agent 索引读面(task_1bafbf09 返工):runtime-session-groups 的
 * groupBy=agent 一条读,Agent 维度由仓库派工事件中的 agentId 权威绑定。
 * query key 并入 sessionGroupsAll 家族,与会话页/研发态势共享缓存与台账 cut 的
 * 失效扇出,不建第二份快照;只在协作页挂载且非纯本地时读。
 */
export function useCollaborationAgentIndex(
  repoId: string | null,
  enabled: boolean,
  tasks: readonly CollaborationTask[],
): { readonly index: SessionAgentIndex; readonly error: string | null; readonly loading: boolean } {
  const sessionIds = [
      ...new Set(
        tasks.flatMap((task) => {
          if (task.leasePhase === "released") return [];
          const id = leaseRuntimeSessionIdOf(task.leaseActor);
          return id === null ? [] : [id];
        }),
      ),
    ].sort(),
    selectedRepoId = repoId ?? "unselected",
    query = useQuery({
      queryKey: [...runtimeQueryKeys.sessionGroupsAll(selectedRepoId), "collaboration", "agent", sessionIds],
      queryFn: () =>
        agentRuntimeClient.sessionGroups(selectedRepoId, {
          groupBy: "agent",
          since: "1970-01-01T00:00:00.000Z",
          limit: 1,
          sessionIds,
        }),
      enabled: enabled && repoId !== null && sessionIds.length > 0,
      staleTime: 4_000,
    });
  return {
    index:
      query.isError || query.data === undefined ? EMPTY_SESSION_AGENT_INDEX : agentIndexOfSessionGroups(query.data),
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    loading: query.isPending && query.fetchStatus === "fetching",
  };
}
