import type { TaskRow, DecisionRow, FactRef, RelationEdge, RelationKind } from "../model/types";
import type { FactAnchorRow, RelationCoverageRow } from "../../api/renderer-dto";
import { MarkerType as RFMarkerType, type Node, type Edge } from "@xyflow/react";
import { parseEndpoint, endpointToNodeId } from "./endpoint";
import { KIND_AXIS, type SemanticAxis } from "./constants";
import { visualForKind } from "./relationVisual";
import {
  resolveDecisionModule,
  resolveFactModule,
  resolveTaskModule,
  UNPROJECTED_MODULE,
} from "./moduleAssignment";

/**
 * 聚光灯三泳道 ego 布局(REQ-GUI-04)。
 *
 * 焦点 decision:谱系(authority 轴邻居)· 主张(claims+覆盖 evidence)· 派生(derives→task execution)。
 * 焦点 task/fact:邻居按语义轴分进三条泳道,语义同构。
 *
 * 纯前端派生:从 relations 取焦点 1-hop 邻居,按 axis 分泳道,定位。
 * nodesDraggable/nodesConnectable 由 ReactFlow props 关闭(不可拖连,只点/双击/缩放)。
 */

const LANE_HEIGHT = 150;
const LANE_GAP = 24;
const LANE_PAD = 40;
const EGO_W = 200;
const EGO_H = 64;
const CHIP_W = 170;
const CHIP_H = 44;
const LANE_LABEL_W = 88;

export type LaneKey = "authority" | "evidence" | "execution";

export interface LaneSpec {
  key: LaneKey;
  label: string;
  sublabel: string;
  axis: SemanticAxis;
}

/** 三泳道规格(由上至下:谱系/主张/派生)。 */
export const THREE_LANES: LaneSpec[] = [
  { key: "authority", label: "谱系", sublabel: "refines · narrows · supersedes · derives", axis: "authority" },
  { key: "evidence", label: "主张 · 证据", sublabel: "claims + 覆盖 · evidenced-by", axis: "evidence" },
  { key: "execution", label: "派生 · 执行", sublabel: "derives → task · depends-on", axis: "execution" },
];

interface Neighbor {
  id: string;
  entity: "task" | "decision" | "fact";
  label: string;
  sub?: string;
  moduleId: string;
  axis: SemanticAxis;
  kind: RelationKind;
  raw: TaskRow | DecisionRow | FactRef | { anchor: string; taskId: string; category: string; text: string };
}

export interface SpotlightLayout {
  nodes: Node[];
  edges: Edge[];
  focusEntity: "task" | "decision" | "fact" | null;
  focusId: string | null;
  laneCounts: Record<LaneKey, number>;
}

interface SpotlightFilter {
  axes: Record<SemanticAxis, boolean>;
  kinds: ReadonlySet<RelationKind>;
  modules: ReadonlySet<string>;
}

function laneOf(axis: SemanticAxis): LaneKey {
  if (axis === "authority") return "authority";
  if (axis === "evidence") return "evidence";
  return "execution";
}

/**
 * 计算聚光灯布局。
 * - focusRef 形如 decision/<id>、task/<id>、fact/<task>/<anchor>。
 * - 邻居按 relation 的语义轴分泳道;assoc 轴(relates/implements)默认不进泳道(降噪)。
 */
