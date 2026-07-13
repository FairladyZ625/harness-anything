import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  Panel,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type {
  TaskRow,
  RelationEdge,
  DecisionRow,
  FactRef,
} from "../model/types";
import type {
  RelationCoverageRow,
  FactAnchorRow,
} from "../../api/renderer-dto.ts";
import { endpointToNodeId } from "../graph/endpoint";
import { GraphDrawer } from "../graph/GraphDrawer";
import {
  computeGraphLayout,
  type AxisFilter,
  type GraphFilterInput,
} from "../graph/graphLayout";
import {
  buildEgoGraph,
  bfsShown,
  neighborsOf,
  type EgoGraph,
} from "../graph/canvasEgoLayout";
import { pickDefaultFocus } from "../graph/graphLayoutShared";
import {
  createFocusHistory,
  currentFocus,
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  goBack as historyGoBack,
  goForward as historyGoForward,
  pushFocus,
  type FocusHistoryState,
} from "../graph/focusHistory";

import { TaskNode } from "../graph/nodes/TaskNode";
import { DecisionNode } from "../graph/nodes/DecisionNode";
import { DecisionFocusNode } from "../graph/nodes/DecisionFocusNode";
import { FactNode } from "../graph/nodes/FactNode";
import { EgoNode } from "../graph/nodes/EgoNode";
import { ModuleGroupNode } from "../graph/nodes/ModuleGroupNode";
import { LaneBackgroundNode } from "../graph/nodes/LaneBackgroundNode";
import { InteractiveEdge } from "../graph/edges/InteractiveEdge";
import {
  GraphFilterPanel,
  type GraphFilters,
} from "../components/GraphFilterPanel";
import { FocusSwitcher } from "../components/FocusSwitcher";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { useColorMode } from "./graphColorMode";
import { GraphLegend } from "./GraphLegend";

const nodeTypes = {
  task: TaskNode,
  decision: DecisionNode,
  decisionFocus: DecisionFocusNode,
  fact: FactNode,
  ego: EgoNode,
  moduleGroup: ModuleGroupNode,
  laneBackground: LaneBackgroundNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

const EMPTY_LOOP = new Set<string>();

// 换焦点时把焦点摆到视口正中所用的缩放:焦点卡片(360 宽)+ 左右各一列 chip 同屏可读。
const FOCUS_ZOOM = 0.9;

const MINIMAP_AXIS: Record<string, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
  fact: "var(--color-axis-evidence)",
};

function defaultAxes(): AxisFilter {
  // relates (assoc) 默认关 — dec_01KXA7811SVVT8P66HNDFZQ7DF CH4。
  return { authority: true, evidence: true, execution: true, assoc: false };
}

