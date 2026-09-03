import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  egoNeighborsOf,
  egoOneHopHighlight,
  egoFocusIdOf,
  type EgoAxisFilter,
  type EgoGraph,
  type EgoHopBudget,
} from "./egoCanvas";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";

/**
 * 无限画布 ego 的状态机(dec_01KXBGJQFQARSZHHQW1WADFDNC CH1)。
 *
 * 一个焦点 + 两个累积集:
 *   focusId  — 画布中心(布局器据此分级)。
 *   shown    — 累积可见集 id → 距焦点跳数。设焦点铺 ±2 跳;展开卡片时长出它的一跳邻居;
 *              收起**不撤**任何节点。
 *   expanded — 渲染为详情卡片的 id,其余是紧凑 chip。
 *   selectId — 单击选中(与 focus 正交),派生单跳高亮供灰化其余节点。
 *
 * 不变量(决策原文「累计保留、永不重置、单击永不重排画布」):
 *   只有 openFocus / 历史前后退会重排画布;expandNode 只往 shown 加,collapseNode 只从
 *   expanded 减 —— 两者都不动已铺开的可见集,因此布局输入的列结构保持稳定。
 */

/** 宿主未指定跳数时的默认铺开(上游 2 跳 + 下游 2 跳)。 */
export const EGO_DEFAULT_HOPS: EgoHopBudget = { up: 2, down: 2 };

export interface EgoCanvasState {
  graph: EgoGraph;
  focusId: string | null;
  shown: Map<string, number>;
  expanded: Set<string>;
  selectId: string | null;
  highlight: Set<string> | null;
  /** 设为画布中心:切焦点 + 重排 ±2 跳(唯一会重排的动作)。 */
  openFocus: (ref: string) => void;
  /** chip 就地展开成卡片,并把它的一跳邻居加入 shown(长出下一环,累积)。 */
  expandNode: (id: string) => void;
  /** 收起卡片,已展开邻居全部保留。 */
  collapseNode: (id: string) => void;
  /** 单击选中 / 再点同节点取消。不改 focus、不重排。 */
  selectNode: (id: string) => void;
  clearSelect: () => void;
  /** 退出聚焦:清空焦点与累积态。 */
  clearCanvas: () => void;
}

export function useEgoCanvas({
  tasks,
  decisions,
  facts,
  relations,
  factAnchors,
  agents = [],
  schedules = [],
  governed = [],
  axes,
  focusRef,
  hops = EGO_DEFAULT_HOPS,
  allowedIds = null,
  layered = false,
}: {
  tasks: ReadonlyArray<TaskRow>;
  decisions: ReadonlyArray<DecisionRow>;
  facts: ReadonlyArray<FactRef>;
  relations: ReadonlyArray<RelationEdge>;
  factAnchors: ReadonlyArray<FactAnchorRow>;
  agents?: ReadonlyArray<AgentNodeRow>;
  schedules?: ReadonlyArray<ScheduleNodeRow>;
  /** 声明实体行(vertical kind);缺省 = 该层缺席,图照常。 */
  governed?: ReadonlyArray<GovernedEntityRow>;
  axes: EgoAxisFilter;
  focusRef: string | null;
  /** 铺开跳数预算(父 ↑ / 子 ↓ 各一)。变更时从当前焦点重铺,累积展开集随之清空。 */
  hops?: EgoHopBudget;
  /** 重点模式的可见集;null = 不分层(全部可铺开)。焦点自身恒可见。 */
  allowedIds?: ReadonlySet<string> | null;
  /** 分层开关(重点模式)。翻转时从当前焦点重铺;数据刷新引起的集合内容变化不重排。 */
  layered?: boolean;
}): EgoCanvasState {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [shown, setShown] = useState<Map<string, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectId, setSelectId] = useState<string | null>(null);

  const graph = useMemo(
    () => buildEgoGraph(tasks, decisions, facts, relations, factAnchors, { agents, schedules }, governed),
    [tasks, decisions, facts, relations, factAnchors, agents, schedules, governed],
  );

  const highlight = useMemo(() => egoOneHopHighlight(graph, selectId, axes), [graph, selectId, axes]);

  const openFocus = useCallback(
    (ref: string) => {
      const canonical = egoFocusIdOf(ref);
      setFocusId(canonical);
      setShown(bfsShownFromFocus(graph, canonical, hops, axes, allowedIds));
      // 焦点默认展开成卡片(它是阅读主体),邻居保持紧凑 chip。
      setExpanded(new Set([canonical]));
      setSelectId(null);
    },
    [graph, axes, hops, allowedIds],
  );
  // 稳定引用:外部 focusRef 变化时才重排,不因 openFocus 身份变动而重排。
  const openFocusRef = useRef(openFocus);
  openFocusRef.current = openFocus;

  const expandNode = useCallback(
    (id: string) => {
      setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setShown((prev) => {
        const next = new Map(prev);
        const base = next.get(id) ?? 0;
        for (const neighbor of egoNeighborsOf(graph, id, axes)) {
          if (!next.has(neighbor)) next.set(neighbor, base + 1);
        }
        return next.size === prev.size ? prev : next;
      });
    },
    [graph, axes],
  );

  const collapseNode = useCallback((id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelect = useCallback(() => setSelectId(null), []);

  const clearCanvas = useCallback(() => {
    setFocusId(null);
    setShown(new Map());
    setExpanded(new Set());
    setSelectId(null);
  }, []);

  // 外部焦点(领地 chip / 命令面板 / 焦点历史)到达 → 重排画布到该焦点。
  // 密度分层开关翻转、跳数预算变更同样重铺(两者都是显式的视图切换,后者来自图谱页
  // 的「父 ↑ / 子 ↓」步进器);重点集内容随数据刷新变化不在此列 —— 那不是用户动作,
  // 不该清掉已铺开的画布。
  useEffect(() => {
    if (!focusRef) return;
    openFocusRef.current(focusRef);
  }, [focusRef, layered, hops]);

  return {
    graph,
    focusId,
    shown,
    expanded,
    selectId,
    highlight,
    openFocus,
    expandNode,
    collapseNode,
    selectNode,
    clearSelect,
    clearCanvas,
  };
}
