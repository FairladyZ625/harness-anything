import type { AgentEntityGuiAvailableRow } from "../../../../daemon/src/agent-entities.ts";
import type { ScheduleGuiRowDto } from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { RelationEdge } from "../model/types";

/**
 * 运行时平面的图节点行(agent/schedule),task/decision/fact 之外的两类实体。
 *
 * 行数据不新造读:agent 行来自 `repo.agent.entities.list` 的 DTO,schedule 行来自
 * `repo.schedules.list` 的 DTO(与 Agent 入口/Schedule 入口同一条读、同一份缓存),
 * 这里只做图需要的窄投影。agent→task 边来自 daemon 关系图切面
 * `repo.triadic.relationGraph {facet:"runtimeEdges"}`(dispatch 流头推导);
 * schedule→agent 边是**派生**边:Schedule 定义本身就声明了 target,不另立第二个
 * 事实源,与 ego 图里 parentTaskId 合成父子边同一先例。
 */

/** 图节点 id(agent/schedule 的键空间,与 endpointToNodeId 对齐)。 */
export const agentNodeId = (agentId: string): string => `agent/${agentId}`;
export const scheduleNodeId = (scheduleId: string): string => `schedule/${scheduleId}`;

export interface AgentNodeRow {
  /** 图键空间 id:`agent/<id>`。 */
  readonly id: string;
  readonly name: string;
  /** chip 副标(role + runtimeType),纯展示。 */
  readonly sub: string;
  /** 派工它的 task 数(领地/卡片徽章用,来自 runtimeEdges 切面)。 */
  readonly taskCount: number;
}

export interface ScheduleNodeRow {
  /** 图键空间 id:`schedule/<id>`。 */
  readonly id: string;
  readonly name: string;
  /** chip 副标(state + trigger 摘要,均为 daemon 已算好的事实,不复算)。 */
  readonly sub: string;
  /** 定义声明的 target(Schedule→agent 派生边的端点;squad target → null)。 */
  readonly targetAgentId: string | null;
}

/** agent 目录行 → 图节点行。`taskCount` 由切面边数补齐(见 withAgentTaskCounts)。 */
export function agentNodeRowOf(row: AgentEntityGuiAvailableRow): AgentNodeRow {
  return { id: agentNodeId(row.id), name: row.name, sub: `${row.role} · ${row.runtimeType}`, taskCount: 0 };
}

export function scheduleNodeRowOf(row: ScheduleGuiRowDto): ScheduleNodeRow {
  return {
    id: scheduleNodeId(row.scheduleId),
    name: row.name,
    sub: `${row.state} · ${row.trigger.summary}`,
    targetAgentId: row.target.kind === "agent" ? row.target.agentId : null,
  };
}

/** 用 agent→task 切面边补每 agent 的派工 task 数(领地徽章与 ego 卡片共用,不各数一遍)。 */
export function withAgentTaskCounts(
  agents: ReadonlyArray<AgentNodeRow>,
  relations: ReadonlyArray<RelationEdge>,
): AgentNodeRow[] {
  const counts = new Map<string, number>();
  for (const edge of relations)
    if (edge.from.split("/")[0] === "agent") {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    }
  return agents.map((agent) => (counts.has(agent.id) ? { ...agent, taskCount: counts.get(agent.id)! } : agent));
}

/** Schedule 定义声明的 target → `schedule/<id> --dispatches--> agent/<id>` 派生边。 */
export function scheduleTargetEdges(schedules: ReadonlyArray<ScheduleNodeRow>): RelationEdge[] {
  return schedules.flatMap((schedule) =>
    schedule.targetAgentId === null
      ? []
      : [
          {
            from: schedule.id,
            to: agentNodeId(schedule.targetAgentId),
            kind: "dispatches" as const,
            provenance: "local-document" as const,
            rationale: "Schedule 声明的 target",
          },
        ],
  );
}
