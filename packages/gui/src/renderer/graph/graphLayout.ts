import { parseEndpoint } from "./endpoint";
import { edgePassesAxisFilter, pickDefaultFocus } from "./graphLayoutShared";
import type { LayoutInput, LayoutOutput } from "./graphLayoutTypes";
import { layoutCanvasEgo } from "./canvasEgoLayout";
import { layoutTerritory } from "./territoryLayout";
import { layoutSimpleEgo } from "./simpleEgoLayout";
import { layoutThreeLane } from "./threeLaneLayout";

export type {
  AxisFilter,
  ClaimCoverageInfo,
  GraphFilterInput,
  LayoutInput,
  LayoutOutput,
} from "./graphLayoutTypes";

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

  // L1 领地总览(IA v2 Layer 0):存在 territory 入参即走领地布局(分区成块、点实体切聚光灯)。
  // territory 与 canvas(L2)互斥 —— GraphView 按当前 viewMode 传其一。
  if (input.territory) {
    return layoutTerritory({
      skel: input.territory.skel,
      tasks,
      decisions: decisions ?? [],
      facts: facts ?? [],
      relations: validEdges,
      filters,
      coverageRows,
      expandedZones: input.territory.expandedZones,
    });
  }

  // 无限画布 ego(dec_01KXBGJQFQARSZHHQW1WADFDNC):存在 canvas 累积态即统一走
  // 分层列布局(三类实体一视同仁,decision 的 claim 内联进卡片而非炸成 claim 节点)。
  if (input.canvas) {
    return layoutCanvasEgo({
      focusId: resolvedFocusId,
      tasks,
      decisions,
      facts,
      relations: validEdges, // axis 过滤在布局器内部做(与原型 relOk 一致)
      filters,
      inLoopEdges,
      shown: input.canvas.shown,
      expanded: input.canvas.expanded,
    });
  }

  // 分两类布局(legacy fallback,canvas 缺省时):decision focus 走三泳道;其他走简化 ego。
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
