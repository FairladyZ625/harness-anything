import type { AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";
import type { TaskRow } from "./types.ts";

/**
 * 协作视图的查看侧模型(task_1bafbf09):一页看清本仓任务的指派资格与实际执行。
 *
 * 语义边界(与 kernel 同源,不在此重立规则):
 * - assignee(task/v2.assignment)是**资格限制**,expiresAt 过期只是资格放开;
 * - 实际执行者来自 lease(lease/v1),phase 词表 held/reserving/orphaned/released;
 *   「执行中」只认 phase(held/reserving),持有人还在但 orphaned/released 不算执行中;
 * - executor id 是 daemon 写侧的 runtime-session 执行会话;Agent 身份来自
 *   runtime-session-groups 投影的权威绑定(dispatch 行的 agentId,见
 *   daemon agent-runtime-session-groups.ts),不从 model/instance/session 字符串猜;
 * - 指派过期不打断已持有的 lease——执行侧以 lease 为准,资格侧只如实标注过期;
 * - 节点观察仅汇总数据里出现的 nodeId,在线状态本读面不提供,不推断。
 *
 * 一切判定只消费结构字段(assignment / leaseActor / leaseSource),不从
 * leaseHolder 显示串反解析。
 */

/** sessionGroups 投影里声明过的 Agent:agentId 权威,label 是显示名。 */
export interface CollaborationAgent {
  readonly agentId: string;
  readonly label: string;
}

/**
 * lease 执行会话 → 声明 Agent 的索引。只包含本次请求且有派工声明的会话。
 */
export interface SessionAgentIndex {
  readonly agentOfSession: ReadonlyMap<string, CollaborationAgent>;
}

export const EMPTY_SESSION_AGENT_INDEX: SessionAgentIndex = { agentOfSession: new Map() };

/** 从仓库派工事件对 lease 会话的声明建索引；与组分页无关。 */
export function agentIndexOfSessionGroups(
  result: Pick<AgentRuntimeSessionGroupsResult, "sessionAgents">,
): SessionAgentIndex {
  const agentOfSession = new Map<string, CollaborationAgent>();
  for (const entry of result.sessionAgents) {
    agentOfSession.set(entry.runtimeSessionId, { agentId: entry.agentId, label: entry.label });
  }
  return { agentOfSession };
}

export interface CollaborationFilters {
  /** personId:命中指派人或 lease principal 任一;null = 不筛。 */
  readonly person: string | null;
  /** 声明 Agent 的 agentId(映射自 lease 执行会话);null = 不筛。 */
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
  /** 声明 Agent 的 agentId(筛选值与实体跳转用)。 */
  readonly id: string;
  readonly label: string;
  readonly count: number;
}
export interface CollaborationNodeSummary {
  readonly nodeId: string;
  /** 节点筛选的命中任务数(lease 来源节点或 person 指派 nodeId 任一命中,按 task 去重)。 */
  readonly count: number;
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

/** 执行中只认 lease phase(held/reserving);orphaned/released 是持有人还在但不在执行,phase 缺失也不算。 */
export const isExecutingLeasePhase = (phase: string | undefined): boolean =>
  phase !== undefined && ACTIVE_LEASE_PHASES.has(phase);

/**
 * 按人/Agent/节点三个维度汇总实际出现过的筛选值,各带计数;维度无数据时为空数组(不提供该筛选)。
 * 计数不变量:每个维度值的 count 严格等于该维度单独筛选命中的 task 数——同一 task 里
 * 指派人与 lease principal 是同一人、或 lease 节点与指派节点是同一节点,都只计一次。
 * Agent 维度按会话→Agent 索引聚合:同一 Agent 的多个 lease 会话收进同一个筛选值;
 * 索引映射不上的会话不产生 Agent 筛选值(行内如实显示「未提供」)。
 */
export function collaborationFilterOptions(
  tasks: readonly CollaborationTask[],
  agents: SessionAgentIndex = EMPTY_SESSION_AGENT_INDEX,
): CollaborationFilterOptions {
  const persons = new Map<string, number>();
  const agentCounts = new Map<string, { label: string; count: number }>();
  // 汇总期可变,输出时收成 readonly 行。
  const nodes = new Map<string, { nodeId: string; count: number; executing: number; assigned: number }>();
  const nodeOf = (nodeId: string) => {
    let entry = nodes.get(nodeId);
    if (entry === undefined) {
      entry = { nodeId, count: 0, executing: 0, assigned: 0 };
      nodes.set(nodeId, entry);
    }
    return entry;
  };
  for (const task of tasks) {
    const assignee = task.assignment?.assignee;
    // 工作组指派(kind=team)不是人也不占节点,只作为行的资格事实显示,不进任何筛选维度。
    const taskPersons = new Set<string>();
    const taskNodes = new Set<string>();
    if (assignee?.kind === "person") {
      taskPersons.add(assignee.personId);
      if (assignee.nodeId !== undefined) {
        taskNodes.add(assignee.nodeId);
        nodeOf(assignee.nodeId).assigned += 1;
      }
    }
    const leaseActor = task.leaseActor;
    if (leaseActor !== undefined) {
      taskPersons.add(leaseActor.principal.personId);
      const runtimeSessionId = leaseRuntimeSessionIdOf(leaseActor),
        agent = runtimeSessionId === null ? undefined : agents.agentOfSession.get(runtimeSessionId);
      if (agent !== undefined) {
        const known = agentCounts.get(agent.agentId) ?? { label: agent.label, count: 0 };
        known.count += 1;
        agentCounts.set(agent.agentId, known);
      }
      const nodeId = leaseNodeIdOf(task.leaseSource);
      if (nodeId !== null) {
        taskNodes.add(nodeId);
        if (isExecutingLeasePhase(task.leasePhase)) nodeOf(nodeId).executing += 1;
      }
    }
    for (const personId of taskPersons) persons.set(personId, (persons.get(personId) ?? 0) + 1);
    for (const nodeId of taskNodes) nodeOf(nodeId).count += 1;
  }
  const byCountThenId = (left: { count: number; id: string }, right: { count: number; id: string }) =>
    right.count - left.count || left.id.localeCompare(right.id);
  return {
    persons: [...persons.entries()].map(([id, count]) => ({ id, count })).sort(byCountThenId),
    agents: [...agentCounts.entries()].map(([id, { label, count }]) => ({ id, label, count })).sort(byCountThenId),
    nodes: [...nodes.values()].sort(
      (left, right) => right.executing - left.executing || left.nodeId.localeCompare(right.nodeId),
    ),
  };
}

function matchesCollaborationTask(
  task: CollaborationTask,
  filters: CollaborationFilters,
  agents: SessionAgentIndex,
): boolean {
  if (filters.person !== null) {
    const assignee = task.assignment?.assignee;
    const assignedTo = assignee?.kind === "person" && assignee.personId === filters.person;
    if (!assignedTo && task.leaseActor?.principal.personId !== filters.person) return false;
  }
  if (filters.agent !== null) {
    const runtimeSessionId = task.leaseActor === undefined ? null : leaseRuntimeSessionIdOf(task.leaseActor);
    if (runtimeSessionId === null || agents.agentOfSession.get(runtimeSessionId)?.agentId !== filters.agent)
      return false;
  }
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
  agents: SessionAgentIndex = EMPTY_SESSION_AGENT_INDEX,
): readonly CollaborationTask[] {
  return [...tasks]
    .sort((left, right) => right.lastKnownAt.localeCompare(left.lastKnownAt))
    .filter((task) => matchesCollaborationTask(task, filters, agents))
    .sort((left, right) => left.board.rank - right.board.rank);
}
