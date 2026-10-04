import type { TaskRow } from "./types.ts";

/**
 * 协作视图的查看侧模型(task_1bafbf09):一页看清本仓任务的指派资格与实际执行。
 *
 * 语义边界(与 kernel 同源,不在此重立规则):
 * - assignee(task/v2.assignment)是**资格限制**,expiresAt 过期只是资格放开;
 * - 实际执行者来自 lease(lease/v1),phase 词表 held/reserving/orphaned/released;
 * - 指派过期不打断已持有的 lease——执行侧以 lease 为准,资格侧只如实标注过期;
 * - 节点观察仅汇总数据里出现的 nodeId,在线状态本读面不提供,不推断。
 *
 * 一切判定只消费结构字段(assignment / leaseActor / leaseSource),不从
 * leaseHolder 显示串反解析。
 */

export interface CollaborationFilters {
  /** personId:命中指派人或 lease principal 任一;null = 不筛。 */
  readonly person: string | null;
  /** lease executor 的完整 id;null = 不筛。 */
  readonly agent: string | null;
  /** nodeId:命中 lease 来源节点或指派节点任一;null = 不筛。 */
  readonly node: string | null;
}

export const NO_COLLABORATION_FILTERS: CollaborationFilters = { person: null, agent: null, node: null };

export const hasCollaborationFilters = (filters: CollaborationFilters): boolean =>
  filters.person !== null || filters.agent !== null || filters.node !== null;

/** daemon 写侧的 executor id 格式 `runtime-session:<sessionId>`(agent-runtime-stream);剥出会话 id 供跳转,不匹配则无链接。 */
export function leaseRuntimeSessionIdOf(leaseActor: TaskRow["leaseActor"]): string | null {
  const executor = leaseActor?.executor;
  if (executor === null || executor === undefined) return null;
  return executor.id.startsWith("runtime-session:") ? executor.id.slice("runtime-session:".length) : null;
}

/** lease 来源节点(node 通道携带 nodeId;local/remote_direct 无节点,返回 null 不猜)。 */
export function leaseNodeIdOf(leaseSource: TaskRow["leaseSource"]): string | null {
  return typeof leaseSource === "object" && leaseSource !== null && leaseSource.kind === "node"
    ? leaseSource.nodeId
    : null;
}

/** 资格侧状态:无指派 / 指派在期 / 指派期限已过(只描述资格,不影响执行侧显示)。 */
export function assignmentStateOf(task: Pick<TaskRow, "assignment">, now: string): "none" | "assigned" | "expired" {
  const assignment = task.assignment;
  if (assignment === null || assignment === undefined) return "none";
  return Date.parse(assignment.expiresAt) <= Date.parse(now) ? "expired" : "assigned";
}

export type CollaborationTask = Pick<
  TaskRow,
  | "taskId"
  | "title"
  | "lastKnownAt"
  | "coordinationStatus"
  | "board"
  | "assignment"
  | "leaseActor"
  | "leaseSource"
  | "leasePhase"
  | "leaseExpiresAt"
>;

interface PersonDimension {
  readonly id: string;
  readonly count: number;
}
interface AgentDimension {
  /** lease executor 的完整 id(筛选与悬停用)。 */
  readonly id: string;
  readonly count: number;
}
export interface CollaborationNodeSummary {
  readonly nodeId: string;
  /** 该节点来源的当前执行 lease 数(phase held/reserving)。 */
  readonly executing: number;
  /** assignee.nodeId 指到该节点的指派数。 */
  readonly assigned: number;
}

export interface CollaborationFilterOptions {
  readonly persons: readonly PersonDimension[];
  readonly agents: readonly AgentDimension[];
  readonly nodes: readonly CollaborationNodeSummary[];
}

const ACTIVE_LEASE_PHASES = new Set(["held", "reserving"]);

/** 按人/Agent/节点三个维度汇总实际出现过的筛选值,各带计数;维度无数据时为空数组(不提供该筛选)。 */
export function collaborationFilterOptions(tasks: readonly CollaborationTask[]): CollaborationFilterOptions {
  const persons = new Map<string, number>();
  const agents = new Map<string, number>();
  // 汇总期可变,输出时收成 readonly 行。
  const nodes = new Map<string, { nodeId: string; executing: number; assigned: number }>();
  const nodeOf = (nodeId: string) => {
    let entry = nodes.get(nodeId);
    if (entry === undefined) {
      entry = { nodeId, executing: 0, assigned: 0 };
      nodes.set(nodeId, entry);
    }
    return entry;
  };
  for (const task of tasks) {
    const assignee = task.assignment?.assignee;
    // 工作组指派(kind=team)不是人也不占节点,只作为行的资格事实显示,不进任何筛选维度。
    if (assignee?.kind === "person") {
      persons.set(assignee.personId, (persons.get(assignee.personId) ?? 0) + 1);
      if (assignee.nodeId !== undefined) nodeOf(assignee.nodeId).assigned += 1;
    }
    const leaseActor = task.leaseActor;
    if (leaseActor !== undefined) {
      persons.set(leaseActor.principal.personId, (persons.get(leaseActor.principal.personId) ?? 0) + 1);
      if (leaseActor.executor !== null)
        agents.set(leaseActor.executor.id, (agents.get(leaseActor.executor.id) ?? 0) + 1);
      const nodeId = leaseNodeIdOf(task.leaseSource);
      if (nodeId !== null && ACTIVE_LEASE_PHASES.has(task.leasePhase ?? "")) nodeOf(nodeId).executing += 1;
    }
  }
  const byCountThenId = (left: { count: number; id: string }, right: { count: number; id: string }) =>
    right.count - left.count || left.id.localeCompare(right.id);
  return {
    persons: [...persons.entries()].map(([id, count]) => ({ id, count })).sort(byCountThenId),
    agents: [...agents.entries()].map(([id, count]) => ({ id, count })).sort(byCountThenId),
    nodes: [...nodes.values()].sort(
      (left, right) => right.executing - left.executing || left.nodeId.localeCompare(right.nodeId),
    ),
  };
}

function matchesCollaborationTask(task: CollaborationTask, filters: CollaborationFilters): boolean {
  if (filters.person !== null) {
    const assignee = task.assignment?.assignee;
    const assignedTo = assignee?.kind === "person" && assignee.personId === filters.person;
    if (!assignedTo && task.leaseActor?.principal.personId !== filters.person) return false;
  }
  if (filters.agent !== null && task.leaseActor?.executor?.id !== filters.agent) return false;
  if (filters.node !== null) {
    const leaseNode = leaseNodeIdOf(task.leaseSource) === filters.node;
    const assignee = task.assignment?.assignee;
    const assignedNode = assignee?.kind === "person" && assignee.nodeId === filters.node;
    if (!leaseNode && !assignedNode) return false;
  }
  return true;
}

/**
 * 筛选 + 协作列表默认序:daemon 看板权重(board.rank,需关注者优先)打底,
 * 同权重内 lastKnownAt 倒序;两步稳定排序,不改变同刻任务的相对顺序。
 */
export function applyCollaborationFilters(
  tasks: readonly CollaborationTask[],
  filters: CollaborationFilters,
): readonly CollaborationTask[] {
  return [...tasks]
    .sort((left, right) => right.lastKnownAt.localeCompare(left.lastKnownAt))
    .filter((task) => matchesCollaborationTask(task, filters))
    .sort((left, right) => left.board.rank - right.board.rank);
}
