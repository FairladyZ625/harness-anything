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
