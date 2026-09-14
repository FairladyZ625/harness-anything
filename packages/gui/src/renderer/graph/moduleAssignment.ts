import type { RelationEdge, TaskRow } from "../model/types";

/**
 * 诚实模块解析(REQ-GUI-03 验收硬项:缺字段显示「未投影」,不假分组)。
 *
 * task.module 是 U-02 裁定的 canonical 字段;当前 task-adapter 在字段缺失时
 * 填 "unassigned"(S2 placement 子门留到 U-02 落地)。本模块把 "unassigned"/空
 * 统一解析成 UNPROJECTED 哨兵,渲染侧显示「未投影」,严禁默认成 kernel 等真实模块。
 *
 * decision 的模块从 derives→task 边派生:找到 host task 则用其 module,否则 UNPROJECTED。
 * fact 的模块从宿主 task 派生:host task 不在投影里则 UNPROJECTED。
 */

/** 内部哨兵:字段未投影。渲染侧翻成「未投影」文案。 */
export const UNPROJECTED_MODULE = "__unprojected__";

/** task.module 字段里代表「未赋值」的占位值:task-adapter 在 moduleKeys 为空时写它。 */
const UNASSIGNED_MODULE = "unassigned";

/** task.module 是否为占位(未投影)。 */
export function isModuleUnprojected(module: string | undefined | null): boolean {
  return !module || module === UNASSIGNED_MODULE;
}

/** 把 task.module 解析成显示值:真实模块原样返回,占位返回 UNPROJECTED 哨兵。 */
export function resolveTaskModule(module: string | undefined | null): string {
  return !module || module === UNASSIGNED_MODULE ? UNPROJECTED_MODULE : module;
}

/**
 * fact 的模块:从宿主 task 派生。
 * 宿主 task 在场且有真实模块 → 该模块;
 * 宿主 task 在场且已聚簇进 PRD 块 → 随宿主归属 PRD 根(以 task chip 的 rootId 语义为准);
 * 宿主 task 不在或未投影 → UNPROJECTED。
 */
export function resolveFactModule(
  factRef: string,
  tasks: ReadonlyArray<TaskRow>,
  relations: ReadonlyArray<RelationEdge> = [],
): string {
  // Fact ownership is supplied by the produces edge; standalone facts are unprojected.
  const canonicalRef = factRef.startsWith("fact/") ? factRef : `fact/${factRef}`;
  const taskId = relations
    .find((edge) => edge.kind === "produces" && edge.to === canonicalRef && edge.from.startsWith("task/"))
    ?.from.slice("task/".length);
  if (!taskId) return UNPROJECTED_MODULE;
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return UNPROJECTED_MODULE;
  if (!isModuleUnprojected(task.module)) return task.module;

  // 宿主无模块但已聚簇进 PRD 块:跟随宿主落点,与 task chip 的 rootId 语义一致
  let current: TaskRow | undefined = task;
  const seen = new Set<string>();
  while (current) {
    if (current.rootTaskId) return current.rootTaskId;
    if (!current.parentTaskId) return current.taskId;
    if (seen.has(current.taskId)) break;
    seen.add(current.taskId);
    current = tasks.find((t) => t.taskId === current!.parentTaskId);
  }
  return UNPROJECTED_MODULE;
}

/**
 * 判定 Fact 在领地视图中是否可见:
 * 宿主 task 被归档/状态过滤隐藏时随宿主一起隐藏, 不降级成未投影;
 * 没有宿主 task 的 fact 仍保持可见(计入未投影)。
 */
export function isFactVisibleWithHost(
  factRef: string,
  visibleTaskIds: ReadonlySet<string>,
  allTaskIds: ReadonlySet<string>,
  relations: ReadonlyArray<RelationEdge>,
): boolean {
  const canonicalRef = factRef.startsWith("fact/") ? factRef : `fact/${factRef}`;
  const ownerTaskId = relations
    .find((edge) => edge.kind === "produces" && edge.to === canonicalRef && edge.from.startsWith("task/"))
    ?.from.slice("task/".length);
  if (!ownerTaskId) return true; // 无宿主 fact 保持可见
  if (!allTaskIds.has(ownerTaskId)) return true; // 宿主不在台账任务全集中的独立 fact 保持可见
  return visibleTaskIds.has(ownerTaskId); // 宿主在台账中: 随宿主可见性
}

/** 渲染文案:哨兵 → 「未投影」,真实模块原样。 */
export function moduleDisplayLabel(module: string): string {
  return module === UNPROJECTED_MODULE ? "未投影" : module;
}
