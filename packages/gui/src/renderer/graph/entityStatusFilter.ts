/**
 * 聚光灯/关系图实体状态筛选纯函数。
 *
 * 词表来源(不硬编码拍脑袋):
 *   Task status  → BOARD_COLUMNS / SnapshotStatus (model/types.ts, 与 TaskFilterBar 同词表)
 *   Decision state → DecisionState 字面量联合 (model/types.ts)
 *
 * 默认全选 = 不改变现状;未知状态归 OTHER_STATUS_BUCKET("其他") 不崩。
 * 与 kind 筛选组合语义:kind ∩ status(本模块只负责 status 侧)。
 */
import type {
  DecisionRow,
  DecisionState,
  SnapshotStatus,
  TaskRow,
} from "../model/types";
import { BOARD_COLUMNS } from "../model/types";

/** 未知状态的稳定兜底桶 key(UI 显示 i18n "其他")。 */
export const OTHER_STATUS_BUCKET = "__other__" as const;
export type OtherStatusBucket = typeof OTHER_STATUS_BUCKET;

/** Task 状态词表 = 列表侧 BOARD_COLUMNS(含 unknown)。 */
export const TASK_STATUS_FILTER_OPTIONS: ReadonlyArray<SnapshotStatus> = BOARD_COLUMNS;

/**
 * Decision 状态词表 — 与 model/types.ts DecisionState 联合字面量一一对应。
 * 顺序:proposed → active → deferred → rejected → retired(生命周期直觉序)。
 */
export const DECISION_STATE_FILTER_OPTIONS: ReadonlyArray<DecisionState> = [
  "proposed",
  "active",
  "deferred",
  "rejected",
  "retired",
];

export type TaskStatusFilterKey = SnapshotStatus | OtherStatusBucket;
export type DecisionStateFilterKey = DecisionState | OtherStatusBucket;

export interface EntityStatusFilterState {
  /** 空/全选 = 不过滤 task;非空子集 = 只显示命中 status 的 task。 */
  taskStatuses: Set<TaskStatusFilterKey>;
  /** 空/全选 = 不过滤 decision;非空子集 = 只显示命中 state 的 decision。 */
  decisionStates: Set<DecisionStateFilterKey>;
}

/** 默认全选(含 other 桶),不改变现状。 */
export function defaultEntityStatusFilter(): EntityStatusFilterState {
  return {
    taskStatuses: new Set<TaskStatusFilterKey>([
      ...TASK_STATUS_FILTER_OPTIONS,
      OTHER_STATUS_BUCKET,
    ]),
    decisionStates: new Set<DecisionStateFilterKey>([
      ...DECISION_STATE_FILTER_OPTIONS,
      OTHER_STATUS_BUCKET,
    ]),
  };
}

const KNOWN_TASK = new Set<string>(TASK_STATUS_FILTER_OPTIONS);
const KNOWN_DECISION = new Set<string>(DECISION_STATE_FILTER_OPTIONS);

/** 把原始 task status 归到词表 key;未知 → other。 */
export function normalizeTaskStatusKey(raw: string | undefined | null): TaskStatusFilterKey {
  if (raw && KNOWN_TASK.has(raw)) return raw as SnapshotStatus;
  return OTHER_STATUS_BUCKET;
}

/** 把原始 decision state 归到词表 key;未知 → other。 */
export function normalizeDecisionStateKey(
  raw: string | undefined | null,
): DecisionStateFilterKey {
  if (raw && KNOWN_DECISION.has(raw)) return raw as DecisionState;
  return OTHER_STATUS_BUCKET;
}

/**
 * 状态筛选是否"收窄"了默认全选。
 * 用于面板徽章计数与"清除"可见性。
 */
export function isEntityStatusFilterNarrowed(filter: EntityStatusFilterState): boolean {
  const taskFull = TASK_STATUS_FILTER_OPTIONS.length + 1; // + other
  const decFull = DECISION_STATE_FILTER_OPTIONS.length + 1;
  return (
    filter.taskStatuses.size < taskFull || filter.decisionStates.size < decFull
  );
}

