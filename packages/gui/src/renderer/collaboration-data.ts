import { useQuery } from "@tanstack/react-query";
import { agentRuntimeClient, runtimeQueryKeys } from "./agent-runtime-client.ts";
import { agentIndexOfSessionGroups, EMPTY_SESSION_AGENT_INDEX, type SessionAgentIndex } from "./model/collaboration.ts";

/** groupBy=agent 的组上限:与会话页 SESSION_GROUPS_PAGE_LIMIT 同一档,覆盖单仓声明 Agent 全集。 */
const COLLABORATION_AGENT_GROUPS_LIMIT = 1000;

/**
 * 协作页的会话→Agent 索引读面(task_1bafbf09 返工):runtime-session-groups 的
 * groupBy=agent 一条读,Agent 维度由 daemon 侧 dispatch 行 agentId 权威绑定。
 * query key 并入 sessionGroupsAll 家族,与会话页/研发态势共享缓存与台账 cut 的
 * 失效扇出,不建第二份快照;只在协作页挂载且非纯本地时读。
 */
export function useCollaborationAgentIndex(repoId: string | null, enabled: boolean): SessionAgentIndex {
  const selectedRepoId = repoId ?? "unselected",
    query = useQuery({
      queryKey: [...runtimeQueryKeys.sessionGroupsAll(selectedRepoId), "collaboration", "agent"],
      queryFn: () =>
        agentRuntimeClient.sessionGroups(selectedRepoId, {
          groupBy: "agent",
          since: "1970-01-01T00:00:00.000Z",
          limit: COLLABORATION_AGENT_GROUPS_LIMIT,
        }),
      enabled: enabled && repoId !== null,
      staleTime: 4_000,
    });
  return query.data === undefined ? EMPTY_SESSION_AGENT_INDEX : agentIndexOfSessionGroups(query.data);
}
