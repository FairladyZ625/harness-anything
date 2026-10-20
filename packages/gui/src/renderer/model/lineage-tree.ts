import type { AgentActivity, AgentTreeNode } from "../components/agent-ui/AgentTree.tsx";
import { splitTitleFocus } from "../components/primitives/TitleText.tsx";
import type { TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import type { TaskRow } from "./types.ts";

/**
 * 血缘树构建(dec_C0AF8CBBFFECF71F4F34FB76F9 CH4/W3-T1):把任务切面 + 派工读面
 * (`repo.task.dispatches` 行)组装成 AgentTree 的节点树——Work/Task 节点来自任务切面,
 * Squad/Worker 轮次节点来自派工行,委托链用 parentRuntimeSessionId 挂在父轮下。
 *
 * 计费纪律(与 AgentTree.rollupSubtree 同一条):任务节点不虚构 own 成本(自身没有
 * Token 读数),只有派工行报 ownTokens/ownDurationMs;父级 Rollup = Σ(own),不重复计费。
 * 纯函数、无请求:数据由调用方读面喂入,运行中节点耗时随每次重渲刷新(读面轮询节拍)。
 */

/** 派工行状态 → AgentTree 活动词:blocked 停摆需要人看(awaiting),unknown/lost 归中性。 */
export function dispatchActivity(status: TaskDispatchProjectionRow["status"]): AgentActivity {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "blocked":
      return "awaiting";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "idle";
  }
}

