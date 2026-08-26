import type { ViewId } from "./viewHistory.ts";

/**
 * 实体引用 → 详情路由(W4):Fact 与 Decision 有自己的可寻址详情页,
 * 「打开详情」不再落在列表页。task 的详情页是既有 selectedId 路由(TaskDetailView),
 * 不经此映射。
 *
 * W6 IA 拆分:运行时实体也走可寻址路由——agent/squad 归「Agent · 含 Squad」入口
 * (Squad 是该页的一个面,不是第四入口),provider(Runtime 实例)归「Provider」,
 * session 归「会话」。会话页重构追加 tasksessions/<taskId> 落点(单会话段 Task
 * 分组展开该任务组,Task 详情反向入口)。页内选择与跨入口跳转共用同一条推栈路径,
 * 导航回撤原路返回。
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
  if (ref.startsWith("agent/") || ref.startsWith("squad/")) {
    return { view: "agentSquad", focusedEntityRef: ref };
  }
  if (ref.startsWith("provider/")) {
    return { view: "providers", focusedEntityRef: ref };
  }
  if (ref.startsWith("session/")) {
    return { view: "sessions", focusedEntityRef: ref };
  }
  // 会话页的 Task 详情反向入口只落单会话段并展开该任务组;小队编排当前没有跨页
  // producer,因此不预埋对应的 consumer 路由。
  if (ref.startsWith("tasksessions/")) {
    const id = ref.split("/")[1];
    if (!id) return null;
    return { view: "sessions", focusedEntityRef: ref };
  }
  return null;
}
