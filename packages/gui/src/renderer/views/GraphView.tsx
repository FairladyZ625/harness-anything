import { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  Panel,
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
import { GraphDrawer } from "../graph/GraphDrawer";
import { type GraphFilterInput } from "../graph/graphLayout";
import { useEgoCanvas } from "../graph/useEgoCanvas";

import { TaskNode } from "../graph/nodes/TaskNode";
import { DecisionNode } from "../graph/nodes/DecisionNode";
import { DecisionFocusNode } from "../graph/nodes/DecisionFocusNode";
import { FactNode } from "../graph/nodes/FactNode";
import { EgoNode } from "../graph/nodes/EgoNode";
import { ModuleGroupNode } from "../graph/nodes/ModuleGroupNode";
import { LaneBackgroundNode } from "../graph/nodes/LaneBackgroundNode";
import { TerritoryZoneNode } from "../graph/nodes/TerritoryZoneNode";
import { TerritoryChipNode, territoryChipColor } from "../graph/nodes/TerritoryChipNode";
import { InteractiveEdge } from "../graph/edges/InteractiveEdge";
import { useTerritoryView } from "../graph/useTerritoryView";
import { TerritoryModeBar } from "../components/TerritoryModeBar";
import {
  GraphFilterPanel,
  type GraphFilters,
} from "../components/GraphFilterPanel";
import { FocusSwitcher } from "../components/FocusSwitcher";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { useColorMode } from "./graphColorMode";
import { GraphLegend } from "./GraphLegend";
import {
  useGraphLayout,
  useCenterOnFocus,
  useGraphDrawer,
  useContainerWidth,
  useNodeSizeOverrides,
} from "./graphViewHooks";
import { t } from "../i18n/index.tsx";

const nodeTypes = {
  task: TaskNode,
  decision: DecisionNode,
  decisionFocus: DecisionFocusNode,
  fact: FactNode,
  ego: EgoNode,
  moduleGroup: ModuleGroupNode,
  laneBackground: LaneBackgroundNode,
  territoryZone: TerritoryZoneNode,
  territoryChip: TerritoryChipNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

const MINIMAP_AXIS: Record<string, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
  fact: "var(--color-axis-evidence)",
};

function defaultAxes() {
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
  const colorMode = useColorMode();

  // D3:测领地容器宽度 → deriveGridCols 派生列数(取代硬编码 GRID_COLS=3)。
  const { ref: canvasContainerRef, width: containerWidth } = useContainerWidth<HTMLDivElement>();
  // D4:用户拖拽的卡片尺寸(NodeResizer)+ localStorage 持久化。
  const { sizeOverrides, setSizeOverride } = useNodeSizeOverrides();

  // expandedFacts 是既有入口(三泳道/fact 折叠徽章),聚光灯模式下不参与布局,保持空集常量。
  const expandedFacts = useMemo(() => new Set<string>(), []);

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

  // 无限画布 ego 状态机(焦点 / 累积可见集 / 已展开卡片 / 焦点历史 / 换焦点即居中)。
  const {
    focusId,
    shown,
    expanded,
    canBack,
    canForward,
    openFocus,
    expandNode,
    collapseNode,
    clearFocus,
    goBack,
    goForward,
  } = useEgoCanvas({
    tasks,
    decisions: decisions ?? [],
    facts: facts ?? [],
    relations,
    axes: filters.axes,
    focusRef,
  });

  // L1 领地总览状态机(territory ↔ spotlight 模式切换 + 骨架轴 + zone 折叠态)。
  const {
    viewMode,
    skel,
    expandedZones,
    enterSpotlight,
    setViewMode,
    setSkel,
    toggleZone,
  } = useTerritoryView(openFocus);

  // 跨视图带入的 focusRef → 切到聚光灯(用户「跳到这张图」的足迹 = 要看某实体)。
  useEffect(() => {
    if (focusRef) setViewMode("spotlight");
  }, [focusRef, setViewMode]);

  // 布局调度(异步 + AbortController)外置到 useGraphLayout;GraphView 只消费结果。
  // 传 containerWidth(D3 领地列数)和 sizeOverrides(D4 卡片尺寸)过布局链。
  const { nodes, edges, cycleWarning, error, resolvedFocusId } = useGraphLayout({
    tasks,
    relations,
    decisions: decisions ?? [],
    facts: facts ?? [],
    coverageRows,
    factAnchors,
    focusId,
    expandedFacts,
    filters: layoutInputFilters,
    shown,
    expanded,
    viewMode,
    skel,
    expandedZones,
    containerWidth,
    sizeOverrides,
  });

  // 「换焦点即居中」:布局后的 nodes + resolvedFocusId 驱动 setCenter。
  // 从 useEgoCanvas 抽出来放这儿,因为此 hook 在 useGraphLayout 之后调用,能拿到真实节点盒子。
  useCenterOnFocus(nodes, resolvedFocusId);

  // 单击 chip = 就地展开成卡片并长出邻居(累积,永不重排已有画布)。
  // territory 模式下 territoryChip 单击 → 切到聚光灯(enterSpotlight);fold chip → toggleZone。
  const onNodeClick = useCallback(
    (_evt: any, node: any) => {
      if (node.type === "territoryChip") {
        const d = node.data ?? {};
        if (d.entity === "fold" && d.zoneId) {
          toggleZone(d.zoneId);
          return;
        }
        if (d.navRef) enterSpotlight(d.navRef);
        return;
      }
      if (node.type === "territoryZone") {
        if (node.data?.zoneId) toggleZone(node.data.zoneId);
        return;
      }
      if (node.type !== "ego") return;
      if (node.data?.expanded) return;
      expandNode(node.id);
    },
    [expandNode, toggleZone, enterSpotlight],
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
    setDrawerState((prev) => ({
      ...prev,
      selectedId: null,
      focusEdgeId: prev.focusEdgeId === edge.id ? null : edge.id,
    }));
  }, []);

  const onPaneClick = useCallback(() => {
    setDrawerState((prev) => ({ ...prev, selectedId: null, focusEdgeId: null }));
  }, []);

  // Esc = 关抽屉(不退焦点;焦点有显式「退出聚焦」按钮)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,select")) return;
      setDrawerState((prev) => ({ ...prev, selectedId: null, focusEdgeId: null }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 抽屉状态(节点选中 / 边选中)+ 派生数据 + 回调,外置到 useGraphDrawer。
  // onEdgeClick / onPaneClick / Esc 通过 setDrawerState 原子更新两个 id(避免竞态)。
  const [drawerState, setDrawerState] = useState<{ selectedId: string | null; focusEdgeId: string | null }>(
    { selectedId: null, focusEdgeId: null },
  );
  const setSelectedId = useCallback(
    (id: string | null) => setDrawerState((prev) => ({ ...prev, selectedId: id })),
    [],
  );
  const setFocusEdgeId = useCallback(
    (id: string | null) => setDrawerState((prev) => ({ ...prev, focusEdgeId: id })),
    [],
  );
  const drawer = useGraphDrawer({
    nodes,
    focusId,
    relations,
    openFocus,
    selectedId: drawerState.selectedId,
    focusEdgeId: drawerState.focusEdgeId,
    setSelectedId,
    setFocusEdgeId,
  });

  // 面包屑节点:用户没显式设焦点时,fallback 到布局器挑的默认焦点(resolvedFocusId)。
  const focusNode = focusId ? nodes.find((n) => n.id === focusId) : null;
  const breadcrumbNode =
    focusNode ?? (resolvedFocusId ? nodes.find((n) => n.id === resolvedFocusId) ?? null : null);
  const selectedNode = drawer.selectedId ? nodes.find((n) => n.id === drawer.selectedId) : null;
  const focusEdge = drawer.focusEdgeId ? edges.find((e) => e.id === drawer.focusEdgeId) : null;

  // Node/edge count for header (exclude backgrounds).
  const visibleNodeCount = useMemo(
    () =>
      nodes.filter(
        (n) =>
          n.type !== "moduleGroup" &&
          n.type !== "laneBackground" &&
          n.type !== "territoryZone",
      ).length,
    [nodes],
  );

  // 注入卡片交互回调(收起 / 设为中心 / 详情跳转 / 拖拽 resize)+ id 到 ego 节点 data。
  // territory 节点注入 onOpen(chip → 聚光灯)+ onFold(zone 折叠)。
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.type === "ego") {
          return {
            ...n,
            data: {
              ...n.data,
              id: n.id,
              onCollapse: collapseNode,
              onRefocus: openFocus,
              onNavigate: onNavigateEntity,
              onResizeEnd: (id: string, w: number, h: number) => setSizeOverride(id, { w, h }),
            },
          };
        }
        if (n.type === "territoryChip" || n.type === "territoryZone") {
          return {
            ...n,
            data: { ...n.data, onOpen: enterSpotlight, onFold: toggleZone },
          };
        }
        return n;
      }),
    [nodes, collapseNode, openFocus, onNavigateEntity, setSizeOverride, enterSpotlight, toggleZone],
  );

  // Switcher 入口:点选 = 设为画布中心(openFocus 重排 ±2)。
  const switchFocusFromList = useCallback(
    (nodeId: string) => {
      openFocus(nodeId);
      setDrawerState((prev) => ({ ...prev, focusEdgeId: null }));
    },
    [openFocus],
  );

  // 面包屑数据:显示当前焦点(显式 or 布局默认)。
  const breadcrumb = useMemo(() => {
    if (!breadcrumbNode) return null;
    const kindRaw =
      breadcrumbNode.type === "decisionFocus" || breadcrumbNode.type === "decision"
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
        <div className="text-[14px] font-semibold text-text">{t("views.graphView.thereNoTrigramRelationshipDataYet")}</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          {t("views.graphView.currentLedgerHasNoTasksDecisionsFacts")}</div>
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
        hasFocus={Boolean(focusId || drawer.focusEdgeId)}
      />

      <FocusHistoryBar
        canBack={canBack}
        canForward={canForward}
        breadcrumb={breadcrumb}
        onBack={goBack}
        onForward={goForward}
        onClear={clearFocus}
      />

      <div ref={canvasContainerRef} className="flex min-h-0 flex-1 relative">
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
          minZoom={0.1}
          maxZoom={2}
          zoomOnDoubleClick={false}
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
              if (n.type === "laneBackground" || n.type === "territoryZone") return "rgba(255, 255, 255, 0.04)";
              if (n.type === "ego") return MINIMAP_AXIS[(n.data as any)?.entity as string] ?? "var(--color-axis-execution)";
              if (n.type === "territoryChip") return territoryChipColor((n.data as any)?.entity as string) ?? "var(--color-border-strong)";
              if (n.type === "decisionFocus" || n.type === "decision") return "var(--color-accent)";
              if (n.type === "fact") return "var(--color-stale)";
              return "var(--color-border-strong)";
            }}
            nodeStrokeColor="var(--color-border-strong)"
            maskColor="rgba(0, 0, 0, 0.5)"
            className="bg-surface border border-border rounded overflow-hidden"
          />
          <TerritoryModeBar
            viewMode={viewMode}
            skel={skel}
            onModeChange={setViewMode}
            onSkelChange={setSkel}
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
            focusNode={selectedNode ? drawer.drawerNodesMap.get(drawer.selectedId) : undefined}
            focusEdge={focusEdge ? focusEdge.data : undefined}
            nodes={drawer.drawerNodesMap}
            edges={relations}
            upCount={drawer.upCount}
            downCount={drawer.downCount}
            onClose={drawer.closeDrawer}
            onFocus={drawer.focusFromDrawer}
            onNavigateEntity={onNavigateEntity}
            isFocused={drawer.drawerNodeId !== null && drawer.drawerNodeId === focusId}
            onSetAsFocus={drawer.setDrawerAsFocus}
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