function GraphViewInner({
  tasks,
  relations,
  decisions,
  facts,
  coverageRows,
  factAnchors,
  onNavigateEntity,
  focusRef,
}: {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions?: DecisionRow[];
  facts?: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity?: (ref: string) => void;
  focusRef?: string | null;
}) {
  const { setCenter } = useReactFlow();
  const colorMode = useColorMode();

  // 节点焦点(布局重算依赖)+ 边焦点(仅抽屉展示)。修 #3:此前用单一 focusId
  // 同时承载节点和边,点边时把 edge id 当 focusNodeId 传给布局器,导致
  // layoutSimpleEgo 拿不到节点 → 整张图塌成单个空节点。
  //
  // GUI 可用性补齐(dec_01KXA7811SVVT8P66HNDFZQ7DF):拆开「选中」与「聚焦」。
  //   focusId    — 布局焦点(三泳道中心 / ego 中心)。受 FocusSwitcher / 双击 /
  //                 抽屉「设为焦点」/ 跨视图 focusRef 驱动,所有变更入焦点历史。
  //   selectedId — 抽屉里展示的节点(单击节点选中)。点空白 / Esc / 抽屉关闭即清空。
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusEdgeId, setFocusEdgeId] = useState<string | null>(null);
  const [resolvedFocusId, setResolvedFocusId] = useState<string | null>(null);
  const [expandedFacts] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<FocusHistoryState>(createFocusHistory);

  // 无限画布 ego 累积态(dec_01KXBGJQFQARSZHHQW1WADFDNC):
  //   shown    — 累积可见集 node id → 距焦点跳数(openFocus 铺 ±2,展开时长邻居,收起不撤)。
  //   expanded — 渲染为详情卡片的 node id(其余紧凑 chip)。
  const [shown, setShown] = useState<Map<string, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 焦点切换统一入口:更新 focusId + 推历史。重复推同 id 会被 pushFocus 折叠。
  const setFocusAndPushHistory = useCallback((id: string) => {
    setFocusId(id);
    setHistory((prev) => pushFocus(prev, id));
  }, []);

  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [cycleWarning, setCycleWarning] = useState<{
    count: number;
    cycles: string[][];
  }>({ count: 0, cycles: [] });
  const [error, setError] = useState<string | null>(null);

  const availableModules = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.module))).sort(),
    [tasks],
  );

  const [filters, setFilters] = useState<GraphFilters>(() => ({
    modules: new Set(tasks.map((t) => t.module)),
    types: new Set(["decision", "task", "fact"] as const),
    axes: defaultAxes(),
  }));

  useEffect(() => {
    setFilters((current) => {
      const nextModules = new Set(availableModules);
      if (
        current.modules.size === nextModules.size &&
        [...current.modules].every((m) => nextModules.has(m))
      ) {
        return current;
      }
      return { ...current, modules: nextModules };
    });
  }, [availableModules]);

  const layoutInputFilters: GraphFilterInput = useMemo(
    () => ({
      modules: filters.modules,
      types: filters.types,
      axes: filters.axes,
    }),
    [filters],
  );

  // 统一图(byId + adj,含合成 task 父子边),供 openFocus/reveal 的 BFS 遍历复用。
  const egoGraph: EgoGraph = useMemo(
    () => buildEgoGraph(tasks, decisions ?? [], facts ?? [], relations),
    [tasks, decisions, facts, relations],
  );

  // 重排画布到某焦点:铺开前后各 2 跳、只展开焦点自身(累积态重置)。
  const resetCanvasTo = useCallback(
    (id: string) => {
      setShown(bfsShown(egoGraph, id, 2, filters.axes));
      setExpanded(new Set([id]));
    },
    [egoGraph, filters.axes],
  );

  // 打开焦点(双击 / switcher / 抽屉 / 跨视图)= 设焦点 + 推历史 + 重排 ±2。
  const openFocus = useCallback(
    (id: string) => {
      setFocusAndPushHistory(id);
      resetCanvasTo(id);
    },
    [setFocusAndPushHistory, resetCanvasTo],
  );
  // 稳定引用:effect 只在 focusRef / 数据变时触发,不因 openFocus 身份变动而重排画布。
  const openFocusRef = useRef(openFocus);
  openFocusRef.current = openFocus;

  // chip 就地展开成卡片,并把它通过轴过滤的一跳邻居加入 shown(长出下一环,累积)。
  const expandNode = useCallback(
    (id: string) => {
      setExpanded((prev) => new Set(prev).add(id));
      setShown((prev) => {
        const next = new Map(prev);
        const base = next.get(id) ?? 0;
        for (const nb of neighborsOf(egoGraph, id, filters.axes)) {
          if (!next.has(nb)) next.set(nb, base + 1);
        }
        return next;
      });
    },
    [egoGraph, filters.axes],
  );

  // 收起卡片,保留已展开邻居(累计保留,单击/收起永不重排已展开画布)。
  const collapseNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // 跨视图带入的 focusRef → 打开该焦点(用户「跳到这张图」的足迹)。
  useEffect(() => {
    if (!focusRef) return;
    const nodeId = endpointToNodeId(focusRef);
    if (nodeId) openFocusRef.current(nodeId);
  }, [focusRef]);

  // 首次(数据到位而未聚焦、且无外部 focusRef)= 打开默认焦点,铺开 ±2。
  useEffect(() => {
    if (focusId || focusRef) return;
    const def = pickDefaultFocus(decisions ?? [], tasks);
    if (def) openFocusRef.current(def);
  }, [focusId, focusRef, decisions, tasks]);

  useEffect(() => {
    const ac = new AbortController();
    computeGraphLayout({
      tasks,
      relations,
      decisions: decisions ?? [],
      facts: facts ?? [],
      coverageRows: coverageRows ?? [],
      factAnchors: factAnchors ?? [],
      focusNodeId: focusId,
      expandedFacts,
      filters: layoutInputFilters,
      inLoopNodes: EMPTY_LOOP,
      inLoopEdges: EMPTY_LOOP,
      canvas: { shown, expanded },
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
    layoutInputFilters,
    shown,
    expanded,
  ]);

  // 换焦点(openFocus)时把焦点节点摆进视口正中 —— 兑现「以它为中心」,同时躲开左上角
  // Filters 面板(fitView 全景会按图 bbox 居中,下游更宽时焦点被推到左侧压在面板下)。
  // 只在焦点变化时触发:累积展开 / 长邻居永不重排已有画布
  // (dec_01KXBGJQFQARSZHHQW1WADFDNC「单击永不重排」)。用 ref 记住上次已居中的焦点。
  const lastCenteredFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!resolvedFocusId) return;
    if (lastCenteredFocus.current === resolvedFocusId) return;
    const focusNode = nodes.find((n) => n.id === resolvedFocusId);
    if (!focusNode) return;
    lastCenteredFocus.current = resolvedFocusId;
    const w = Number(focusNode.style?.width ?? 0);
    const h = Number(focusNode.style?.height ?? 0);
    const cx = focusNode.position.x + w / 2;
    const cy = focusNode.position.y + h / 2;
    const frame = window.requestAnimationFrame(() => {
      setCenter(cx, cy, { zoom: FOCUS_ZOOM, duration: 320 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedFocusId, nodes, setCenter]);

  // 单击 chip = 就地展开成卡片并长出邻居(累积,永不重排已有画布)。
  // 卡片(已展开)单击不处理 —— 收起 / 详情 / 设为中心 走卡片自身按钮。
  const onNodeClick = useCallback(
    (_evt: any, node: any) => {
      if (node.type !== "ego") return;
      if (node.data?.expanded) return;
      expandNode(node.id);
    },
    [expandNode],
  );

  // 双击 = 设为画布中心(openFocus:重排前后各 2 跳,推历史)。
  const onNodeDoubleClick = useCallback(
    (_evt: any, node: any) => {
      if (node.type !== "ego" || typeof node.id !== "string") return;
      openFocus(node.id);
    },
    [openFocus],
  );

  const onEdgeClick = useCallback((_: any, edge: any) => {
    // 修 #3:边焦点独立成 focusEdgeId,不再混入 focusId,布局不会重算。
    setSelectedId(null);
    setFocusEdgeId((prev) => (prev === edge.id ? null : edge.id));
  }, []);

  const onPaneClick = useCallback(() => {
    // 点空白只关抽屉,不动焦点(让用户「跳过去回得来」)。
    setSelectedId(null);
    setFocusEdgeId(null);
  }, []);

  // Esc = 关抽屉(不退焦点;焦点有显式「退出聚焦」按钮)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,select")) return;
      setSelectedId(null);
      setFocusEdgeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drawer
  const focusNode = focusId ? nodes.find((n) => n.id === focusId) : null;
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const focusEdge = focusEdgeId ? edges.find((e) => e.id === focusEdgeId) : null;
  // 面包屑节点:用户没显式设焦点时,fallback 到布局器挑的默认焦点
  // (resolvedFocusId),让用户始终知道「当前在看谁的图」。
  const breadcrumbNode =
    focusNode ?? (resolvedFocusId ? nodes.find((n) => n.id === resolvedFocusId) ?? null : null);

  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => {
      if (n.type === "moduleGroup" || n.type === "laneBackground") return;
      map.set(n.id, {
        id: n.id,
        entity: n.type === "decisionFocus" ? "decision" : n.type,
        label: n.data.label,
        sub: n.data.sub,
        // GraphDrawer 读 closeoutReadiness/engine/freshness/module 等字段,
        // 这些只存在于完整 TaskRow (n.data.raw) 上,不在 React Flow 节点的
        // 顶层 data 上。修 #1:此前误传 n.data,导致 CloseoutBadge/EngineBadge
        // 拿到 undefined,CLOSEOUT_META[undefined] 直接抛 → 点 task 节点必崩。
        task: n.type === "task" ? n.data.raw : undefined,
        // 修 GUI 可用性(dec_01KXA7811SVVT8P66HNDFZQ7DF):抽屉现在可被任何
        // 节点打开(单击=选中),包括 lineage lane 里的 decision / fact 节点。
        // 这些节点的 n.data 不带 chosen/rejected/claims 等字段(只有 n.data.raw
        // 才是完整 DecisionRow/FactRef)。raw 优先取 n.data.raw,fallback n.data
        // 兼容老的 simpleEgoLayout 节点(其 data 即实体本身)。
        raw: (n.data?.raw ?? n.data) as typeof n.data,
      });
    });
    return map;
  }, [nodes]);

  // Node/edge count for header (exclude lane backgrounds)
  const visibleNodeCount = useMemo(
    () => nodes.filter((n) => n.type !== "moduleGroup" && n.type !== "laneBackground").length,
    [nodes],
  );

  // 注入卡片交互回调(收起 / 设为中心 / 详情跳转)+ id 到 ego 节点 data。
  const displayNodes = useMemo(
    () =>
      nodes.map((n) =>
        n.type === "ego"
          ? {
              ...n,
              data: {
                ...n.data,
                id: n.id,
                onCollapse: collapseNode,
                onRefocus: openFocus,
                onNavigate: onNavigateEntity,
              },
            }
          : n,
      ),
    [nodes, collapseNode, openFocus, onNavigateEntity],
  );

  // 抽屉里展示的实体(优先 selectedNode,fallback 到 focusNode)。这样单击非焦点
  // 节点能看抽屉,focus 节点也能看抽屉。upCount/downCount 跟随「抽屉里那个」。
  const drawerNodeId = selectedNode?.id ?? focusNode?.id ?? null;

  // 上游 / 下游 1-hop 邻居计数 (供 GraphDrawer「链路」展示)。绑定到 drawerNodeId,
  // 而不是 focusId,确保抽屉展示与计数口径一致。
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

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    setFocusEdgeId(null);
  }, []);
  // 边抽屉里「跳转源/目标节点」= 把该节点设为画布中心(openFocus 重排 ±2),并关边抽屉。
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
  // 抽屉里「设为焦点」按钮 = 把当前抽屉里的节点设为画布中心。
  const setDrawerAsFocus = useCallback(() => {
    if (!drawerNodeId) return;
    openFocus(drawerNodeId);
  }, [drawerNodeId, openFocus]);

  // 历史导航:back/forward。currentFocus 为 null 表示走到历史外(默认焦点),
  // 此时仍把 focusId 同步到 null 让布局器挑默认。
  // 历史前进/后退:切焦点 + 重排画布(resetCanvasTo,不重复推栈)。
  const goBackStack = useCallback(() => {
    setHistory((prev) => {
      const next = historyGoBack(prev);
      if (next === prev) return prev;
      const f = currentFocus(next);
      setFocusId(f);
      if (f) resetCanvasTo(f);
      return next;
    });
  }, [resetCanvasTo]);
  const goForwardStack = useCallback(() => {
    setHistory((prev) => {
      const next = historyGoForward(prev);
      if (next === prev) return prev;
      const f = currentFocus(next);
      setFocusId(f);
      if (f) resetCanvasTo(f);
      return next;
    });
  }, [resetCanvasTo]);
  const clearFocus = useCallback(() => {
    setFocusId(null);
    setShown(new Map());
    setExpanded(new Set());
    // 不动历史:用户「退出聚焦」不脚印化。清空后 bootstrap 会重开默认焦点。
  }, []);

  // Switcher 入口:点选 = 设为画布中心(openFocus 重排 ±2)。
  const switchFocusFromList = useCallback(
    (nodeId: string) => {
      openFocus(nodeId);
      setFocusEdgeId(null);
    },
    [openFocus],
  );

  // 面包屑数据:显示当前焦点(显式 or 布局默认)。kind 用 type 反推
  // (decisionFocus/decision=decision)。
  const breadcrumb = useMemo(() => {
    if (!breadcrumbNode) return null;
    const kindRaw = breadcrumbNode.type === "decisionFocus" || breadcrumbNode.type === "decision"
      ? "decision"
      : breadcrumbNode.type === "task"
        ? "task"
        : breadcrumbNode.type === "fact"
          ? "fact"
          : (breadcrumbNode.type ?? "node");
    const title = breadcrumbNode.data?.label ?? breadcrumbNode.id;
    return {
      kindLabel: kindRaw,
      title: typeof title === "string" ? title : String(title ?? ""),
      nodeId: breadcrumbNode.id,
    };
  }, [breadcrumbNode]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-red-50 p-8">
        <div className="text-red-700 whitespace-pre-wrap font-mono text-sm">{error}</div>
      </div>
    );
  }

  if (
    tasks.length === 0 &&
    (decisions?.length ?? 0) === 0 &&
    (facts?.length ?? 0) === 0
  ) {
    return (
      <div
        data-testid="triadic-graph-empty-state"
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
      >
        <div className="text-[14px] font-semibold text-text">暂无三元语关系数据</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          当前 ledger 没有可投影的 task、decision 或 fact。记录出现后，关系图会自动显示真实节点与 kernel relation 边。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <GraphLegend
        visibleNodeCount={visibleNodeCount}
        edgeCount={edges.length}
        resolvedFocusId={resolvedFocusId}
        cycleWarning={cycleWarning}
        hasFocus={Boolean(focusId || focusEdgeId)}
      />

      <FocusHistoryBar
        canBack={historyCanGoBack(history)}
        canForward={historyCanGoForward(history)}
        breadcrumb={breadcrumb}
        onBack={goBackStack}
        onForward={goForwardStack}
        onClear={clearFocus}
      />

      <div className="flex min-h-0 flex-1 relative">
        <FocusSwitcher
          decisions={decisions ?? []}
          tasks={tasks}
          focusId={focusId}
          onFocus={switchFocusFromList}
        />
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          colorMode={colorMode}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          attributionPosition="bottom-right"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--color-border)"
          />
          <Controls className="bg-surface-raised border-border" />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === "laneBackground") return "rgba(255, 255, 255, 0.04)";
              // ego 节点按语义轴上色 —— 否则暗色 minimap 上全是暗灰方块,等于隐形。
              if (n.type === "ego") return MINIMAP_AXIS[(n.data as any)?.entity as string] ?? "var(--color-axis-execution)";
              if (n.type === "decisionFocus" || n.type === "decision") return "var(--color-accent)";
              if (n.type === "fact") return "var(--color-stale)";
              return "var(--color-border-strong)";
            }}
            nodeStrokeColor="var(--color-border-strong)"
            maskColor="rgba(0, 0, 0, 0.5)"
            className="bg-surface border border-border rounded overflow-hidden"
          />
          <Panel position="top-left">
            <GraphFilterPanel
              filters={filters}
              setFilters={setFilters}
              availableModules={availableModules}
            />
          </Panel>
        </ReactFlow>

        {/* 节点详情已就地进卡片;抽屉仅保留「边详情」(点关系边)这一路。 */}
        {(selectedNode || focusEdge) && (
          <GraphDrawer
            focusNode={selectedNode ? drawerNodesMap.get(selectedId) : undefined}
            focusEdge={focusEdge ? focusEdge.data : undefined}
            nodes={drawerNodesMap}
            edges={relations}
            upCount={upCount}
            downCount={downCount}
            onClose={closeDrawer}
            onFocus={focusFromDrawer}
            onNavigateEntity={onNavigateEntity}
            isFocused={drawerNodeId !== null && drawerNodeId === focusId}
            onSetAsFocus={setDrawerAsFocus}
          />
        )}
      </div>
    </div>
  );
}

export function GraphView(props: any) {
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  );
}
