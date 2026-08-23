import type { ViewId } from "./viewHistory.ts";

/**
 * 实体引用 → 详情路由(W4):Fact 与 Decision 有自己的可寻址详情页,
 * 「打开详情」不再落在列表页。task 的详情页是既有 selectedId 路由(TaskDetailView),
 * 不经此映射。
 *
 * 纯函数,供 App 的 navigateLocalEntity 与测试共用。
 */

export interface EntityDetailTarget {
  view: ViewId;
  focusedEntityRef: string;
}

/** decision/<id> → 决策详情页;fact/<taskId>/<anchor> → 事实详情页;其余 → null。 */
export function entityDetailTargetOf(ref: string): EntityDetailTarget | null {
  if (ref.startsWith("decision/")) {
    const decisionId = ref.split("/")[1];
    if (!decisionId) return null;
    return { view: "decisionDetail", focusedEntityRef: `decision/${decisionId}` };
  }
  if (ref.startsWith("fact/")) {
    return { view: "factDetail", focusedEntityRef: ref };
  }
  return null;
}
