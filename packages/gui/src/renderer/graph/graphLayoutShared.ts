import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { STATUS_META } from "../components/badges";
import { AXIS_COLOR_VAR, axisForKind, type SemanticAxis } from "./constants";
import type { AxisFilter } from "./graphLayoutTypes";
import type { Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType, Position } from "@xyflow/react";

interface CycleWarning {
  nodes: Set<string>;
  edges: Set<string>;
  cycles: string[][];
}

export function findRelationCycles(edges: { from: string; to: string }[]): CycleWarning {
  const bySource = new Map<string, string[]>();
  for (const edge of edges) {
    if (!bySource.has(edge.from)) bySource.set(edge.from, []);
    bySource.get(edge.from)!.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const cycles: string[][] = [];
  const cycleNodes = new Set<string>();
  const cycleEdges = new Set<string>();

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = cycle.join(">");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
        for (let i = 0; i < cycle.length - 1; i += 1) {
          cycleNodes.add(cycle[i]);
          cycleEdges.add(`${cycle[i]}|${cycle[i + 1]}`);
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    stack.push(node);
    for (const next of bySource.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of bySource.keys()) visit(node);
  return { nodes: cycleNodes, edges: cycleEdges, cycles };
}

/** 默认 focus:claim 最多的 active decision;退化到首条 decision;再退化到首条 task。 */
export function pickDefaultFocus(
  decisions: DecisionRow[],
  tasks: TaskRow[],
): string | null {
  const candidates = decisions
    .filter((d) => d.state === "active" || d.state === "proposed")
    .map((d) => ({ d, claimCount: d.claims.length }))
    .sort((a, b) => b.claimCount - a.claimCount);
  if (candidates.length > 0 && candidates[0].d.decisionId) {
    return `decision/${candidates[0].d.decisionId}`;
  }
  if (decisions.length > 0) return `decision/${decisions[0].decisionId}`;
  if (tasks.length > 0) return tasks[0].taskId;
  return null;
}

export function statusColor(task: TaskRow): string | undefined {
  return STATUS_META[task.coordinationStatus as keyof typeof STATUS_META]?.color;
}

/** 把 RelationEdge 按 axis 过滤(保留 SemanticAxis 满足 filter 的边)。 */
export function edgePassesAxisFilter(edge: RelationEdge, axes: AxisFilter): boolean {
  return axes[axisForKind(edge.kind)];
}

export function inLoopEdge(loopEdges: Set<string>, edge: RelationEdge): boolean {
  return loopEdges.has(`${edge.from}|${edge.to}`) || loopEdges.has(`${edge.to}|${edge.from}`);
}

interface BuildEdgeInput {
  edgeId: string;
  edge: RelationEdge;
  sourceId: string;
  targetId: string;
  sourcePosition: Position;
  targetPosition: Position;
  axis: SemanticAxis;
  sourceClaimId?: string;
  targetClaimId?: string;
  isLoop?: boolean;
}

export function buildEdge(input: BuildEdgeInput): Edge {
  const color = AXIS_COLOR_VAR[input.axis];
  const dasharray =
    input.axis === "assoc"
      ? "4 3"
      : input.axis === "evidence"
        ? undefined
        : input.edge.kind === "supersedes" || input.edge.kind === "refines"
          ? "6 3"
          : undefined;
  void input.sourcePosition;
  void input.targetPosition;
  return {
    id: input.edgeId,
    source: input.sourceId,
    sourceHandle: input.sourceClaimId ? `claim-${input.sourceClaimId}` : undefined,
    target: input.targetId,
    targetHandle: input.targetClaimId ? `claim-${input.targetClaimId}` : undefined,
    type: "interactive",
    data: { ...input.edge, axis: input.axis },
    animated: false,
    style: {
      stroke: color,
      strokeWidth: input.isLoop ? 2.5 : 1.6,
      strokeDasharray: dasharray,
    },
    markerEnd: { type: RFMarkerType.ArrowClosed, color },
  };
}

export function factRefOf(f: FactRef): string {
  return `fact/${f.taskId}/${f.anchor.split("/").pop() ?? f.anchor}`;
}