/** 任务状态词(切面 canonicalStatus 词表)→ AgentTree 活动词:submitted/in_review 等裁决,blocked 等依赖。 */
export function taskActivity(status: TaskRow["canonicalStatus"]): AgentActivity {
  switch (status) {
    case "active":
      return "running";
    case "submitted":
    case "in_review":
    case "blocked":
      return "awaiting";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

const epochMs = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** 派工行自身耗时:已收口用 endedAt-startedAt,运行中用 now-startedAt(随轮询节拍走)。 */
export function dispatchDurationMs(row: TaskDispatchProjectionRow, nowMs: number): number | undefined {
  const started = epochMs(row.startedAt);
  if (started === null) return undefined;
  const ended = epochMs(row.endedAt);
  return Math.max(0, (ended ?? nowMs) - started);
}

/** 派工节点的身份词:执行者名 > agentId > 模型 > 实例,不虚构「Worker」占位。 */
export function dispatchRole(row: TaskDispatchProjectionRow): string {
  return row.agentName ?? row.agentId ?? row.provider?.model ?? row.instanceId;
}

export const LINEAGE_TASK_PREFIX = "task:";
export const LINEAGE_DISPATCH_PREFIX = "dispatch:";

/**
 * 根任务 + 全部子孙任务 id(parentTaskId 闭包):血缘树一次批量读的取值面。
 * 顺序稳定:子孙按 tasks 输入顺序出现,根在最前。
 */
export function lineageTaskIds(rootTaskId: string, tasks: readonly TaskRow[]): string[] {
  const childrenByParent = new Map<string, TaskRow[]>();
  for (const row of tasks) {
    if (row.parentTaskId === undefined) continue;
    const bucket = childrenByParent.get(row.parentTaskId) ?? [];
    bucket.push(row);
    childrenByParent.set(row.parentTaskId, bucket);
  }
  const ids = [rootTaskId];
  for (let index = 0; index < ids.length; index += 1) {
    for (const child of childrenByParent.get(ids[index]!) ?? []) {
      if (child.taskId !== rootTaskId && !ids.includes(child.taskId)) ids.push(child.taskId);
    }
  }
  return ids;
}

/** 节点 id → 任务实体(可寻址 task/<id>);非任务节点返回 null。 */
export function lineageTaskIdOf(nodeId: string): string | null {
  return nodeId.startsWith(LINEAGE_TASK_PREFIX) ? nodeId.slice(LINEAGE_TASK_PREFIX.length) : null;
}

/** 节点 id → 派工行(调用方从同一份 dispatches 里取回);非派工节点返回 null。 */
export function lineageDispatchOf(
  nodeId: string,
  dispatches: readonly TaskDispatchProjectionRow[],
): TaskDispatchProjectionRow | null {
  if (!nodeId.startsWith(LINEAGE_DISPATCH_PREFIX)) return null;
  const dispatchId = nodeId.slice(LINEAGE_DISPATCH_PREFIX.length);
  return dispatches.find((row) => row.dispatchId === dispatchId) ?? null;
}

function taskNode(row: TaskRow, children: readonly AgentTreeNode[]): AgentTreeNode {
  return {
    id: `${LINEAGE_TASK_PREFIX}${row.taskId}`,
    role: splitTitleFocus(row.title).focus,
    status: taskActivity(row.canonicalStatus),
    ...(children.length > 0 ? { children } : {}),
  };
}

function dispatchNode(
  row: TaskDispatchProjectionRow,
  nowMs: number,
  children: readonly AgentTreeNode[],
): AgentTreeNode {
  return {
    id: `${LINEAGE_DISPATCH_PREFIX}${row.dispatchId}`,
    role: dispatchRole(row),
    ...(row.provider?.model ? { model: row.provider.model } : {}),
    status: dispatchActivity(row.status),
    ownTokens: row.metrics?.totalTokens,
    ownDurationMs: dispatchDurationMs(row, nowMs),
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * 组装根任务的血缘树:子孙任务按 parentTaskId 递归挂接;每 个任务下的派工行按
 * parentRuntimeSessionId 组成委托链(父轮不在批次内时挂回任务节点,不丢节点)。
 * 同任务内同 runtimeSessionId 的多轮派工(重试链)各占一节,attemptIndex/startedAt 稳定排序。
 */
export function buildLineageTree(input: {
  readonly rootTask: TaskRow;
  /** 全仓任务切面(子孙从中筛);根任务自身以 rootTask 为准。 */
  readonly tasks: readonly TaskRow[];
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly nowMs: number;
}): AgentTreeNode {
  const childrenByParent = new Map<string, TaskRow[]>();
  for (const row of input.tasks) {
    if (row.parentTaskId === undefined || row.taskId === input.rootTask.taskId) continue;
    const bucket = childrenByParent.get(row.parentTaskId) ?? [];
    bucket.push(row);
    childrenByParent.set(row.parentTaskId, bucket);
  }

  const dispatchesByTask = new Map<string, TaskDispatchProjectionRow[]>();
  for (const row of input.dispatches) {
    const bucket = dispatchesByTask.get(row.taskId) ?? [];
    bucket.push(row);
    dispatchesByTask.set(row.taskId, bucket);
  }

  const subtreeOf = (row: TaskRow): AgentTreeNode => {
    const childTasks = (childrenByParent.get(row.taskId) ?? [])
      .sort((left, right) => {
        const byCreated = (epochMs(left.createdAt) ?? 0) - (epochMs(right.createdAt) ?? 0);
        return byCreated !== 0 ? byCreated : left.taskId.localeCompare(right.taskId);
      })
      .map(subtreeOf);
    return taskNode(row, [...childTasks, ...dispatchChainsOf(row.taskId)]);
  };

  const dispatchChainsOf = (taskId: string): readonly AgentTreeNode[] => {
    const rows = (dispatchesByTask.get(taskId) ?? []).slice().sort((left, right) => {
      const byAttempt = left.attemptIndex - right.attemptIndex;
      if (byAttempt !== 0) return byAttempt;
      const byStarted = (epochMs(left.startedAt) ?? 0) - (epochMs(right.startedAt) ?? 0);
      return byStarted !== 0 ? byStarted : left.dispatchId.localeCompare(right.dispatchId);
    });
    // 委托链按行挂接(不预建节点对象):parentRuntimeSessionId 指向的父轮在批次内就挂其下,
    // 根轮(无父或父轮不在批次)直接挂任务节点;emit 递归一次成型,中继轮不产生分叉副本。
    const childRowsOf = new Map<string, TaskDispatchProjectionRow[]>();
    const sessionToDispatch = new Map(rows.map((row) => [row.runtimeSessionId, row]));
    const roots: TaskDispatchProjectionRow[] = [];
    for (const row of rows) {
      const parentDispatch =
        row.parentRuntimeSessionId !== undefined ? sessionToDispatch.get(row.parentRuntimeSessionId) : undefined;
      if (parentDispatch !== undefined && parentDispatch.dispatchId !== row.dispatchId) {
        const bucket = childRowsOf.get(parentDispatch.dispatchId) ?? [];
        bucket.push(row);
        childRowsOf.set(parentDispatch.dispatchId, bucket);
      } else roots.push(row);
    }
    const emit = (row: TaskDispatchProjectionRow): AgentTreeNode =>
      dispatchNode(row, input.nowMs, (childRowsOf.get(row.dispatchId) ?? []).map(emit));
    return roots.map(emit);
  };

  return subtreeOf(input.rootTask);
}
