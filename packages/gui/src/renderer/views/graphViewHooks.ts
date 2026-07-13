import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useReactFlow } from "@xyflow/react";

import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto.ts";
import { endpointToNodeId } from "../graph/endpoint";
import { computeGraphLayout, type GraphFilterInput } from "../graph/graphLayout";
import type { ViewMode, TerritorySkel } from "../graph/useTerritoryView";

/**
 * GraphView 的状态 hook 集合。
 *
 * GraphView 在 600 行复杂度门下,所以把状态机外置于此:
 *   useGraphLayout       — computeGraphLayout 异步调度 + nodes/edges/error 状态。
 *   useCenterOnFocus     — 换焦点即居中(读焦点节点盒子 → setCenter)。
 *   useGraphDrawer       — 抽屉(节点详情 / 边详情)的选中态 + 派生数据 + 回调。
 *   useContainerWidth    — D3:ResizeObserver 测量容器宽度,供领地列数派生。
 *   useNodeSizeOverrides — D4:用户拖拽调整的卡片尺寸 + localStorage 持久化(NodeResizer)。
 *
 * GraphView 本身只做:组合这些 hook + 注入交互回调 + 渲染。
 */

const EMPTY_LOOP = new Set<string>();

// ══ D3:容器宽度测量 ══

/**
 * ResizeObserver 测量容器宽度。返回 ref(贴到容器) + width(像素,未测量=0)。
 * 用于 D3:领地列数由容器宽度派生(deriveGridCols),取代硬编码 GRID_COLS=3。
 */
