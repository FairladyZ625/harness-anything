import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { AxisFilter } from "./graphLayoutTypes";
import { endpointToNodeId } from "./endpoint";
import { buildEgoGraph, bfsShown, neighborsOf, egoFocusIdOf, type EgoGraph } from "./canvasEgoLayout";
import { pickDefaultFocus } from "./graphLayoutShared";
import {
  createFocusHistory,
  currentFocus,
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  goBack as historyGoBack,
  goForward as historyGoForward,
  pushFocus,
  type FocusHistoryState,
} from "./focusHistory";

/**
 * 无限画布 ego 的状态机(dec_01KXBGJQFQARSZHHQW1WADFDNC)。
 *
 * 一个焦点 + 两个累积集,外加焦点历史与「换焦点即居中」的视口动作:
 *   focusId  — 当前画布中心(布局器据此分级)。
 *   shown    — 累积可见集 node id → 距焦点跳数。openFocus 铺 ±2;展开卡片时长出
 *              它的一跳邻居;收起**不撤**任何节点(累计保留)。
 *   expanded — 渲染为详情卡片的 node id,其余是紧凑 chip。
 *
 * 不变量:只有 openFocus / 历史前进后退会重排画布(resetCanvasTo);单击展开、
 * 收起都只增不减,永不重排已铺开的画布。
 */

// openFocus 默认铺开的跳数(上游 2 跳 + 下游 2 跳)。
const DEFAULT_HOPS = 2;

export interface EgoCanvas {
  focusId: string | null;
  shown: Map<string, number>;
  expanded: Set<string>;
  canBack: boolean;
  canForward: boolean;
  /** 设为画布中心:切焦点 + 推历史 + 重排 ±2 跳。 */
  openFocus: (id: string) => void;
  /** chip 就地展开成卡片,并把它的一跳邻居加入 shown(长出下一环,累积)。 */
  expandNode: (id: string) => void;
  /** 收起卡片,保留已展开邻居(累计保留)。 */
  collapseNode: (id: string) => void;
  /** 退出聚焦:清空焦点与累积态(不脚印化,不动历史)。 */
  clearFocus: () => void;
  goBack: () => void;
  goForward: () => void;
}

