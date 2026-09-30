import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  egoOneHopHighlight,
  egoFocusIdOf,
  type EgoAxisFilter,
  type EgoGraph,
  type EgoHopBudget,
} from "./egoCanvas";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";

/**
 * 无限画布 ego 的状态机(dec_01KXBGJQFQARSZHHQW1WADFDNC CH1;2026-10-01 起按视觉规范
 * §5.2 收口单击语义)。
 *
 * 一个焦点 + 一个选中:
 *   focusId  — 画布中心(布局器据此分级)。openFocus / 跳数预算 / 分层开关变化时重铺。
 *   shown    — 可见集 id → 距焦点跳数,由 (焦点, hops, 轴筛选, 重点集) 派生。
 *   selectId — 单击选中(与 focus 正交):节点只做选中态,摘要进抽屉;派生单跳高亮
 *              供灰化其余节点。旧「单击展开成卡片/长出下一环」路径已随 §5.2 删除。
 *
 * 不变量:节点交互不改变布局输入;只有换焦点(双击设为中心 / 领地 chip / 搜索 /
 * 命令面板 / 焦点历史)或显式的视图切换(跳数步进器、重点分层开关)会重铺画布。
 */

/** 宿主未指定跳数时的默认铺开(上游 2 跳 + 下游 2 跳)。 */
export const EGO_DEFAULT_HOPS: EgoHopBudget = { up: 2, down: 2 };

export interface EgoCanvasState {
  graph: EgoGraph;
  focusId: string | null;
  shown: Map<string, number>;
  selectId: string | null;
  highlight: Set<string> | null;
  /** 设为画布中心:切焦点 + 重排 ±hops 跳(双击节点 / 抽屉跳转的唯一重排动作)。 */
  openFocus: (ref: string) => void;
  /** 单击选中 / 再点同节点取消。不改 focus、不重铺。 */
  selectNode: (id: string) => void;
  clearSelect: () => void;
  /** 退出聚焦:清空焦点与选中。 */
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
  /** 铺开跳数预算(父 ↑ / 子 ↓ 各一)。变更时从当前焦点重铺。 */
  hops?: EgoHopBudget;
  /** 重点模式的可见集;null = 不分层(全部可铺开)。焦点自身恒可见。 */
  allowedIds?: ReadonlySet<string> | null;
  /** 分层开关(重点模式)。翻转时从当前焦点重铺;数据刷新引起的集合内容变化不重铺。 */
  layered?: boolean;
}): EgoCanvasState {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [shown, setShown] = useState<Map<string, number>>(() => new Map());
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
      setSelectId(null);
    },
    [graph, axes, hops, allowedIds],
  );
  // 稳定引用:外部 focusRef 变化时才重排,不因 openFocus 身份变动而重排。
  const openFocusRef = useRef(openFocus);
  openFocusRef.current = openFocus;

  const selectNode = useCallback((id: string) => {
    setSelectId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelect = useCallback(() => setSelectId(null), []);

  const clearCanvas = useCallback(() => {
    setFocusId(null);
    setShown(new Map());
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
    selectId,
    highlight,
    openFocus,
    selectNode,
    clearSelect,
    clearCanvas,
  };
}