export function computeSpotlightLayout(
  focusRef: string | null,
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
  filters: SpotlightFilter,
): SpotlightLayout {
  if (!focusRef) return emptyLayout();
  const focusParsed = parseEndpoint(focusRef);
  if (!focusParsed) return emptyLayout();

  const focusId = focusParsed.id;
  const focusEntity = focusParsed.entity;
  const focusLaneKey: LaneKey = "evidence"; // ego 居中泳道

  // 构建 entity 查找表。
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const decisionById = new Map(decisions.map((d) => [`decision/${d.decisionId}`, d]));
  const factById = new Map<string, FactRef>();
  for (const f of facts) {
    const anchor = f.anchor.split("/").pop() ?? f.anchor;
    factById.set(`fact/${f.taskId}/${anchor}`, f);
  }

  // ego 数据。
  const egoData = resolveEntityData(focusId, focusEntity, taskById, decisionById, factById, factAnchors, relations, tasks);
  if (!egoData) return emptyLayout();

  // 收集 1-hop 邻居(双向)。
  const neighborMap = new Map<string, Neighbor & { edgeFromFocus: boolean }>();
  for (const edge of relations) {
    const fromId = endpointToNodeId(edge.from);
    const toId = endpointToNodeId(edge.to);
    const axis = KIND_AXIS[edge.kind] ?? "assoc";
    // axis 筛选:关掉的轴不进泳道。
    if (!filters.axes[axis]) continue;
    // kind 筛选。
    if (!filters.kinds.has(edge.kind)) continue;

    if (fromId === focusId) {
      // 出边:focus → to(用原始 ref 以保留实体前缀)
      addNeighbor(edge.to, edge.kind, axis, true, neighborMap, tasks, decisions, facts, factAnchors, relations, filters);
    } else if (toId === focusId) {
      // 入边:from → focus
      addNeighbor(edge.from, edge.kind, axis, false, neighborMap, tasks, decisions, facts, factAnchors, relations, filters);
    }
  }

  // 按泳道分组。
  const lanes: Record<LaneKey, Neighbor[]> = { authority: [], evidence: [], execution: [] };
  for (const nb of neighborMap.values()) {
    // module 筛选。
    if (filters.modules.size > 0 && !filters.modules.has(nb.moduleId) && nb.moduleId !== UNPROJECTED_MODULE) continue;
    lanes[laneOf(nb.axis)].push(nb);
  }

  // 排序 + 限流(密度上限:每泳道最多 8 chip,防大图糊)。
  const MAX_PER_LANE = 8;
  for (const key of Object.keys(lanes) as LaneKey[]) {
    lanes[key].sort((a, b) => a.label.localeCompare(b.label));
    if (lanes[key].length > MAX_PER_LANE) lanes[key].length = MAX_PER_LANE;
  }

  // 定位。
  const nodes: Node[] = [];
  const laneY: Record<LaneKey, number> = {
    authority: LANE_PAD,
    evidence: LANE_PAD + LANE_HEIGHT + LANE_GAP,
    execution: LANE_PAD + (LANE_HEIGHT + LANE_GAP) * 2,
  };

  // 泳道背景节点。
  for (const spec of THREE_LANES) {
    nodes.push({
      id: `lane:${spec.key}`,
      type: "laneBackground",
      position: { x: 0, y: laneY[spec.key] },
      style: { width: 2000, height: LANE_HEIGHT },
      data: { label: spec.label, sublabel: spec.sublabel, axis: spec.axis },
      draggable: false,
      selectable: false,
      zIndex: -2,
    });
  }

  // ego 居中(evidence 泳道中央)。
  const egoCenterX = LANE_LABEL_W + 60;
  nodes.push({
    id: focusId,
    type: focusEntity,
    position: { x: egoCenterX, y: laneY[focusLaneKey] + (LANE_HEIGHT - EGO_H) / 2 },
    data: {
      ...egoData.raw,
      label: egoData.label,
      sub: egoData.sub,
      entity: focusEntity,
      focused: true,
      moduleId: egoData.moduleId,
      raw: egoData.raw,
    },
    draggable: false,
    zIndex: 10,
  });

  // 邻居定位:各泳道内水平排列。
  for (const spec of THREE_LANES) {
    const laneNeighbors = lanes[spec.key];
    laneNeighbors.forEach((nb, i) => {
      const x = LANE_LABEL_W + EGO_W + 40 + i * (CHIP_W + 16);
      const y = laneY[spec.key] + (LANE_HEIGHT - CHIP_H) / 2;
      nodes.push({
        id: nb.id,
        type: nb.entity,
        position: { x, y },
        data: {
          ...nb.raw,
          label: nb.label,
          sub: nb.sub,
          entity: nb.entity,
          moduleId: nb.moduleId,
          raw: nb.raw,
        },
        draggable: false,
        zIndex: 5,
      });
    });
  }

  // 边:只画 focus↔neighbor + 同泳道 neighbor 间的承重边(不画 neighbor↔neighbor 全连接,降噪)。
  const visibleIds = new Set(nodes.filter((n) => n.type !== "laneBackground").map((n) => n.id));
  const edges = buildEdges(relations, focusId, visibleIds, filters);

  return {
    nodes,
    edges,
    focusEntity,
    focusId,
    laneCounts: {
      authority: lanes.authority.length,
      evidence: lanes.evidence.length,
      execution: lanes.execution.length,
    },
  };
}

