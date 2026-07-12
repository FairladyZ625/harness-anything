import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { parseEndpoint, endpointToNodeId } from "./endpoint";
import { axisForKind } from "./constants";
import type { GraphFilterInput, LayoutOutput } from "./graphLayoutTypes";
import { buildEdge, factRefOf, findRelationCycles, inLoopEdge, statusColor } from "./graphLayoutShared";
import type { Node, Edge } from "@xyflow/react";
import { Position } from "@xyflow/react";

interface SimpleEgoInput {
  focusId: string;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  filters: GraphFilterInput;
  inLoopEdges: Set<string>;
}

export function layoutSimpleEgo(input: SimpleEgoInput): LayoutOutput {
  const neighbors = new Map<string, "task" | "decision" | "fact">();
  const egoEdges: RelationEdge[] = [];

  for (const edge of input.relations) {
    const fromId = endpointToNodeId(edge.from);
    const toId = endpointToNodeId(edge.to);
    if (fromId === input.focusId) {
      const parsed = parseEndpoint(edge.to);
      if (parsed) {
        neighbors.set(parsed.id, parsed.entity);
        egoEdges.push(edge);
      }
    } else if (toId === input.focusId) {
      const parsed = parseEndpoint(edge.from);
      if (parsed) {
        neighbors.set(parsed.id, parsed.entity);
        egoEdges.push(edge);
      }
    }
  }

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  const focusParsed = parseEndpoint(input.focusId);
  const focusEntity = focusParsed?.entity ?? "task";
  const cx = 480;
  const cy = 200;

  let focusData: Record<string, unknown> = { focus: true };
  if (focusEntity === "task") {
    const t = input.tasks.find((x) => x.taskId === input.focusId);
    if (t) focusData = { label: t.title, taskId: t.taskId, coordinationStatus: t.coordinationStatus, color: statusColor(t), focus: true, raw: t };
  } else if (focusEntity === "decision") {
    const d = input.decisions.find((x) => `decision/${x.decisionId}` === input.focusId);
    if (d) focusData = { label: d.title, decisionId: d.decisionId, state: d.state, riskTier: d.riskTier, urgency: d.urgency, claims: d.claims, question: d.question, focus: true, raw: d };
  } else if (focusEntity === "fact") {
    const f = input.facts.find((x) => factRefOf(x) === input.focusId);
    if (f) focusData = { label: f.anchor.split("/").pop(), sub: f.category, text: f.text, at: f.at, taskId: f.taskId, anchor: f.anchor, focus: true, raw: f };
  }

  rfNodes.push({
    id: input.focusId,
    type: focusEntity,
    position: { x: cx - 80, y: cy - 22 },
    style: { width: 160, height: 44 },
    data: focusData,
    zIndex: 5,
  });

  const neighborList = [...neighbors.entries()];
  const radius = 220;
  neighborList.forEach(([id, entity], i) => {
    const angle = (i / Math.max(neighborList.length, 1)) * Math.PI * 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    let data: Record<string, unknown> = {};
    const type = entity;
    if (entity === "task") {
      const t = input.tasks.find((x) => x.taskId === id);
      if (t) data = { label: t.title, taskId: t.taskId, coordinationStatus: t.coordinationStatus, color: statusColor(t), raw: t };
    } else if (entity === "decision") {
      const d = input.decisions.find((x) => `decision/${x.decisionId}` === id);
      if (d) data = { label: d.title, decisionId: d.decisionId, state: d.state, claims: d.claims, raw: d };
    } else if (entity === "fact") {
      const f = input.facts.find((x) => factRefOf(x) === id);
      if (f) data = { label: f.anchor.split("/").pop(), sub: f.category, text: f.text, at: f.at, taskId: f.taskId, anchor: f.anchor, raw: f };
    }
    rfNodes.push({
      id,
      type,
      position: { x: x - 80, y: y - 22 },
      style: { width: 160, height: 44 },
      data: { ...data, focus: false, dimmed: false },
    });
  });

  egoEdges.forEach((edge, i) => {
    const fromId = endpointToNodeId(edge.from);
    const toId = endpointToNodeId(edge.to);
    const axis = axisForKind(edge.kind);
    rfEdges.push(
      buildEdge({
        edgeId: `e_ego_${i}`,
        edge,
        sourceId: fromId,
        targetId: toId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        axis,
        isLoop: inLoopEdge(input.inLoopEdges, edge),
      }),
    );
  });

  const normalizedEdges = rfEdges.map((e) => ({ from: e.source, to: e.target }));
  const cycleWarning = findRelationCycles(normalizedEdges);

  return {
    nodes: rfNodes,
    edges: rfEdges,
    cycleWarning: { count: cycleWarning.cycles.length, cycles: cycleWarning.cycles },
    resolvedFocusId: input.focusId,
    focusClaims: [],
    bounds: { width: cx + radius + 200, height: cy + radius + 80 },
  };
}
