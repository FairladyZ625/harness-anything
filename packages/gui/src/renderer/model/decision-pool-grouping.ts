import type { DecisionRow } from "./types.ts";

/**
 * 决策池分组(REQ-GUI-06 PLT 分组;参考老 main 线 decision-pool-helpers.groupRows)。
 *
 * rebuild 的池视图已有 productLine 过滤(remote control-list);分组纯前端从
 * decision.appliesTo.productLines 派生,多 PLT 决策在每个 PLT 组各计一次,
 * 未投影 PLT 显式成组,绝不伪装成某条产品线。
 */

export type PoolGroupBy = "none" | "productLine" | "vertical";

export const UNASSIGNED_GROUP = "__unassigned__";

export interface DecisionGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly DecisionRow[];
}

export function groupDecisions(
  rows: readonly DecisionRow[],
  groupBy: PoolGroupBy,
): readonly DecisionGroup[] {
  if (groupBy === "none") return [{ key: "all", title: "", rows }];
  const buckets = new Map<string, DecisionRow[]>();
  for (const row of rows) {
    const keys =
      groupBy === "productLine"
        ? (row.appliesTo?.productLines ?? []).length > 0
          ? [...(row.appliesTo?.productLines ?? [])]
          : [UNASSIGNED_GROUP]
        : [row.vertical ?? UNASSIGNED_GROUP];
    for (const key of keys) {
      const list = buckets.get(key) ?? [];
      list.push(row);
      buckets.set(key, list);
    }
  }
  return [...buckets.entries()]
    .sort(([aKey, aRows], [bKey, bRows]) => {
      // 未投影组沉底,不占 C 位。
      const aUn = aKey === UNASSIGNED_GROUP ? 1 : 0, bUn = bKey === UNASSIGNED_GROUP ? 1 : 0;
      if (aUn !== bUn) return aUn - bUn;
      if (aRows.length !== bRows.length) return bRows.length - aRows.length;
      return aKey.localeCompare(bKey);
    })
    .map(([key, grouped]) => ({
      key,
      title: key === UNASSIGNED_GROUP ? (groupBy === "productLine" ? "未投影 PLT" : "未知 vertical") : key,
      rows: grouped,
    }));
}
