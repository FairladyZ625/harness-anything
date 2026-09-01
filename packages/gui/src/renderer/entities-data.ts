import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";
import { agentEntityClient } from "./agent-entity-client.ts";
import { schedulesClient } from "./schedules-client.ts";
import { catalogQueryKeys } from "./catalog-data.ts";
import { workspaceSummaryQuery } from "./workspace-summary-data.ts";
import { triadicQueryKeys } from "./triadic-data.ts";
import type { RelationFactSummaryRow } from "./api-client.ts";

/**
 * 实体说明面的活行数读面:全部复用既有读与既有 queryKey(共享缓存、共享
 * ledger 失效),本模块不新造任何读方法。hook 只在说明面挂载时被调用——
 * 没人看这个面就不请求(与 triadic 读面同一纪律)。
 */

export type EntityLiveCountSource = "tasks" | "decisions" | "agents" | "squads" | "schedules" | "presets" | "adapters";

export interface EntityLiveCount {
  /** 读失败 = 该面缺席,不冒充 0;视图如实显示读取失败。 */
  readonly state: "ready" | "pending" | "error";
  readonly count: number | null;
}

export type EntityLiveCounts = Readonly<Record<EntityLiveCountSource, EntityLiveCount>>;

interface LiveQuery {
  readonly data?: unknown;
  readonly isError: boolean;
}

export function useEntityLiveCounts(repoId: string): EntityLiveCounts {
  const workspace = useQuery(workspaceSummaryQuery(repoId));
  const agents = useQuery({
    queryKey: ["agents", repoId],
    queryFn: () => agentEntityClient.listAgents(repoId),
    staleTime: 4_000,
  });
  const squads = useQuery({
    queryKey: ["squads", repoId],
    queryFn: () => agentEntityClient.listSquads(repoId),
    staleTime: 4_000,
  });
  const schedules = useQuery({
    queryKey: ["schedules", repoId],
    queryFn: () => schedulesClient.list(repoId),
    staleTime: 2_000,
  });
  const catalog = useQuery({
    queryKey: catalogQueryKeys.snapshot(repoId),
    queryFn: () => harnessClient.getCatalogSnapshot({ repoId }),
    staleTime: 10_000,
  });
  const of = (query: LiveQuery, pick: (data: unknown) => number): EntityLiveCount =>
    query.isError
      ? { state: "error", count: null }
      : query.data === undefined
        ? { state: "pending", count: null }
        : { state: "ready", count: pick(query.data) };
  return {
    tasks: of(workspace, (data) => countOf((data as { tasks: { total: number } }).tasks.total)),
    decisions: of(workspace, (data) => countOf((data as { decisions: { total: number } }).decisions.total)),
    agents: of(agents, (data) => countOf((data as unknown[]).length)),
    squads: of(squads, (data) => countOf((data as unknown[]).length)),
    schedules: of(schedules, (data) => countOf((data as { schedules: unknown[] }).schedules.length)),
    presets: of(catalog, (data) => countOf((data as { presets: unknown[] }).presets.length)),
    adapters: of(catalog, (data) => countOf((data as { adapters: unknown[] }).adapters.length)),
  };
}

function countOf(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export interface FactFacetStats {
  readonly state: "ready" | "pending" | "error";
  readonly total: number | null;
  /** memoryClass 在读面上的折叠:semantic→lesson、procedural→progress、episodic→finding。 */
  readonly byCategory: ReadonlyArray<{ readonly category: RelationFactSummaryRow["category"]; readonly count: number }>;
  readonly domainTypes: ReadonlyArray<{
    readonly domainType: string;
    readonly registeredByFactId: string;
  }>;
}

/**
 * Fact 详情的实况切面:与 ⌘K 面板同一条 facts 切面读(同一 queryKey,共享缓存
 * 与失效)。只在 Fact 实体详情打开时启用——这是本面唯一的大读(约 1 MB 量级),
 * 不为目录页的计数去拉它。
 */
export function useFactFacetStats(repoId: string, enabled: boolean): FactFacetStats {
  const query = useQuery({
    queryKey: triadicQueryKeys.facts(repoId),
    queryFn: () => harnessClient.getRelationFacts({ repoId, facet: "facts" }),
    enabled,
    staleTime: 10_000,
  });
  return useMemo(() => {
    if (query.isError) return { state: "error", total: null, byCategory: [], domainTypes: [] };
    if (query.data === undefined) return { state: "pending", total: null, byCategory: [], domainTypes: [] };
    const facts = query.data.facts,
      counts = new Map<RelationFactSummaryRow["category"], number>();
    for (const fact of facts) counts.set(fact.category, (counts.get(fact.category) ?? 0) + 1);
    return {
      state: "ready",
      total: facts.length,
      byCategory: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
      domainTypes: query.data.domainTypes,
    };
  }, [query.data, query.isError]);
}
