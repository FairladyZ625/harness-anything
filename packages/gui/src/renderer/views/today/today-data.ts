import { useQuery } from "@tanstack/react-query";
import type { AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { cadenceEventOf, type CadenceFeedEvent } from "../../model/cadence.ts";
import { observeTailRequest } from "../../daemon-observe-model.ts";
import { harnessClient } from "../../api-client.ts";
import { eventsQueryKeys } from "../../overview-data.ts";

/**
 * 「重构 › 今天」页自持的读面(dec_C612E69B7C7E3480A5F9D2CAD3):议程由 App 常驻
 * 挂载、经 props 进来,这里只有两块——正在跑的会话组读与最近事件页,query key 全部
 * 并入既有家族(runtimeQueryKeys.sessionGroupsAll / 总览的 eventsQueryKeys.recent),
 * 与会话页、研发态势、总览共享缓存与台账 cut 的失效扇出,不建第二份读路。
 */

/** 正在跑:repo 级会话组读面(groupBy=task,无成员级筛选;daemon 保证 live 会话不被 since 切掉)。 */
export function useTodaySessionGroups(repoId: string | null) {
  return useQuery({
    queryKey: [...runtimeQueryKeys.sessionGroupsAll(repoId ?? "unselected"), "today", "task"],
    queryFn: (): Promise<AgentRuntimeSessionGroupsResult> =>
      agentRuntimeClient.sessionGroups(repoId ?? "unselected", { groupBy: "task" }),
    enabled: repoId !== null,
    staleTime: 4_000,
    retry: 1,
  });
}

/** 刚交付:一页 history 事件(与总览「最近变化」同一 key 同一读法,不进 follow 循环)。 */
export function useTodayRecentEvents(repoId: string | null) {
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

/** 刚交付行:最近完成任务的事件(倒序,最新在前);taskId 缺失的事件不成行。 */
export interface DeliveredRow {
  readonly key: string;
  readonly taskId: string;
  readonly at: string | null;
  readonly summary: string | null;
}

export function deliveredRows(events: readonly CadenceFeedEvent[]): readonly DeliveredRow[] {
  return events
    .filter((event) => event.type === "task_completed" && event.taskId !== null)
    .map((event) => ({
      key: event.key,
      taskId: event.taskId as string,
      at: event.at,
      // 事件摘要有时只复述内部 taskId；首屏不展示 ID，交付行退回人话默认说明。
      summary: event.summary !== null && !event.summary.includes(event.taskId as string) ? event.summary : null,
    }))
    .sort((left, right) => Date.parse(right.at ?? "") - Date.parse(left.at ?? ""));
}
