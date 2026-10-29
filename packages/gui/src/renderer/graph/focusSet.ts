import type { RelationEdge, TaskRow } from "../model/types";
import { isTaskGraphFocusSeed } from "../model/taskFilters";
import { endpointToNodeId, parseEndpoint } from "./endpoint";
import { agentNodeId, type ScheduleNodeRow } from "./runtimeEntities";

/**
 * 关系图「重点模式」的重点集(纯函数)。
 *
 * 种子判定本体在 model/taskFilters.ts(isTaskGraphFocusSeed,与看板共用);
 * 这里只做图特有的闭包:种子 task 的**一跳非 task 邻居**(decision/fact/agent)。
 * task↔task 边刻意不扩 —— PLT-Ontology 根任务一跳就是 138 个子任务,
 * 扩了等于没有密度分层;子树结构留给聚光灯按跳数展开。
 *
 * schedule 与 task 之间没有直接边(Schedule 派发的是 agent,agent 再派 task),
 * 所以 schedule 经它声明的 target agent 收进邻域 —— 否则重点模式下 Schedule 块
 * 永远整块折叠,新实体等于默认不可见。
 *
 * 键空间:task 用裸 taskId,其余实体用 `<kind>/<id>`,与 ego 图/领地 chip 一致。
 */
export interface GraphFocusSelection {
  /** 重点 task id(裸 taskId)。 */
  readonly taskIds: ReadonlySet<string>;
  /** 重点非 task 节点 id(decision/<id>、fact/<id>、agent/<id>、schedule/<id>)。 */
  readonly neighborIds: ReadonlySet<string>;
  /** 种子 task 数(含 pinned;头部/徽章显示用)。 */
  readonly seedCount: number;
}

export function selectGraphFocusSet(input: {
  readonly tasks: ReadonlyArray<TaskRow>;
  readonly relations: ReadonlyArray<RelationEdge>;
  readonly now: string;
  readonly schedules?: ReadonlyArray<ScheduleNodeRow>;
}): GraphFocusSelection {
  const taskIds = new Set<string>();
  for (const task of input.tasks) {
    if (isTaskGraphFocusSeed(task, input.now)) taskIds.add(task.taskId);
  }
  const knownTasks = new Set(input.tasks.map((task) => task.taskId));
  const neighborIds = new Set<string>();
  for (const edge of input.relations) {
    const source = endpointToNodeId(edge.from),
      target = endpointToNodeId(edge.to);
    if (parseEndpoint(edge.from) === null || parseEndpoint(edge.to) === null) continue;
    // 只有「种子 task ↔ 非 task」这一种方向长邻域;两端都是 task 不扩,task 侧缺行不造节点。
    if (knownTasks.has(source) && taskIds.has(source) && !knownTasks.has(target)) neighborIds.add(target);
    if (knownTasks.has(target) && taskIds.has(target) && !knownTasks.has(source)) neighborIds.add(source);
  }
  for (const schedule of input.schedules ?? []) {
    if (schedule.targetAgentId !== null && neighborIds.has(agentNodeId(schedule.targetAgentId))) {
      neighborIds.add(schedule.id);
    }
  }
  return { taskIds, neighborIds, seedCount: taskIds.size };
}

/**
 * 节点 id 是否在重点集内。接受任意入口形态(`task/<id>` 或裸 taskId、`agent/<id>`、
 * `decision/<id>` …),内部归一到图键空间 —— 领地 chip 的 navRef 与 ego 节点 id 都能直接问。
 */
export function isInGraphFocusSet(selection: GraphFocusSelection, nodeId: string): boolean {
  const id = endpointToNodeId(nodeId);
  return selection.taskIds.has(id) || selection.neighborIds.has(id);
}
