/**
 * 聚光灯/关系图实体状态筛选纯函数。
 *
 * 词表来源(不硬编码拍脑袋):
 *   Task status  → BOARD_COLUMNS / SnapshotStatus (model/types.ts)
 *   Decision state → DecisionState 字面量联合 (model/types.ts)
 *
 * 默认全选 = 不改变现状;未知状态归 OTHER_STATUS_BUCKET("其他") 不崩。
 */
import type { DecisionState, SnapshotStatus, TaskRow, DecisionRow, FactRef } from "../model/types";
import { BOARD_COLUMNS } from "../model/types";

export const OTHER_STATUS_BUCKET = "__other__" as const;
export type OtherStatusBucket = typeof OTHER_STATUS_BUCKET;

export const TASK_STATUS_FILTER_OPTIONS: ReadonlyArray<SnapshotStatus> = BOARD_COLUMNS;

export const DECISION_STATE_FILTER_OPTIONS: ReadonlyArray<DecisionState> = [
  "proposed",
  "in_effect",
  "deferred",
  "rejected",
  "superseded",
  "outcome_retired",
];

export type TaskStatusFilterKey = SnapshotStatus | OtherStatusBucket;
export type DecisionStateFilterKey = DecisionState | OtherStatusBucket;

export interface EntityStatusFilterState {
  taskStatuses: Set<TaskStatusFilterKey>;
  decisionStates: Set<DecisionStateFilterKey>;
}

/** 默认全选(含 other 桶),不改变现状。 */
export function defaultEntityStatusFilter(): EntityStatusFilterState {
  return {
    taskStatuses: new Set<TaskStatusFilterKey>([...TASK_STATUS_FILTER_OPTIONS, OTHER_STATUS_BUCKET]),
    decisionStates: new Set<DecisionStateFilterKey>([...DECISION_STATE_FILTER_OPTIONS, OTHER_STATUS_BUCKET]),
  };
}

const KNOWN_TASK = new Set<string>(TASK_STATUS_FILTER_OPTIONS);
const KNOWN_DECISION = new Set<string>(DECISION_STATE_FILTER_OPTIONS);

export function normalizeTaskStatusKey(raw: string | undefined | null): TaskStatusFilterKey {
  if (raw && KNOWN_TASK.has(raw)) return raw as SnapshotStatus;
  return OTHER_STATUS_BUCKET;
}

export function normalizeDecisionStateKey(raw: string | undefined | null): DecisionStateFilterKey {
  if (raw && KNOWN_DECISION.has(raw)) return raw as DecisionState;
  return OTHER_STATUS_BUCKET;
}

export function isEntityStatusFilterNarrowed(filter: EntityStatusFilterState): boolean {
  const taskFull = TASK_STATUS_FILTER_OPTIONS.length + 1;
  const decFull = DECISION_STATE_FILTER_OPTIONS.length + 1;
  return filter.taskStatuses.size < taskFull || filter.decisionStates.size < decFull;
}

export function taskStatusOffCount(filter: EntityStatusFilterState): number {
  return TASK_STATUS_FILTER_OPTIONS.length + 1 - filter.taskStatuses.size;
}

export function decisionStateOffCount(filter: EntityStatusFilterState): number {
  return DECISION_STATE_FILTER_OPTIONS.length + 1 - filter.decisionStates.size;
}

/**
 * 节点是否通过实体状态筛选。
 * - fact:始终通过(状态筛选只针对 Task/Decision)。
 * - task:看 coordinationStatus 是否命中。
 * - decision:看 state 是否命中。
 */
export function nodePassesEntityStatusFilter(
  entity: "task" | "decision" | "fact" | string,
  row: { coordinationStatus?: string; state?: string } | FactRef | null | undefined,
  filter: EntityStatusFilterState,
): boolean {
  if (entity === "fact") return true;
  if (entity === "task") {
    const status = row && "coordinationStatus" in row ? row.coordinationStatus : undefined;
    return filter.taskStatuses.has(normalizeTaskStatusKey(status));
  }
  if (entity === "decision") {
    const state = row && "state" in row ? row.state : undefined;
    return filter.decisionStates.has(normalizeDecisionStateKey(state));
  }
  return true;
}

export function taskPassesStatusFilter(
  task: Pick<TaskRow, "coordinationStatus">,
  filter: EntityStatusFilterState,
): boolean {
  return nodePassesEntityStatusFilter("task", task, filter);
}

export function decisionPassesStateFilter(
  decision: Pick<DecisionRow, "state">,
  filter: EntityStatusFilterState,
): boolean {
  return nodePassesEntityStatusFilter("decision", decision, filter);
}
