import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto.ts";
import type { Node, Edge } from "@xyflow/react";

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
  /**
   * 无限画布 ego 累积态(dec_01KXBGJQFQARSZHHQW1WADFDNC)。存在即走 layoutCanvasEgo
   * (三类实体统一、按跳级分层列、原地展开累计保留),旁路 simpleEgo/threeLane。
   *   shown    — 累积可见集 node id → 距焦点跳数。
   *   expanded — 渲染为详情卡片的 node id 集(其余紧凑 chip)。
   */
  canvas?: { shown: Map<string, number>; expanded: Set<string> };
  /**
   * L1 领地总览(IA v2 Layer 0)。存在即走 layoutTerritory —— 把台账按 rootTask /
   * supersede-refine 链分区成「领地块」,一块一块地铺开,点块内实体 → 切到聚光灯(L2)。
   * 与 canvas(L2)互斥:territory 在则 canvas 不传,反之亦然。
   *   skel          — 骨架轴(task 按 milestone / decision 按 supersede-refine 家族 + 落地)。
   *   expandedZones — 已展开(不折叠 done/planned)的 zone id 集;默认折叠 hot-only。
   */
  territory?: { skel: "task" | "decision"; expandedZones: Set<string> };
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
