import type { WorkTopologyRead } from "../../api/renderer-dto.ts";
import type { RelationEdge, TaskRow } from "../model/types.ts";

/**
 * 工作拓扑读面(daemon `repo.work.topology.read`)→ 共享画布的输入。
 *
 * 唯一职责是**搬运**:范围(成员 + 一跳外部边界)、边、以及每节点的 daemon 状态标记。
 * 这里不做可开工/阻塞判定(dec_17A863CC RJ3):状态词、前沿集与关键路径位置都原样读
 * daemon 字段。成员的展示字段来自同一台账切面的 task 行(`repo.tasks.list` 投影),
 * 拓扑读只往行上补 `topologyState/topologyFrontier/topologyCriticalPathPosition` 三格
 * 标记——节点卡片与边抽屉用的是全局关系图同一份组件,不另写一套渲染。
 *
 * 拓扑读点到、但任务投影里还没有的成员不造行(与 `buildEgoGraph` 对悬挂端点的口径
 * 一致):读面缺行要说出来,不能让画布看起来「这个成员不存在」。
 */

/** 拓扑读面里的节点状态词(唯一来源是 daemon 协议类型,不在此另立词表)。 */
export type WorkTopologyState = WorkTopologyRead["members"][number]["topologyState"];

interface WorkTopologyMark {
  readonly state: WorkTopologyState;
  readonly frontier: boolean;
  readonly criticalPathPosition?: number;
}

/** taskId → daemon 状态标记。前沿与关键路径位置出自同一份 daemon 结果。 */
function workTopologyMarksOf(topology: WorkTopologyRead): ReadonlyMap<string, WorkTopologyMark> {
  const frontier = new Set(topology.frontier),
    criticalPathPosition = new Map((topology.criticalPath ?? []).map((taskId, index) => [taskId, index + 1])),
    marks = new Map<string, WorkTopologyMark>();
  for (const node of [...topology.members, ...topology.boundaryTasks]) {
    const position = criticalPathPosition.get(node.taskId);
    marks.set(node.taskId, {
      state: node.topologyState,
      frontier: frontier.has(node.taskId),
      ...(position === undefined ? {} : { criticalPathPosition: position }),
    });
  }
  return marks;
}

/** 状态层的计数:全部取自 daemon 结果,不在 GUI 重算生命周期。 */
export interface WorkTopologySummary {
  readonly members: number;
  readonly boundary: number;
  readonly frontier: number;
  readonly inFlight: number;
  readonly blocked: number;
  readonly awaitingRuling: number;
  /** 关键路径任务数;null = daemon 无法给出完整路径(环/缺端点/截断)。 */
  readonly criticalPathTasks: number | null;
  readonly revision: number;
  readonly completeness: WorkTopologyRead["completeness"];
  readonly warnings: readonly string[];
}

export function workTopologySummaryOf(topology: WorkTopologyRead): WorkTopologySummary {
  const countOf = (state: WorkTopologyState) => topology.members.filter((node) => node.topologyState === state).length;
  return {
    members: topology.members.length,
    boundary: topology.boundaryTasks.length,
    frontier: topology.frontier.length,
    inFlight: countOf("in-flight"),
    blocked: countOf("blocked"),
    awaitingRuling: countOf("awaiting-ruling"),
    criticalPathTasks: topology.criticalPath === null ? null : topology.criticalPath.length,
    revision: topology.sourceRevision,
    completeness: topology.completeness,
    warnings: topology.warnings,
  };
}

export interface WorkTopologyGraph {
  /** 画布行:work 成员 + 一跳外部边界,带 daemon 状态标记。 */
  readonly tasks: readonly TaskRow[];
  /** 边:daemon 拓扑读面返回的 depends-on 边(工作图中唯一的拓扑边)。 */
  readonly relations: readonly RelationEdge[];
  /** 拓扑读点到、但任务投影里没有的节点(不造行,只报数量)。 */
  readonly missingTaskIds: readonly string[];
}

export function workTopologyGraphOf(
  topology: WorkTopologyRead | undefined,
  tasks: readonly TaskRow[],
): WorkTopologyGraph {
  if (!topology) return { tasks: [], relations: [], missingTaskIds: [] };
  const rows = new Map(tasks.map((task) => [task.taskId, task])),
    marks = workTopologyMarksOf(topology),
    missingTaskIds: string[] = [],
    seen = new Set<string>(),
    scoped: TaskRow[] = [];
  for (const node of [...topology.members, ...topology.boundaryTasks]) {
    if (seen.has(node.taskId)) continue;
    seen.add(node.taskId);
    const row = rows.get(node.taskId);
    if (!row) {
      missingTaskIds.push(node.taskId);
      continue;
    }
    const mark = marks.get(node.taskId)!;
    scoped.push({
      ...row,
      topologyState: mark.state,
      topologyFrontier: mark.frontier,
      ...(mark.criticalPathPosition === undefined ? {} : { topologyCriticalPathPosition: mark.criticalPathPosition }),
    });
  }
  return {
    tasks: scoped,
    relations: topology.edges.map(
      (edge): RelationEdge => ({
        relationId: edge.relationId,
        from: edge.from,
        to: edge.to,
        kind: "depends-on",
        direction: edge.direction as RelationEdge["direction"],
        state: edge.state as RelationEdge["state"],
        provenance: "local-document",
        rationale: edge.rationale,
      }),
    ),
    missingTaskIds,
  };
}
