import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import { parseEndpoint, endpointToNodeId, endpointClaimId } from "./endpoint";
import { AXIS_COLOR_VAR, axisForKind, type SemanticAxis } from "./constants";
import type { GraphFilterInput, LayoutOutput } from "./graphLayoutTypes";
import { computeClaimCoverage } from "./claimCoverage";
import { buildEdge, factRefOf, findRelationCycles, inLoopEdge, statusColor } from "./graphLayoutShared";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType, Position } from "@xyflow/react";

// Lane X 位置(三泳道)
const LANE_X = { lineage: 40, focus: 460, derives: 900 };
const LANE_WIDTH = 360;
const DECISION_CARD_W = 320;
const DECISION_CARD_PAD_Y = 56;
const CLAIM_ROW_H = 44;
const TASK_W = 220;
const TASK_H = 44;
const TASK_GAP_Y = 16;
const FACT_NODE_R = 16;
const LANE_HEADER_H = 40;
const TOP_PAD = 70;

interface ThreeLaneInput {
  focusDecision: DecisionRow;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[]; // 已过 axis filter
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  expandedFacts: Set<string>;
  filters: GraphFilterInput;
  inLoopEdges: Set<string>;
}

export function layoutThreeLane(input: ThreeLaneInput): LayoutOutput {
  const focus = input.focusDecision;
  const focusId = `decision/${focus.decisionId}`;
  const focusClaims = computeClaimCoverage(focus, input.coverageRows);

  // ---- 边分区 (按 axis + 邻居类型) ----
  const lineage: { edge: RelationEdge; other: DecisionRow }[] = [];
  const derives: { edge: RelationEdge; other: TaskRow; claimId?: string }[] = [];
  const evidence: { edge: RelationEdge; fact: FactRef; claimId?: string }[] = [];
  const assocTasks: { edge: RelationEdge; other: TaskRow; claimId?: string }[] = [];

  for (const edge of input.relations) {
    const fromNode = endpointToNodeId(edge.from);
    const toNode = endpointToNodeId(edge.to);
    if (fromNode !== focusId && toNode !== focusId) continue;

    // claim 锚点(从 focus 端取;另一端是 fact/task 时,focus 端就是 decision/…/CH1)
    const claimFromFocus = fromNode === focusId ? endpointClaimId(edge.from) : endpointClaimId(edge.to);

    const otherRaw = fromNode === focusId ? edge.to : edge.from;
    const otherParsed = parseEndpoint(otherRaw);
    if (!otherParsed) continue;
    const otherId = otherParsed.id;

    const axis = axisForKind(edge.kind);

    if (axis === "authority" && otherParsed.entity === "decision") {
      const d = input.decisions.find((x) => `decision/${x.decisionId}` === otherId);
      if (d) lineage.push({ edge, other: d });
    } else if (axis === "authority" && edge.kind === "derives" && otherParsed.entity === "task") {
      const t = input.tasks.find((x) => x.taskId === otherId);
      if (t) derives.push({ edge, other: t, claimId: claimFromFocus });
    } else if (axis === "execution") {
      const t = input.tasks.find((x) => x.taskId === otherId);
      if (t) derives.push({ edge, other: t, claimId: claimFromFocus });
    } else if (axis === "evidence" && otherParsed.entity === "fact") {
      const f = input.facts.find((x) => factRefOf(x) === otherId);
      if (f) evidence.push({ edge, fact: f, claimId: claimFromFocus });
    } else if (axis === "assoc") {
      if (otherParsed.entity === "task") {
        const t = input.tasks.find((x) => x.taskId === otherId);
        if (t) assocTasks.push({ edge, other: t, claimId: claimFromFocus });
      }
      // assoc→decision 暂不画(避免与 lineage lane 重复)
    } else if (axis === "authority" && edge.kind === "supports" && otherParsed.entity === "task") {
      // supports 偶尔指向 task (执行支撑),归入 derives lane 避免丢失。
      const t = input.tasks.find((x) => x.taskId === otherId);
      if (t) derives.push({ edge, other: t, claimId: claimFromFocus });
    }
  }

  // ---- 几何 ----
  const derivesByClaim = new Map<string, typeof derives>();
  const evidenceByClaim = new Map<string, typeof evidence>();
  for (const info of focusClaims) {
    derivesByClaim.set(info.claimId, []);
    evidenceByClaim.set(info.claimId, []);
  }
  const strayDerives: typeof derives = [];
  for (const item of derives) {
    if (item.claimId && derivesByClaim.has(item.claimId)) {
      derivesByClaim.get(item.claimId)!.push(item);
    } else {
      strayDerives.push(item);
    }
  }
  for (const item of evidence) {
    if (item.claimId && evidenceByClaim.has(item.claimId)) {
      evidenceByClaim.get(item.claimId)!.push(item);
    }
    // evidence 未锚到 claim → 不渲染(fact 必然挂在某条 claim 上)
  }

  const claimRows = focusClaims.map((info) => {
    const dc = derivesByClaim.get(info.claimId) ?? [];
    const ec = evidenceByClaim.get(info.claimId) ?? [];
    const rows = Math.max(1, dc.length, Math.ceil(ec.length / 3));
    return { info, rows, derives: dc, evidence: ec };
  });
  const hasStray = strayDerives.length > 0 || assocTasks.length > 0;
  if (hasStray) {
    claimRows.push({
      info: { claimId: "·", status: "unknown", evidenceFacts: [] },
      rows: Math.max(1, strayDerives.length, assocTasks.length),
      derives: strayDerives,
      evidence: [],
    });
  }

  const cardH = claimRows.reduce((s, r) => s + r.rows * CLAIM_ROW_H, 0) + DECISION_CARD_PAD_Y + 24;
  const cardY = TOP_PAD + LANE_HEADER_H;

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  const totalH = Math.max(cardH + 80, lineage.length * (TASK_H + 12) + 80, 360);

  // Lane 背景
  rfNodes.push({
    id: "lane_lineage",
    type: "laneBackground",
    position: { x: LANE_X.lineage, y: TOP_PAD },
    data: { label: "谱系 · refines / narrows / supersedes", axis: "authority" },
    style: { width: LANE_WIDTH, height: totalH },
    zIndex: -2,
    selectable: false,
    draggable: false,
  });
  rfNodes.push({
    id: "lane_claims",
    type: "laneBackground",
    position: { x: LANE_X.focus, y: TOP_PAD },
    data: { label: "主张 · claims + 覆盖", axis: "focus" },
    style: { width: LANE_WIDTH, height: totalH },
    zIndex: -2,
    selectable: false,
    draggable: false,
  });
  rfNodes.push({
    id: "lane_derives",
    type: "laneBackground",
    position: { x: LANE_X.derives, y: TOP_PAD },
    data: { label: "派生 · derives → task", axis: "execution" },
    style: { width: LANE_WIDTH + 60, height: totalH },
    zIndex: -2,
    selectable: false,
    draggable: false,
  });

  // Focus decision (claim 行展开)
  rfNodes.push({
    id: focusId,
    type: "decisionFocus",
    position: { x: LANE_X.focus + (LANE_WIDTH - DECISION_CARD_W) / 2, y: cardY },
    style: { width: DECISION_CARD_W, height: cardH },
    data: {
      label: focus.title,
      decisionId: focus.decisionId,
      state: focus.state,
      riskTier: focus.riskTier,
      urgency: focus.urgency,
      question: focus.question,
      claims: focus.claims,
      chosen: focus.chosen,
      rejected: focus.rejected,
      claimRows: claimRows.map((r) => ({
        claimId: r.info.claimId,
        status: r.info.status,
        evidenceCount: r.evidence.length,
        derivesCount: r.derives.length,
      })),
      focus: true,
      raw: focus,
    },
    zIndex: 5,
  });

  // Lineage lane (左)
  lineage.forEach((item, i) => {
    const other = item.other;
    const id = `decision/${other.decisionId}`;
    const y = cardY + i * (TASK_H + 12);
    rfNodes.push({
      id,
      type: "decision",
      position: { x: LANE_X.lineage + 20, y },
      style: { width: LANE_WIDTH - 40, height: TASK_H },
      data: {
        label: other.title,
        decisionId: other.decisionId,
        state: other.state,
        riskTier: other.riskTier,
        urgency: other.urgency,
        question: other.question,
        claims: other.claims,
        focus: false,
        dimmed: false,
        raw: other,
      },
    });
    const isLoop = inLoopEdge(input.inLoopEdges, item.edge);
    rfEdges.push(
      buildEdge({
        edgeId: `e_lineage_${i}`,
        edge: item.edge,
        sourceId: id,
        targetId: focusId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        axis: "authority",
        isLoop,
      }),
    );
  });

  // Derives lane (右) — 按 claim 行排布
  let runningY = cardY + DECISION_CARD_PAD_Y;
  const claimYById = new Map<string, number>();
  claimRows.forEach((row) => {
    claimYById.set(row.info.claimId, runningY);
    row.derives.forEach((item, i) => {
      const t = item.other;
      const id = t.taskId;
      const y = runningY + i * (TASK_H + TASK_GAP_Y);
      rfNodes.push({
        id,
        type: "task",
        position: { x: LANE_X.derives + 20, y },
        style: { width: TASK_W, height: TASK_H },
        data: {
          label: t.title,
          taskId: t.taskId,
          coordinationStatus: t.coordinationStatus,
          color: statusColor(t),
          focus: false,
          dimmed: false,
          raw: t,
        },
      });
      const isLoop = inLoopEdge(input.inLoopEdges, item.edge);
      rfEdges.push(
        buildEdge({
          edgeId: `e_derives_${row.info.claimId}_${i}`,
          edge: item.edge,
          sourceId: focusId,
          targetId: id,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          axis: axisForKind(item.edge.kind),
          sourceClaimId: row.info.claimId !== "·" ? row.info.claimId : undefined,
          isLoop,
        }),
      );
    });
    runningY += row.rows * CLAIM_ROW_H;
  });

  // Assoc (松关联) → 右泳道下方
  if (assocTasks.length > 0) {
    const assocStartY = runningY + 24;
    assocTasks.forEach((item, i) => {
      const t = item.other;
      const id = `${t.taskId}__assoc`;
      rfNodes.push({
        id,
        type: "task",
        position: { x: LANE_X.derives + 20, y: assocStartY + i * (TASK_H + TASK_GAP_Y) },
        style: { width: TASK_W, height: TASK_H, opacity: 0.85 },
        data: {
          label: t.title,
          taskId: t.taskId,
          coordinationStatus: t.coordinationStatus,
          color: statusColor(t),
          focus: false,
          dimmed: false,
          raw: t,
          assoc: true,
        },
      });
      const isLoop = inLoopEdge(input.inLoopEdges, item.edge);
      rfEdges.push(
        buildEdge({
          edgeId: `e_assoc_${i}`,
          edge: item.edge,
          sourceId: focusId,
          targetId: id,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          axis: "assoc",
          sourceClaimId: item.claimId,
          isLoop,
        }),
      );
    });
  }

  // Evidence facts — 折叠为 claim 徽章 (默认);展开后画 fact 节点
  claimRows.forEach((row) => {
    if (row.info.claimId === "·") return;
    const claimRef = `decision/${focus.decisionId}/${row.info.claimId}`;
    const cov = (input.coverageRows ?? []).filter((c) => c.claimRef === claimRef);
    const factRefs = [...new Set(cov.flatMap((c) => (c.coveringFactRef ? [c.coveringFactRef] : [])))];
    const edgeFactRefs = row.evidence.map((e) => factRefOf(e.fact));
    const allRefs = [...new Set([...factRefs, ...edgeFactRefs])];

    const claimY = claimYById.get(row.info.claimId) ?? cardY + DECISION_CARD_PAD_Y;

    allRefs.forEach((factRef, i) => {
      if (!input.expandedFacts.has(factRef)) return;
      const f = input.facts.find((x) => factRefOf(x) === factRef);
      if (!f) return;
      const col = i % 2;
      const rr = Math.floor(i / 2);
      const fx = LANE_X.focus + DECISION_CARD_W + 20 + col * (FACT_NODE_R * 2 + 8);
      const fy = claimY + 8 + rr * (FACT_NODE_R * 2 + 6);
      rfNodes.push({
        id: factRef,
        type: "fact",
        position: { x: fx, y: fy },
        style: { width: FACT_NODE_R * 2, height: FACT_NODE_R * 2 },
        data: {
          label: f.anchor.split("/").pop() ?? f.anchor,
          sub: f.category,
          text: f.text,
          at: f.at,
          taskId: f.taskId,
          anchor: f.anchor,
          focus: false,
          dimmed: false,
          raw: f,
        },
      });
      rfEdges.push({
        id: `e_evid_${row.info.claimId}_${i}`,
        source: focusId,
        sourceHandle: `claim-${row.info.claimId}`,
        target: factRef,
        type: "interactive",
        data: { kind: "evidenced-by", from: claimRef, to: factRef, provenance: "local-document", axis: "evidence" as SemanticAxis },
        style: {
          stroke: AXIS_COLOR_VAR.evidence,
          strokeWidth: 1.5,
        },
        markerEnd: { type: RFMarkerType.ArrowClosed, color: AXIS_COLOR_VAR.evidence },
      });
    });
  });

  const normalizedEdges = rfEdges.map((e) => ({ from: e.source, to: e.target }));
  const cycleWarning = findRelationCycles(normalizedEdges);

  return {
    nodes: rfNodes,
    edges: rfEdges,
    cycleWarning: { count: cycleWarning.cycles.length, cycles: cycleWarning.cycles },
    resolvedFocusId: focusId,
    focusClaims,
    bounds: { width: LANE_X.derives + LANE_WIDTH + 80, height: totalH + TOP_PAD + 40 },
  };
}
