import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import { isTaskGraphFocusSeed, isWithinGraphFocusRecency } from "../model/taskFilters";
import { endpointToNodeId, parseEndpoint } from "./endpoint";
import { agentNodeId, type ScheduleNodeRow } from "./runtimeEntities";

/**
 * 关系图「重点模式」的重点集(纯函数)。
 *
 * 种子判定按实体自身适用同一句话(pinned ∪ 非终态 ∪ 最近 14 天变更):
 * - task 的判定本体在 model/taskFilters.ts(isTaskGraphFocusSeed,与看板共用);
 * - fact 没有状态与 pin 行字段 → 最近 14 天观察到的即种子,置顶的经唯一 pin 读面传入;
 * - decision 的非终态按自己的状态词表(kernel `isTerminalDecisionState`:只有 proposed
 *   还在等裁决),其余按 lastChangedAt 的 14 天窗口;
 * - 置顶(taskRow.pinned / agenda `pinned_entities`)对三类实体都恒为种子。
 *
 * 图特有的闭包只保留一处:种子 task 的**一跳非 task 邻居**(decision/fact/agent)。
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
  /** 自身满足重点判定的 fact/decision 节点 id。 */
  readonly entitySeedIds: ReadonlySet<string>;
  /** 种子 task 的一跳非 task 邻居 id(decision/<id>、fact/<id>、agent/<id>、schedule/<id>)。 */
  readonly neighborIds: ReadonlySet<string>;
  /** 种子总数(task + fact/decision;头部/徽章显示用)。 */
  readonly seedCount: number;
}

/** 画布只消费 id 集(ego 可见集/领地 chip 判定),不需要 seedCount。 */
export type GraphFocusNodeIds = Pick<GraphFocusSelection, "taskIds" | "entitySeedIds" | "neighborIds">;

export function selectGraphFocusSet(input: {
  readonly tasks: ReadonlyArray<TaskRow>;
  readonly relations: ReadonlyArray<RelationEdge>;
  readonly decisions?: ReadonlyArray<DecisionRow>;
  readonly facts?: ReadonlyArray<FactRef>;
  /** agenda `repo.agenda.read` 的 pinned refs(唯一 pin 读面;task 的 pin 已在 TaskRow 上)。 */
  readonly pinnedRefs?: ReadonlySet<string>;
  readonly now: string;
  readonly schedules?: ReadonlyArray<ScheduleNodeRow>;
}): GraphFocusSelection {
  const taskIds = new Set<string>();
  for (const task of input.tasks) {
    if (isTaskGraphFocusSeed(task, input.now)) taskIds.add(task.taskId);
  }
  const entitySeedIds = new Set<string>();
  for (const fact of input.facts ?? []) {
    const id = factNodeId(fact.anchor);
    if (input.pinnedRefs?.has(id) || isWithinGraphFocusRecency(fact.at, input.now)) entitySeedIds.add(id);
  }
  for (const decision of input.decisions ?? []) {
    const id = `decision/${decision.decisionId}`;
    // kernel `isTerminalDecisionState` 把 proposed 之外都算已裁决;最近变更仍按 14 天窗口放行。
    if (
      input.pinnedRefs?.has(id) ||
      decision.state === "proposed" ||
      isWithinGraphFocusRecency(decision.lastChangedAt ?? decision.proposedAt, input.now)
    ) {
      entitySeedIds.add(id);
    }
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
  return { taskIds, entitySeedIds, neighborIds, seedCount: taskIds.size + entitySeedIds.size };
}

/**
 * 节点 id 是否在重点集内。接受任意入口形态(`task/<id>` 或裸 taskId、`agent/<id>`、
 * `decision/<id>` …),内部归一到图键空间 —— 领地 chip 的 navRef 与 ego 节点 id 都能直接问。
 */
export function isInGraphFocusSet(selection: GraphFocusSelection, nodeId: string): boolean {
  const id = endpointToNodeId(nodeId);
  return selection.taskIds.has(id) || selection.entitySeedIds.has(id) || selection.neighborIds.has(id);
}

function factNodeId(anchor: string): string {
  return anchor.startsWith("fact/") ? anchor : `fact/${anchor}`;
}