export function useContainerWidth<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  width: number;
} {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    // 首帧同步取值(ResizeObserver 是异步的,首屏 layout 前给个真值避免兜底 3 列闪一下)
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

// ══ D4:卡片尺寸覆盖 + localStorage 持久化 ══

const SIZE_OVERRIDES_KEY = "harness:gui:ego-card-sizes";

function readSizes(): Map<string, { w: number; h: number }> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(SIZE_OVERRIDES_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const out = new Map<string, { w: number; h: number }>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v && typeof v === "object" &&
        typeof (v as any).w === "number" && typeof (v as any).h === "number"
      ) {
        out.set(k, { w: (v as any).w, h: (v as any).h });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function writeSizes(sizes: ReadonlyMap<string, { w: number; h: number }>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, { w: number; h: number }> = {};
    for (const [k, v] of sizes) obj[k] = v;
    window.localStorage.setItem(SIZE_OVERRIDES_KEY, JSON.stringify(obj));
  } catch {
    // 隐私模式 / quota 满:静默降级,不阻断 UI。
  }
}

/**
 * NodeResizer 拖拽调整后的卡片尺寸,持久化在 localStorage(复用 favorites.ts 模式)。
 * 串过 useGraphLayout → computeGraphLayout → layoutCanvasEgo.nodeDims,使布局器尊重
 * 用户手动调整的尺寸而非每次按内容估算覆盖掉。
 */
export function useNodeSizeOverrides(): {
  sizeOverrides: ReadonlyMap<string, { w: number; h: number }>;
  setSizeOverride: (id: string, size: { w: number; h: number }) => void;
} {
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(() => readSizes());

  const setSizeOverride = useCallback((id: string, size: { w: number; h: number }) => {
    setSizes((prev) => {
      const next = new Map(prev);
      next.set(id, size);
      writeSizes(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIZE_OVERRIDES_KEY) setSizes(readSizes());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { sizeOverrides: sizes, setSizeOverride };
}

// ══ 布局调度 ══

export interface GraphLayoutInput {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  focusId: string | null;
  expandedFacts: Set<string>;
  filters: GraphFilterInput;
  shown: Map<string, number>;
  expanded: Set<string>;
  viewMode: ViewMode;
  skel: TerritorySkel;
  expandedZones: Set<string>;
  /** D3:领地摆放区容器宽度(像素);0 = 未测量 → 兜底 3 列。 */
  containerWidth: number;
  /** D4:用户拖拽的卡片尺寸覆盖;布局器据此而非纯内容估算。 */
  sizeOverrides: ReadonlyMap<string, { w: number; h: number }>;
}

export interface GraphLayoutOutput {
  nodes: any[];
  edges: any[];
  cycleWarning: { count: number; cycles: string[][] };
  error: string | null;
  resolvedFocusId: string | null;
}

/**
 * computeGraphLayout 的 React 封装:异步调度 + AbortController 取消 + 状态托管。
 * 抽出来让 GraphView 只消费 {nodes, edges, ...} 而不关心调度细节。
 */
export function useGraphLayout(input: GraphLayoutInput): GraphLayoutOutput {
  const {
    tasks,
    relations,
    decisions,
    facts,
    coverageRows,
    factAnchors,
    focusId,
    expandedFacts,
    filters,
    shown,
    expanded,
    viewMode,
    skel,
    expandedZones,
    containerWidth,
    sizeOverrides,
  } = input;

  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [cycleWarning, setCycleWarning] = useState<{
    count: number;
    cycles: string[][];
  }>({ count: 0, cycles: [] });
  const [error, setError] = useState<string | null>(null);
  const [resolvedFocusId, setResolvedFocusId] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    computeGraphLayout({
      tasks,
      relations,
      decisions,
      facts,
      coverageRows: coverageRows ?? [],
      factAnchors: factAnchors ?? [],
      focusNodeId: viewMode === "territory" ? null : focusId,
      expandedFacts,
      filters,
      inLoopNodes: EMPTY_LOOP,
      inLoopEdges: EMPTY_LOOP,
      ...(viewMode === "territory"
        ? { territory: { skel, expandedZones, containerWidth } }
        : { canvas: { shown, expanded, sizeOverrides } }),
    })
      .then(({ nodes: rfNodes, edges: rfEdges, cycleWarning: warning, resolvedFocusId: rid }) => {
        if (ac.signal.aborted) return;
        setError(null);
        setNodes(rfNodes);
        setEdges(rfEdges);
        setCycleWarning(warning);
        setResolvedFocusId(rid);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        console.error("Failed to compute graph layout", err);
        setError(err instanceof Error ? err.stack || err.message : String(err));
      });
    return () => ac.abort();
  }, [
    tasks,
    relations,
    decisions,
    facts,
    coverageRows,
    factAnchors,
    focusId,
    expandedFacts,
    filters,
    shown,
    expanded,
    viewMode,
    skel,
    expandedZones,
    containerWidth,
    sizeOverrides,
  ]);

  return { nodes, edges, cycleWarning, error, resolvedFocusId };
}

// ══ 换焦点即居中 ══

// 焦点卡片(360 宽)+ 左右各一列 chip 同屏可读所用的缩放。
const FOCUS_ZOOM = 0.9;

/**
 * 换焦点时把焦点节点摆进视口正中 —— 兑现「以它为中心」,同时躲开左上角 Filters 面板
 * (fitView 按整图 bbox 居中,下游更宽时会把焦点推到左侧压在面板底下)。
 *
 * 从 useEgoCanvas 抽出来,因为 useEgoCanvas 在 hook 调用链里早于 useGraphLayout
 * (布局需要 focusId),拿不到布局后的 nodes。此 hook 在 GraphView 里 useGraphLayout 之后调用,
 * 读真实 nodes + resolvedFocusId 做 setCenter。
 *
 * 只在焦点变化时触发:累积展开 / 长邻居永不重排已有画布。
 */
export function useCenterOnFocus(
  nodes: ReadonlyArray<any>,
  resolvedFocusId: string | null,
): void {
  const { setCenter } = useReactFlow();
  const lastCenteredFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!resolvedFocusId) return;
    if (lastCenteredFocus.current === resolvedFocusId) return;
    const focusNode = nodes.find((n) => n.id === resolvedFocusId);
    if (!focusNode) return;
    lastCenteredFocus.current = resolvedFocusId;
    const cx = focusNode.position.x + Number(focusNode.width ?? 0) / 2;
    const cy = focusNode.position.y + Number(focusNode.height ?? 0) / 2;
    const frame = window.requestAnimationFrame(() => {
      setCenter(cx, cy, { zoom: FOCUS_ZOOM, duration: 320 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedFocusId, nodes, setCenter]);
}

// ══ 抽屉 ══

export interface GraphDrawerInput {
  nodes: ReadonlyArray<any>;
  focusId: string | null;
  relations: RelationEdge[];
  openFocus: (id: string) => void;
  /** 抽屉选中态(节点 id)由 GraphView 持有,使 onEdgeClick/onPaneClick/Esc 能原子更新两 id。 */
  selectedId: string | null;
  focusEdgeId: string | null;
  setSelectedId: (id: string | null) => void;
  setFocusEdgeId: (id: string | null) => void;
}

export interface GraphDrawerOutput {
  selectedId: string | null;
  focusEdgeId: string | null;
  setSelectedId: (id: string | null) => void;
  setFocusEdgeId: (id: string | null) => void;
  closeDrawer: () => void;
  drawerNodesMap: Map<any, any>;
  drawerNodeId: string | null;
  upCount: number;
  downCount: number;
  focusFromDrawer: (id: string | null) => void;
  setDrawerAsFocus: () => void;
}

/**
 * 抽屉(节点详情 / 边详情)状态 + 派生数据 + 回调。
 * selectedId 与 focusEdgeId 独立(点节点开节点抽屉,点边开边抽屉,互不抢)。
 * drawerNodeId 是抽屉里实际展示的节点(优先 selected,fallback focus),upCount/downCount 跟随它。
 */
export function useGraphDrawer(input: GraphDrawerInput): GraphDrawerOutput {
  const { nodes, focusId, relations, openFocus, selectedId, focusEdgeId, setSelectedId, setFocusEdgeId } = input;

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    setFocusEdgeId(null);
  }, [setSelectedId, setFocusEdgeId]);

  // 抽屉里展示的实体(优先 selectedNode,fallback 到 focusNode)。
  const focusNode = focusId ? nodes.find((n) => n.id === focusId) : null;
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const drawerNodeId = selectedNode?.id ?? focusNode?.id ?? null;

  // GraphDrawer 读 closeoutReadiness/engine/freshness/module 等字段,这些只存在于完整
  // TaskRow(n.data.raw)上。修 #1:此前误传 n.data 导致徽章拿 undefined 崩溃。
  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => {
      if (n.type === "moduleGroup" || n.type === "laneBackground") return;
      map.set(n.id, {
        id: n.id,
        entity: n.type === "decisionFocus" ? "decision" : n.type,
        label: n.data.label,
        sub: n.data.sub,
        task: n.type === "task" ? n.data.raw : undefined,
        raw: (n.data?.raw ?? n.data) as typeof n.data,
      });
    });
    return map;
  }, [nodes]);

  const { upCount, downCount } = useMemo(() => {
    if (!drawerNodeId) return { upCount: 0, downCount: 0 };
    let up = 0;
    let down = 0;
    for (const e of relations) {
      const from = endpointToNodeId(e.from);
      const to = endpointToNodeId(e.to);
      if (from === drawerNodeId) down += 1;
      if (to === drawerNodeId) up += 1;
    }
    return { upCount: up, downCount: down };
  }, [drawerNodeId, relations]);

  const focusFromDrawer = useCallback(
    (id: string | null) => {
      if (!id) {
        closeDrawer();
        return;
      }
      setFocusEdgeId(null);
      openFocus(id);
    },
    [closeDrawer, openFocus],
  );

  const setDrawerAsFocus = useCallback(() => {
    if (!drawerNodeId) return;
    openFocus(drawerNodeId);
  }, [drawerNodeId, openFocus]);

  return {
    selectedId,
    focusEdgeId,
    setSelectedId,
    setFocusEdgeId,
    closeDrawer,
    drawerNodesMap,
    drawerNodeId,
    upCount,
    downCount,
    focusFromDrawer,
    setDrawerAsFocus,
  };
}