function emptyLayout(): SpotlightLayout {
  return {
    nodes: [],
    edges: [],
    focusEntity: null,
    focusId: null,
    laneCounts: { authority: 0, evidence: 0, execution: 0 },
  };
}

function resolveEntityData(
  id: string,
  entity: "task" | "decision" | "fact",
  taskById: ReadonlyMap<string, TaskRow>,
  decisionById: ReadonlyMap<string, DecisionRow>,
  factById: ReadonlyMap<string, FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
  tasks: ReadonlyArray<TaskRow>,
): { label: string; sub?: string; moduleId: string; raw: TaskRow | DecisionRow | FactRef } | null {
  if (entity === "task") {
    const task = taskById.get(id);
    if (!task) return null;
    return { label: task.title, sub: task.coordinationStatus, moduleId: resolveTaskModule(task.module), raw: task };
  }
  if (entity === "decision") {
    const dec = decisionById.get(id);
    if (!dec) return null;
    return { label: dec.title, sub: dec.state, moduleId: resolveDecisionModule(id, relations, tasks), raw: dec };
  }
  const fact = factById.get(id);
  if (fact) {
    return { label: fact.text, sub: fact.invalidated ? "已失效" : fact.category, moduleId: resolveFactModule(id, tasks), raw: fact };
  }
  // anchor-only fact(无 body)。
  const anchor = factAnchors.find((a) => a.factRef === id);
  if (anchor) {
    return {
      label: anchor.factId,
      sub: "anchor",
      moduleId: resolveFactModule(id, tasks),
      raw: { anchor: `${anchor.taskId}/${anchor.factId}`, taskId: anchor.taskId, category: "anchor", text: anchor.factId } as any,
    };
  }
  return null;
}

function addNeighbor(
  ref: string,
  kind: RelationKind,
  axis: SemanticAxis,
  edgeFromFocus: boolean,
  neighborMap: Map<string, Neighbor & { edgeFromFocus: boolean }>,
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
  filters: SpotlightFilter,
): void {
  const parsed = parseEndpoint(ref);
  if (!parsed) return;
  const id = parsed.id; // 归一 nodeId(与边端点对齐)
  if (neighborMap.has(id)) return;
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const decisionById = new Map(decisions.map((d) => [`decision/${d.decisionId}`, d]));
  const factById = new Map(facts.map((f) => [`fact/${f.taskId}/${f.anchor.split("/").pop() ?? f.anchor}`, f]));
  const data = resolveEntityData(id, parsed.entity, taskById, decisionById, factById, factAnchors, relations, tasks);
  if (!data) return;
  // module 筛选(未投影豁免:始终可见,以便用户看到缺字段)。
  if (filters.modules.size > 0 && !filters.modules.has(data.moduleId) && data.moduleId !== UNPROJECTED_MODULE) return;
  neighborMap.set(id, {
    id,
    entity: parsed.entity,
    label: data.label,
    sub: data.sub,
    moduleId: data.moduleId,
    axis,
    kind,
    raw: data.raw,
    edgeFromFocus,
  });
}

function buildEdges(
  relations: ReadonlyArray<RelationEdge>,
  focusId: string,
  visibleIds: ReadonlySet<string>,
  filters: SpotlightFilter,
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const edge of relations) {
    if (!filters.kinds.has(edge.kind)) continue;
    if (!filters.axes[KIND_AXIS[edge.kind] ?? "assoc"]) continue;
    const from = endpointToNodeId(edge.from);
    const to = endpointToNodeId(edge.to);
    if (!visibleIds.has(from) || !visibleIds.has(to)) continue;
    // 只画 focus 参与的边(聚光灯=ego 图,不画 neighbor↔neighbor 全连接)。
    if (from !== focusId && to !== focusId) continue;
    const key = `${from}|${to}|${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const visual = visualForKind(edge.kind);
    const color = `var(--color-axis-${KIND_AXIS[edge.kind]})`;
    edges.push({
      id: `e_${key}`,
      source: from,
      target: to,
      type: "interactive",
      data: { ...edge },
      animated: false,
      style: {
        stroke: color,
        strokeWidth: visual.strokeWidth,
        strokeDasharray: visual.dasharray,
      },
      markerEnd: { type: RFMarkerType.ArrowClosed, color },
    });
  }
  return edges;
}

export type { RelationCoverageRow };
