import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { promptCacheTtlMsForKind } from "./smart-attention.ts";

/**
 * 会话页 Prompt Cache TTL 的读面:TTL 口径(kindId + definitionSnapshot.baseUrl)的唯一
 * 读源是任务范围 overview 的会话行。任务集由调用方给出——非钻入 = 已展开的任务组,
 * 钻入 = 钻入窗口的任务组(钻入行来自派工行,自身不带 kindId,不读就查不到口径,
 * 行级倒计时会在钻入态整段消失)。查询骑既有 overview key 家族,与展开组读共享缓存。
 */
export function useTaskSessionCacheTtl(
  repoId: string,
  taskIds: readonly string[],
): ReadonlyMap<string, readonly AgentRuntimeSessionDto[]> {
  const taskSessionQueries = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: runtimeQueryKeys.overview(repoId, taskId),
      queryFn: () => agentRuntimeClient.overview(repoId, taskId),
      staleTime: 4_000,
    })),
  });
  return useMemo(() => {
    const sessionsByTask = new Map<string, readonly AgentRuntimeSessionDto[]>();
    taskIds.forEach((taskId, index) => {
      const data = taskSessionQueries[index]?.data;
      if (data !== undefined) sessionsByTask.set(taskId, data.sessions);
    });
    return sessionsByTask;
  }, [taskIds, taskSessionQueries]);
}

/** 会话 → 该 provider 的缓存 TTL:任务范围 overview 的会话行(含完整历史)合上选中
 * 会话快照;查不到口径为 null,不虚构倒计时。 */
export function sessionCacheTtlOf(
  taskSessionsByTask: ReadonlyMap<string, readonly AgentRuntimeSessionDto[]>,
  selected: AgentRuntimeSessionDto | null | undefined,
): ReadonlyMap<string, number | null> {
  const ttls = new Map<string, number | null>();
  for (const sessions of taskSessionsByTask.values()) {
    for (const session of sessions) {
      ttls.set(session.runtimeSessionId, promptCacheTtlMsForKind(session.kindId, session.definitionSnapshot?.baseUrl));
    }
  }
  if (selected)
    ttls.set(selected.runtimeSessionId, promptCacheTtlMsForKind(selected.kindId, selected.definitionSnapshot?.baseUrl));
  return ttls;
}
