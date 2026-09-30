import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CiObservatoryRead } from "../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import { harnessClient } from "./api-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "./agent-runtime-client.ts";
import { cadenceEventOf, type CadenceFeedEvent } from "./model/cadence.ts";
import { observeTailRequest } from "./daemon-observe-model.ts";

/**
 * 总览(S3)自持的两条读面 + 复用的 runtime overview 读:都只挂在总览页挂载期间,
 * 且都有界(CI 观察窗 ≤30 run;事件一页 history,不进 follow 循环)。agenda、工作索引、
 * 台账摘要由 App 常驻挂载,经 props 进来。
 */

const ciQueryKeys = {
  observatory: (repoId: string) => ["ci-observatory", repoId] as const,
};

export function useOverviewCi(repoId: string | null): UseQueryResult<CiObservatoryRead, Error> {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: ciQueryKeys.observatory(selectedRepoId),
    queryFn: (): Promise<CiObservatoryRead> => harnessClient.getCiObservatory({ repoId: selectedRepoId, window: 30 }),
    enabled: repoId !== null,
    // CI run 观察是 canonical 事件,台账 cut 扇出会失效这个 key;这里只给一个兜底陈旧窗。
    staleTime: 60_000,
    retry: 1,
  });
}

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

/** 执行中:repo 级 runtime overview(与研发态势同一读面,key 共享去重;cut 扇出覆盖)。 */
export function useOverviewRuntime(repoId: string | null) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: runtimeQueryKeys.overviewAll(selectedRepoId),
    queryFn: (): Promise<AgentRuntimeOverviewResult> => agentRuntimeClient.overview(selectedRepoId),
    enabled: repoId !== null,
    staleTime: 4_000,
  });
}

export { ciQueryKeys, eventsQueryKeys };
