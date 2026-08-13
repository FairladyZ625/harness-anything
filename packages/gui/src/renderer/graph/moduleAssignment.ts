import type { RelationEdge, TaskRow } from "../model/types";
import { endpointToNodeId } from "./endpoint";

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

/** task.module 字段里代表「未赋值」的占位值(task-adapter 硬编码)。 */
const PLACEHOLDER_MODULES = new Set(["", "unassigned", "unknown", "none"]);

/** task.module 是否为占位(未投影)。 */
export function isModuleUnprojected(module: string | undefined | null): boolean {
  if (!module) return true;
  return PLACEHOLDER_MODULES.has(module);
}

/** 把 task.module 解析成显示值:真实模块原样返回,占位返回 UNPROJECTED 哨兵。 */
export function resolveTaskModule(module: string | undefined | null): string {
  if (!module || PLACEHOLDER_MODULES.has(module)) return UNPROJECTED_MODULE;
  return module;
}

/**
 * decision 的模块:沿 derives→task 边找 host task 的 module。
 * 多条 derives 取第一个非占位的;全占位/无边 → UNPROJECTED。
 */
export function resolveDecisionModule(
  decisionRef: string,
  relations: ReadonlyArray<RelationEdge>,
  tasks: ReadonlyArray<TaskRow>,
): string {
  const decisionId = endpointToNodeId(decisionRef);
  for (const edge of relations) {
    if (edge.kind !== "derives") continue;
    if (endpointToNodeId(edge.from) !== decisionId) continue;
    const taskId = endpointToNodeId(edge.to);
    const task = tasks.find((t) => t.taskId === taskId);
    if (task && !isModuleUnprojected(task.module)) return task.module;
  }
  return UNPROJECTED_MODULE;
}

/**
 * fact 的模块:从宿主 task 的 module 派生。
 * host task 不在投影里 → UNPROJECTED(不猜)。
 */
export function resolveFactModule(
  factRef: string,
  tasks: ReadonlyArray<TaskRow>,
): string {
  // factRef 形如 fact/<taskId>/<anchor>
  const taskId = factRef.split("/")[1] ?? "";
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return UNPROJECTED_MODULE;
  return resolveTaskModule(task.module);
}

/** 渲染文案:哨兵 → 「未投影」,真实模块原样。 */
export function moduleDisplayLabel(module: string): string {
  return module === UNPROJECTED_MODULE ? "未投影" : module;
}