export function useEgoCanvas({
  tasks,
  decisions,
  facts,
  relations,
  axes,
  focusRef,
  onFocusChange,
}: {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  axes: AxisFilter;
  focusRef?: string | null;
  /**
   * 焦点变更上行(G3 §④2 根因修复)。画布内双击 / Switcher / 抽屉「设为焦点」触发
   * openFocus 时,通过此回调把新焦点回灌给 AppLocation.focusedEntityRef —— 这样切换
   * facet(关系→演化)时,GenealogyTimelineView 能拿到正确的 decision ref。
   *
   * 不上行 = 焦点只活在 GraphView 本地,一换面就丢。不传则维持旧行为(纯本地)。
   *
   * 收敛性:focusRef prop 变化时 bootstrap effect 也会调 openFocus → 同一 id 二次上行
   * → App.tsx 的 navigate 走 locationsEqual 去重 → 无穷循环被结构性切断。
   */
  onFocusChange?: (id: string | null) => void;
}): EgoCanvas {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [history, setHistory] = useState<FocusHistoryState>(createFocusHistory);
  const [shown, setShown] = useState<Map<string, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 统一图(byId + adj,含合成 task 父子边),供 openFocus / 展开的 BFS 遍历复用。
  const egoGraph: EgoGraph = useMemo(
    () => buildEgoGraph(tasks, decisions, facts, relations),
    [tasks, decisions, facts, relations],
  );

  // 重排画布到某焦点:铺开前后各 2 跳、只展开焦点自身(累积态重置)。
  const resetCanvasTo = useCallback(
    (id: string) => {
      setShown(bfsShown(egoGraph, id, DEFAULT_HOPS, axes));
      setExpanded(new Set([id]));
    },
    [egoGraph, axes],
  );

  const openFocus = useCallback(
    (id: string) => {
      // D1:ego 图入口不变量。territory chip 发射的 navRef 是 `task/<id>` 形态,而 ego
      // byId 键为裸 task id —— 不归一直接传会让焦点命中失败 → 空白画布。所有入口
      // (territory chip / FocusSwitcher / 双击 / 抽屉「设为焦点」/ 历史前后退)都经此归一,
      // 把 endpoint 形态收敛到 byId 键空间。裸 id 原样通过(幂等)。
      const canonical = egoFocusIdOf(id);
      setFocusId(canonical);
      setHistory((prev) => pushFocus(prev, canonical)); // 重复推同 id 会被 pushFocus 折叠
      resetCanvasTo(canonical);
      // G3 §④2:上行同步 AppLocation.focusedEntityRef。换焦点不只改本地,还要让
      // EntityWorkspace 的 facet 切换(关系↔演化)能拿到最新焦点。
      if (onFocusChange) onFocusChange(canonical);
    },
    [resetCanvasTo, onFocusChange],
  );
  // 稳定引用:bootstrap effect 只在 focusRef / 数据变时触发,不因 openFocus 身份变动而重排。
  const openFocusRef = useRef(openFocus);
  openFocusRef.current = openFocus;

  const expandNode = useCallback(
    (id: string) => {
      setExpanded((prev) => new Set(prev).add(id));
      setShown((prev) => {
        const next = new Map(prev);
        const base = next.get(id) ?? 0;
        for (const nb of neighborsOf(egoGraph, id, axes)) {
          if (!next.has(nb)) next.set(nb, base + 1);
        }
        return next;
      });
    },
    [egoGraph, axes],
  );

  const collapseNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setFocusId(null);
    setShown(new Map());
    setExpanded(new Set());
    // 不动历史:用户「退出聚焦」不脚印化。清空后 bootstrap 会重开默认焦点。
    // D6:同步清空 AppLocation.focusedEntityRef,否则切到演化史仍显示旧 decision。
    if (onFocusChange) onFocusChange(null);
  }, [onFocusChange]);

  // 历史前进 / 后退:切焦点 + 重排画布(不重复推栈)。
  // D6:必须与 openFocus 一样上行 onFocusChange —— FocusHistoryBar 的 back/forward
  // 只改本地 history 时,AppLocation.focusedEntityRef 会停在旧 decision,演化史开错谱系。
  const stepHistory = useCallback(
    (step: (prev: FocusHistoryState) => FocusHistoryState) => {
      setHistory((prev) => {
        const next = step(prev);
        if (next === prev) return prev;
        const f = currentFocus(next);
        setFocusId(f);
        if (f) resetCanvasTo(f);
        if (onFocusChange) onFocusChange(f);
        return next;
      });
    },
    [resetCanvasTo, onFocusChange],
  );
  const goBack = useCallback(() => stepHistory(historyGoBack), [stepHistory]);
  const goForward = useCallback(() => stepHistory(historyGoForward), [stepHistory]);

  // 跨视图带入的 focusRef → 打开该焦点(用户「跳到这张图」的足迹)。
  useEffect(() => {
    if (!focusRef) return;
    const nodeId = endpointToNodeId(focusRef);
    if (nodeId) openFocusRef.current(nodeId);
  }, [focusRef]);

  // 首次(数据到位而未聚焦、且无外部 focusRef)= 打开默认焦点,铺开 ±2。
  useEffect(() => {
    if (focusId || focusRef) return;
    const def = pickDefaultFocus(decisions, tasks);
    if (def) openFocusRef.current(def);
  }, [focusId, focusRef, decisions, tasks]);

  return {
    focusId,
    shown,
    expanded,
    canBack: historyCanGoBack(history),
    canForward: historyCanGoForward(history),
    openFocus,
    expandNode,
    collapseNode,
    clearFocus,
    goBack,
    goForward,
  };
}
