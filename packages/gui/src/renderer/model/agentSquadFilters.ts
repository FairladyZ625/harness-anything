import {
  isAvailableAgentEntityRow,
  isAvailableSquadEntityRow,
  type AgentEntityRow,
  type SquadEntityRow,
} from "../agent-entity-client.ts";

// Agent·Squad 页左侧列表的查看者本地过滤状态(task_* gui-agent-filter):只放内存,
// 不写台账。筛选项不写死——全部从当前 catalog 行聚合(agentFilterOptions)。
// catalog 行只带 id/name/runtimes/instance/role/layer(squad 带 leader/workers);
// instructions 不在 catalog 投影里,搜索域以行内实际字段为准。
export interface AgentSquadFilters {
  readonly query: string;
  /** Agent role 多选(worker / commander…);空数组=全部。只作用于 Agent 段。 */
  readonly roles: readonly string[];
  /** runtime kind 多选(codex / claude / devin / agy…,来自 runtimes[].type);
   *  空=全部。只作用于 Agent 段。 */
  readonly runtimeKinds: readonly string[];
  /** layer 多选(user / 内置);空=全部。两段都作用。 */
  readonly layers: readonly string[];
  /** 只看被 Squad 引用的 Agent(leader 或 workers 命中)。 */
  readonly inSquadOnly: boolean;
}

export const DEFAULT_AGENT_SQUAD_FILTERS: AgentSquadFilters = {
  query: "",
  roles: [],
  runtimeKinds: [],
  layers: [],
  inSquadOnly: false,
};

export const hasActiveAgentSquadFilters = (filters: AgentSquadFilters) =>
  filters.query.trim() !== "" ||
  filters.roles.length > 0 ||
  filters.runtimeKinds.length > 0 ||
  filters.layers.length > 0 ||
  filters.inSquadOnly;

const substring = (query: string, fields: readonly (string | null)[]) =>
  query === "" || fields.some((field) => field !== null && field.toLowerCase().includes(query));

export interface AgentSquadFilterOptions {
  readonly roles: readonly string[];
  readonly runtimeKinds: readonly string[];
  readonly layers: readonly string[];
}

// 筛选项从当前数据聚合:只出现真实存在的取值,不写死清单。
export function agentSquadFilterOptions(
  agents: readonly AgentEntityRow[],
  squads: readonly SquadEntityRow[],
): AgentSquadFilterOptions {
  const roles = new Set<string>(),
    runtimeKinds = new Set<string>(),
    layers = new Set<string>();
  for (const agent of agents) {
    if (!isAvailableAgentEntityRow(agent)) continue;
    roles.add(agent.role);
    layers.add(agent.layer);
    for (const target of agent.runtimes) runtimeKinds.add(target.type);
  }
  for (const squad of squads) if (isAvailableSquadEntityRow(squad)) layers.add(squad.layer);
  const sort = (set: ReadonlySet<string>) => [...set].sort();
  return { roles: sort(roles), runtimeKinds: sort(runtimeKinds), layers: sort(layers) };
}

// 降级行(invalid/missing)是目录健康信号,过滤不应把它们藏起来——恒保留。
export function filterAgents(
  agents: readonly AgentEntityRow[],
  squads: readonly SquadEntityRow[],
  filters: AgentSquadFilters,
): AgentEntityRow[] {
  const query = filters.query.trim().toLowerCase(),
    referenced = new Set<string>();
  if (filters.inSquadOnly)
    for (const squad of squads)
      if (isAvailableSquadEntityRow(squad)) for (const id of [squad.leader, ...squad.workers]) referenced.add(id);
  return agents.filter((row) => {
    if (!isAvailableAgentEntityRow(row)) return true;
    if (!substring(query, [row.name, row.id, row.instance])) return false;
    if (filters.roles.length > 0 && !filters.roles.includes(row.role)) return false;
    if (filters.runtimeKinds.length > 0 && !row.runtimes.some((target) => filters.runtimeKinds.includes(target.type)))
      return false;
    if (filters.layers.length > 0 && !filters.layers.includes(row.layer)) return false;
    if (filters.inSquadOnly && !referenced.has(row.id)) return false;
    return true;
  });
}

export function filterSquads(squads: readonly SquadEntityRow[], filters: AgentSquadFilters): SquadEntityRow[] {
  const query = filters.query.trim().toLowerCase();
  return squads.filter((row) => {
    if (!isAvailableSquadEntityRow(row)) return true;
    if (!substring(query, [row.name, row.id, row.leader])) return false;
    if (filters.layers.length > 0 && !filters.layers.includes(row.layer)) return false;
    return true;
  });
}
