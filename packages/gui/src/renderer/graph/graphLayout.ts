import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto.ts";
import { parseEndpoint, endpointToNodeId, endpointClaimId } from "./endpoint";
import { STATUS_META } from "../components/badges";
import { AXIS_COLOR_VAR, axisForKind, type SemanticAxis } from "./constants";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType, Position } from "@xyflow/react";

/**
 * 三原语关系图布局器(dec_01KXA7811SVVT8P66HNDFZQ7DF)。
 *
 * 旧版用 dagre 全局 TB + claim 折叠 (graphLayout.ts:155-156 slice(0,2)),
 * 把 decision/dec_x/CH1 塌成 decision/dec_x,关系图变成 hairball 且
 * claim 锚丢失。新版按决策落地路径重构:
 *
 *   1. 聚焦式 ego graph — 以选中实体为中心展开 1-2 跳,不再画全局 dagre。
 *   2. 三泳道布局 — 左(lineage refines/narrows/supersedes) │ 中(claims+coverage) │ 右(derives→task)。
 *   3. claim 一等连接点 — decision 展开成 claim 行(CH/C/RJ),边锚到具体 claim。
 *   4. fact 默认折叠成 claim/task 上的徽章,点开成节点。
 *   5. coverage 灯上 claim,uncovered 高亮为风险。
 *
 * 语义轴 (axis): authority / evidence / execution / assoc。relates 默认关。
 */

// ------------------------------- 类型 -------------------------------

interface CycleWarning {
  nodes: Set<string>;
  edges: Set<string>;
  cycles: string[][];
}

export interface AxisFilter {
  authority: boolean;
  evidence: boolean;
  execution: boolean;
  assoc: boolean;
}

export interface GraphFilterInput {
  modules: Set<string>;
  types: Set<string>;
  axes: AxisFilter;
}

export interface ClaimCoverageInfo {
  claimId: string;
  status: "covered" | "uncovered" | "unknown";
  /** 佐证该 claim 的 fact ref (fact/<task>/<factId>)。 */
  evidenceFacts: string[];
}

export interface LayoutInput {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  /**
   * 可选 — App.tsx 当前未向 GraphView 透传,布局器会从 DecisionClaim.evidence 反推覆盖度。
   * 上游若能提供(kernel projection 直接给的 relation_coverage 行)则用最准状态。
   */
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  /**
   * 保留 factAnchors 入口(triadic-data 已暴露),布局器内部已通过 facts 数组完成查找,
   * 此字段留作后续 fact 折叠徽章 tooltip / 链路回溯扩展点,不做强校验。
   */
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  focusNodeId: string | null;
  /** 已展开的 fact ref 集合 (fact/<task>/<factId>);未展开则折叠为徽章。 */
  expandedFacts: Set<string>;
  filters: GraphFilterInput;
  inLoopNodes: Set<string>;
  inLoopEdges: Set<string>;
}

export interface LayoutOutput {
  nodes: Node[];
  edges: Edge[];
  cycleWarning: { count: number; cycles: string[][] };
  /** 自动选中的 focus id (input.focusNodeId 为空时填回)。 */
  resolvedFocusId: string | null;
  /** Focus 实体的 claim 覆盖信息 (claim 行渲染用)。 */
  focusClaims: ClaimCoverageInfo[];
  /** 图布局的近似宽高,供 GraphView fitView / scroll。 */
  bounds: { width: number; height: number };
}

// --------------------------- 常量 / 工具 ---------------------------

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

