import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  egoNeighborsOf,
  egoFocusIdOf,
  type EgoAxisFilter,
  type EgoGraph,
  type EgoHopBudget,
} from "./egoCanvas";
import { clearEgoSession, mergeEgoSession, readEgoSessionFor, type EgoSessionEntry } from "./egoSession";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";

/**
 * 无限画布 ego 的状态机(dec_01KXBGJQFQARSZHHQW1WADFDNC CH1;图场景 2026-10-02 起
 * 恢复节点原位展开,task_baca8e2b3e32c288fbd14b71f0)。
 *
 * 一个焦点 + 两个累积集:
 *   focusId  — 画布中心(布局器据此分级)。openFocus / 跳数预算 / 分层开关变化时重铺。
 *   shown    — 累积可见集 id → 距焦点跳数。设焦点铺 ±hops 跳;展开卡片时长出它的一跳
 *              邻居;收起**不撤**任何节点(「Esc 收正文不误删探索范围」)。
 *   expanded — 渲染为原位卡片的 id,其余是紧凑 chip。焦点默认展开(它是阅读主体)。
 *
 * 不变量:节点交互不改变布局输入的列结构;只有换焦点(双击设为中心 / 领地 chip /
 * 搜索 / 命令面板 / 焦点历史)或显式的视图切换(跳数步进器、重点分层开关)会重铺。
 *
 * 会话恢复:挂载时若 egoSession 里有同仓同焦点的上一段会话(详情页返回),初始态直接
 * 取会话内容并跳过首个重铺 effect —— 焦点/铺开/展开原样接续;相机也不平移
 * (viewport 由宿主按会话恢复)。
 */

/** 宿主未指定跳数时的默认铺开(上游 2 跳 + 下游 2 跳)。 */
export const EGO_DEFAULT_HOPS: EgoHopBudget = { up: 2, down: 2 };

export interface EgoCanvasState {
  graph: EgoGraph;
  focusId: string | null;
  shown: Map<string, number>;
  expanded: Set<string>;
  /** 本次挂载是否从会话恢复(恢复的那一拍不重铺、不平移相机)。 */
  restored: boolean;
  /** 设为画布中心:切焦点 + 重排 ±hops 跳(双击节点 / 卡片「设为焦点」的唯一重排动作)。 */
  openFocus: (ref: string) => void;
  /** chip 就地展开成卡片,并把它的一跳邻居加入 shown(长出下一环,累积)。 */
  expandNode: (id: string) => void;
  /** 收起卡片,已展开邻居全部保留。 */
  collapseNode: (id: string) => void;
  /** 收起全部卡片(Esc):只收阅读层,探索范围(shown)不动。 */
  collapseAll: () => void;
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
  repoId,
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
  /** 会话归属仓(egoSession 的隔离键;同名 ref 跨仓不互读)。 */
  repoId: string;
  focusRef: string | null;
  /** 铺开跳数预算(父 ↑ / 子 ↓ 各一)。变更时从当前焦点重铺,累积展开集随之清空。 */
  hops?: EgoHopBudget;
  /** 重点模式的可见集;null = 不分层(全部可铺开)。焦点自身恒可见。 */
  allowedIds?: ReadonlySet<string> | null;
  /** 分层开关(重点模式)。翻转时从当前焦点重铺;数据刷新引起的集合内容变化不重铺。 */
  layered?: boolean;
}): EgoCanvasState {
  // 会话恢复只在挂载时判定一次:同焦点的上一段会话原样接续,不做任何重铺。
  const hydrationRef = useRef<EgoSessionEntry | null | undefined>(undefined);
  if (hydrationRef.current === undefined) hydrationRef.current = readEgoSessionFor(repoId, focusRef);
  const hydration = hydrationRef.current;
  const restored = hydration !== null;
  const [focusId, setFocusId] = useState<string | null>(hydration?.focusRef ?? null);
  const [shown, setShown] = useState<Map<string, number>>(() => new Map(hydration?.shown ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(hydration?.expanded ?? []));
  const skipFirstLayoutRef = useRef(restored);

  const graph = useMemo(
    () => buildEgoGraph(tasks, decisions, facts, relations, factAnchors, { agents, schedules }, governed),
    [tasks, decisions, facts, relations, factAnchors, agents, schedules, governed],
  );

  const openFocus = useCallback(
    (ref: string) => {
      const canonical = egoFocusIdOf(ref);
      setFocusId(canonical);
      setShown(bfsShownFromFocus(graph, canonical, hops, axes, allowedIds));
      // 焦点默认展开成卡片(它是阅读主体),邻居保持紧凑 chip。
      setExpanded(new Set([canonical]));
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

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const clearCanvas = useCallback(() => {
    setFocusId(null);
    setShown(new Map());
    setExpanded(new Set());
    clearEgoSession();
  }, []);

  // 外部焦点(领地 chip / 命令面板 / 焦点历史)到达 → 重排画布到该焦点。
  // 密度分层开关翻转、跳数预算变更同样重铺(两者都是显式的视图切换,后者来自图谱页
  // 的「父 ↑ / 子 ↓」步进器);换仓也重铺 —— App 不按仓重挂本组件,而 ref 只在仓内
  // 唯一,同名实体的铺开/展开不能跨仓串场(egoSession 同口径)。重点集内容随数据
  // 刷新变化不在此列 —— 那不是用户动作,不该清掉已铺开的画布。会话恢复的那一次
  // 挂载被跳过(状态已从会话种入)。
  useEffect(() => {
    if (!focusRef) return;
    if (skipFirstLayoutRef.current) {
      skipFirstLayoutRef.current = false;
      return;
    }
    openFocusRef.current(focusRef);
  }, [focusRef, repoId, layered, hops]);

  // 会话落盘:焦点/铺开/展开变化即写入(详情页返回靠它接续);换仓的写入重置槽。
  useEffect(() => {
    if (focusId === null) return;
    mergeEgoSession(repoId, { focusRef: focusId, shown: [...shown], expanded: [...expanded] });
  }, [repoId, focusId, shown, expanded]);

  return {
    graph,
    focusId,
    shown,
    expanded,
    restored,
    openFocus,
    expandNode,
    collapseNode,
    collapseAll,
    clearCanvas,
  };
}