/** 关闭的 task 状态数(用于徽章)。 */
export function taskStatusOffCount(filter: EntityStatusFilterState): number {
  return TASK_STATUS_FILTER_OPTIONS.length + 1 - filter.taskStatuses.size;
}

/** 关闭的 decision 状态数(用于徽章)。 */
export function decisionStateOffCount(filter: EntityStatusFilterState): number {
  return DECISION_STATE_FILTER_OPTIONS.length + 1 - filter.decisionStates.size;
}

/**
 * 节点是否通过实体状态筛选。
 * - fact / 非 task|decision:始终通过(状态筛选只针对 Task/Decision)。
 * - task:看 coordinationStatus 是否命中 taskStatuses。
 * - decision:看 state 是否命中 decisionStates。
 * - 焦点节点由调用方决定是否豁免(layout 层可强制保留 focus)。
 */
export function nodePassesEntityStatusFilter(
  entity: "task" | "decision" | "fact" | string,
  row: { coordinationStatus?: string; state?: string } | null | undefined,
  filter: EntityStatusFilterState,
): boolean {
  if (entity === "fact") return true;
  if (entity === "task") {
    const key = normalizeTaskStatusKey(row?.coordinationStatus);
    return filter.taskStatuses.has(key);
  }
  if (entity === "decision") {
    const key = normalizeDecisionStateKey(row?.state);
    return filter.decisionStates.has(key);
  }
  // 未知 entity 类型不拦
  return true;
}

/**
 * 便捷:从 TaskRow / DecisionRow 直接判。
 */
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

/**
 * 边两端节点 id 都必须在 visibleNodeIds 内才保留。
 * 与 kind 筛选组合:调用方先 kind 滤边,再对本结果做交集,或反过来均可。
 */
export function edgeEndpointsVisible(
  sourceId: string,
  targetId: string,
  visibleNodeIds: ReadonlySet<string>,
): boolean {
  return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
}

/** 布局容器节点类型 — 状态筛选时始终保留。 */
const CONTAINER_NODE_TYPES = new Set([
  "moduleGroup",
  "laneBackground",
  "territoryZone",
]);

/**
 * 从 React Flow 节点列表计算状态筛选后的可见 id 集。
 * - 默认全选(未收窄)时返回 null,调用方跳过过滤。
 * - 焦点节点始终保留。
 * - 容器节点始终保留。
 * - ego 节点读 data.entity + data.raw;legacy 节点按 type 推断。
 */
export function computeStatusVisibleNodeIds(
  nodes: ReadonlyArray<{
    id: string;
    type?: string;
    data?: unknown;
  }>,
  filter: EntityStatusFilterState,
  focusIds: ReadonlyArray<string | null | undefined>,
): Set<string> | null {
  if (!isEntityStatusFilterNarrowed(filter)) return null;
  const focusSet = new Set(
    focusIds.filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const ids = new Set<string>();
  for (const n of nodes) {
    if (n.type && CONTAINER_NODE_TYPES.has(n.type)) {
      ids.add(n.id);
      continue;
    }
    if (focusSet.has(n.id)) {
      ids.add(n.id);
      continue;
    }
    const data = (n.data ?? {}) as {
      entity?: string;
      raw?: { coordinationStatus?: string; state?: string };
      coordinationStatus?: string;
      state?: string;
    };
    const entity =
      data.entity ??
      (n.type === "task"
        ? "task"
        : n.type === "decision" || n.type === "decisionFocus"
          ? "decision"
          : n.type === "fact"
            ? "fact"
            : n.type === "territoryChip"
              ? (data.entity ?? "task")
              : "fact");
    const row = data.raw ?? data;
    if (nodePassesEntityStatusFilter(entity, row, filter)) {
      ids.add(n.id);
    }
  }
  return ids;
}
