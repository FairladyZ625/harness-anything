import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  emptyEntityKindCatalog,
  readEntityKindCatalog,
  readGovernedEntityRows,
  type EntityKindCatalog,
} from "./entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "./graph/governedEntities.ts";
import type { EntityTypeOption } from "./components/GraphFilterPanel.tsx";

/**
 * 已注册 kind 清单的读 hook。GUI 的四个消费面(实体页分组、领地节点类型、
 * 筛选面板、命令面板)都从这一个 query 派生,不各留一份清单。
 */
export const entityKindQueryKeys = {
  catalog: (repoId: string) => ["entity-kinds", repoId] as const,
  rows: (repoId: string) => ["entity-rows", repoId] as const,
};

export function entityKindCatalogQuery(repoId: string) {
  return {
    queryKey: entityKindQueryKeys.catalog(repoId),
    queryFn: () => readEntityKindCatalog(repoId),
    // kind 集合只在 vertical 声明变更时改变,比投影稳定得多。
    staleTime: 60_000,
  };
}

export function useEntityKindCatalog(repoId: string): {
  readonly catalog: EntityKindCatalog;
  readonly state: "ready" | "pending" | "error";
} {
  const query = useQuery(entityKindCatalogQuery(repoId));
  if (query.isError) return { catalog: emptyEntityKindCatalog, state: "error" };
  if (query.data === undefined) return { catalog: emptyEntityKindCatalog, state: "pending" };
  return { catalog: query.data, state: "ready" };
}

/**
 * 图筛选面板的实体种类选项:只取能作为关系图节点的 kind,标签用声明里的显示名
 * (内建 kind 没有声明,沿用首字母大写的机器名——它本来就是这么显示的)。
 */
export function useEntityKindOptions(repoId: string): readonly EntityTypeOption[] {
  const { catalog } = useEntityKindCatalog(repoId);
  return useMemo(
    () =>
      catalog.kinds
        .filter(({ relationEndpoint }) => relationEndpoint)
        .map(({ kind, declaration }) => ({
          kind,
          label: declaration?.display.singular ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
        })),
    [catalog],
  );
}

/** 声明实体行读的 query 选项:面板消费与深链接预取共用同一份 key 与新鲜度。 */
export function governedEntityRowsQuery(repoId: string) {
  return {
    queryKey: entityKindQueryKeys.rows(repoId),
    queryFn: () => readGovernedEntityRows(repoId),
    staleTime: 4_000,
  };
}

const NO_GOVERNED_ROWS: readonly GovernedEntityRow[] = [];

/** 声明实体的行:领地分块与聚光灯节点的数据源。读失败/未就绪时是空,不冒充有数据。 */
export function useGovernedEntityRows(repoId: string): readonly GovernedEntityRow[] {
  const query = useQuery(governedEntityRowsQuery(repoId));
  return query.data ?? NO_GOVERNED_ROWS;
}