function findRelationCycles(edges: { from: string; to: string }[]): CycleWarning {
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

/**
 * 计算 decision 的 claim 覆盖信息。
 *
 * 优先用 coverageRows(kernel 给的最准);若上游没传(App.tsx 不向 GraphView 透传 coverageRows,
 * 但 triadic-data.adaptDecisionRows 已把 coveringFactRef 写进 decision.chosen/rejected[].evidence),
 * 退化到从 DecisionClaim.evidence 反推 — 有证据即 covered,无证据即 uncovered。
 * 这样布局器对 coverageRows 入参不做强依赖,GraphView 不需要改 App.tsx 调用面。
 */
function computeClaimCoverage(
  decision: DecisionRow,
  coverageRows: ReadonlyArray<RelationCoverageRow> | undefined,
): ClaimCoverageInfo[] {
  const byClaim = new Map<string, ClaimCoverageInfo>();
  for (const claim of decision.claims) {
    byClaim.set(claim.id, {
      claimId: claim.id,
      status: "unknown",
      evidenceFacts: [],
    });
  }

  // Path A: coverageRows 优先(状态最准)。
  if (coverageRows && coverageRows.length > 0) {
    const decisionRef = `decision/${decision.decisionId}`;
    for (const row of coverageRows) {
      if (row.decisionRef !== decisionRef) continue;
      const claimId = row.claimRef.split("/")[2];
      if (!claimId) continue;
      const info = byClaim.get(claimId);
      if (!info) continue;
      // 多条 coverage row 取最严状态(uncovered 优先),并合并佐证 fact。
      if (row.status === "uncovered") info.status = "uncovered";
      else if (row.status === "covered" && info.status !== "uncovered") info.status = "covered";
      if (row.coveringFactRef) {
        info.evidenceFacts = [...new Set([...info.evidenceFacts, row.coveringFactRef])];
      }
    }
  }

  // Path B: 退化到 DecisionClaim.evidence (chosen/rejected),补全 status / evidenceFacts。
  // 适 App.tsx 未透传 coverageRows 的场景(GraphView 只拿到 decisions + relations + facts)。
  // 注意:decision.claims 是 {id,text} 列表(全集),chosen/rejected 才有 evidence —
  // 所以先按 id 建索引,再遍历全集 claims 给没有 evidence 的 claim 标 uncovered。
  const evidenceById = new Map<string, string[]>();
  for (const claim of [...decision.chosen, ...decision.rejected]) {
    evidenceById.set(claim.id, claim.evidence);
  }
  for (const claim of decision.claims) {
    const info = byClaim.get(claim.id);
    if (!info) continue;
    const evidence = evidenceById.get(claim.id) ?? [];
    if (evidence.length > 0) {
      info.evidenceFacts = [...new Set([...info.evidenceFacts, ...evidence])];
      if (info.status === "unknown") info.status = "covered";
    } else if (info.status === "unknown") {
      // 仍未被任何路径标 covered → uncovered (风险视角)
      info.status = "uncovered";
    }
  }

  return [...byClaim.values()];
}

/** 默认 focus:claim 最多的 active decision;退化到首条 decision;再退化到首条 task。 */
function pickDefaultFocus(
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

function statusColor(task: TaskRow): string | undefined {
  return STATUS_META[task.coordinationStatus as keyof typeof STATUS_META]?.color;
}

/** 把 RelationEdge 按 axis 过滤(保留 SemanticAxis 满足 filter 的边)。 */
function edgePassesAxisFilter(edge: RelationEdge, axes: AxisFilter): boolean {
  return axes[axisForKind(edge.kind)];
}

function inLoopEdge(loopEdges: Set<string>, edge: RelationEdge): boolean {
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

function buildEdge(input: BuildEdgeInput): Edge {
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

// --------------------------- 主入口 ---------------------------

export async function computeGraphLayout(input: LayoutInput): Promise<LayoutOutput> {
  const {
    tasks,
    relations,
    decisions,
    facts,
    coverageRows,
    focusNodeId,
    expandedFacts,
    filters,
    inLoopNodes,
    inLoopEdges,
  } = input;

  void inLoopNodes;

  const validEdges = relations.filter((e) => parseEndpoint(e.from) && parseEndpoint(e.to));
  const axisPassedEdges = validEdges.filter((e) => edgePassesAxisFilter(e, filters.axes));

  const resolvedFocusId = focusNodeId ?? pickDefaultFocus(decisions, tasks);

  if (!resolvedFocusId) {
    return {
      nodes: [],
      edges: [],
      cycleWarning: { count: 0, cycles: [] },
      resolvedFocusId: null,
      focusClaims: [],
      bounds: { width: 0, height: 0 },
    };
  }

  // 分两类布局:decision focus 走三泳道;其他走简化 ego。
  const focusDecision = decisions.find((d) => `decision/${d.decisionId}` === resolvedFocusId);
  if (focusDecision && filters.types.has("decision")) {
    return layoutThreeLane({
      focusDecision,
      tasks,
      decisions,
      facts,
      relations: axisPassedEdges,
      coverageRows,
      expandedFacts,
      filters,
      inLoopEdges,
    });
  }

  // task / fact focus:简化 ego (1-hop 直接邻居),不画三泳道。
  return layoutSimpleEgo({
    focusId: resolvedFocusId,
    tasks,
    decisions,
    facts,
    relations: axisPassedEdges,
    filters,
    inLoopEdges,
  });
}

// --------------------------- 三泳道布局 (decision focus) ---------------------------

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

function factRefOf(f: FactRef): string {
  return `fact/${f.taskId}/${f.anchor.split("/").pop() ?? f.anchor}`;
}

function layoutThreeLane(input: ThreeLaneInput): LayoutOutput {
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
  claimRows.forEach((row, claimIdx) => {
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

// --------------------------- Simple ego (task / fact focus) ---------------------------

interface SimpleEgoInput {
  focusId: string;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  filters: GraphFilterInput;
  inLoopEdges: Set<string>;
}

function layoutSimpleEgo(input: SimpleEgoInput): LayoutOutput {
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
    let type = entity;
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
