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
  RelationKind,
} from "../model/types";
import type {
  RelationCoverageRow,
  FactAnchorRow,
} from "../../api/renderer-dto.ts";
import { GraphDrawer } from "../graph/GraphDrawer";
import { type GraphFilterInput } from "../graph/graphLayout";
import { useEgoCanvas } from "../graph/useEgoCanvas";
import { territoryChipColor } from "../graph/nodes/TerritoryChipNode";
import { useTerritoryView, type ViewMode } from "../graph/useTerritoryView";
import { TerritorySkelToggle } from "../components/TerritoryModeBar";
import {
  GraphFilterPanel,
  type GraphFilters,
} from "../components/GraphFilterPanel";
import { FocusSwitcher } from "../components/FocusSwitcher";
import { buildEntityIndex, type EntityHit } from "../model/entitySearch";
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
import {
  defaultKindFilter,
  edgePassesKindFilter,
  type FlowAnimMode,
} from "../graph/relationVisual";
import {
  defaultEntityStatusFilter,
  edgeEndpointsVisible,
  computeStatusVisibleNodeIds,
} from "../graph/entityStatusFilter";
import {
  graphNodeTypes,
  graphEdgeTypes,
  MINIMAP_AXIS,
  defaultAxes,
} from "./graphViewTypes";
import { t } from "../i18n/index.tsx";

function GraphViewInner({
  tasks,
  relations,
  decisions,
  facts,
  coverageRows,
  factAnchors,
  onNavigateEntity,
  onFocusEntityChange,
  focusRef,
  recentHits,
  onOpenPalette,
  viewMode,
  onViewModeChange,
}: {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions?: DecisionRow[];
  facts?: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity?: (ref: string) => void;
  /**
   * 画布内焦点变更上行(G3 §④2)。openFocus 触发时调用,把 ego byId key(id 形态)
   * 透传给上层,由 EntityWorkspace / App.tsx 翻译成 navRef 并写回 AppLocation。
   */
  onFocusEntityChange?: (id: string | null) => void;
  focusRef?: string | null;
  /** FocusSwitcher 退役后:Recent 列表由 App.tsx 派生,GraphView 只透传。 */
  recentHits?: readonly EntityHit[];
  /** Cmd+K 命令面板触发器,打开全局面板。 */
  onOpenPalette?: () => void;
  /**
   * 领地/聚光灯模式(受控,由 EntityWorkspace 本地态持有 —— 它是 3 态选择条的一部分)。
   * EntityWorkspace 在演化史模式下不挂载 GraphView,所以此值恒为 territory/spotlight。
   */
  viewMode: ViewMode;
  /** 模式上行(territory chip 单击 → spotlight 时由 useTerritoryView.enterSpotlight 触发)。 */
  onViewModeChange: (m: ViewMode) => void;
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

  // 三原语统一索引,供左栏 FocusSwitcher typeahead 复用。
  const entityIndex = useMemo(
    () => buildEntityIndex({ tasks, decisions: decisions ?? [], facts: facts ?? [] }),
    [tasks, decisions, facts],
  );

  const [filters, setFilters] = useState<GraphFilters>(() => ({
    modules: new Set(tasks.map((t) => t.module)),
    types: new Set(["decision", "task", "fact"] as const),
    axes: defaultAxes(),
    kinds: defaultKindFilter(),
    entityStatus: defaultEntityStatusFilter(),
  }));
  // 流动动画全局开关:focus(默认,仅选中/悬停/邻接) / all / off;会话内保持。
  const [flowMode, setFlowMode] = useState<FlowAnimMode>("focus");

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

  // 无限画布 ego 状态机。
  const {
    focusId,
    shown,
    expanded,
    canBack,
    canForward,
    selectId,
    oneHopHighlight,
    openFocus,
    expandNode,
    collapseNode,
    clearFocus,
    selectNode,
    clearSelect,
    goBack,
    goForward,
  } = useEgoCanvas({
    tasks,
    decisions: decisions ?? [],
    facts: facts ?? [],
    relations,
    axes: filters.axes,
    focusRef,
    onFocusChange: onFocusEntityChange,
  });

  // L1 领地总览状态机。
  const {
    skel,
    expandedZones,
    enterSpotlight,
    setSkel,
    toggleZone,
  } = useTerritoryView(openFocus, onViewModeChange);

  // D7 item2:单种类领地下 types 由 skel 独占。
  const layoutInputFilters: GraphFilterInput = useMemo(
    () => ({
      modules: filters.modules,
      types:
        viewMode === "territory" && (skel === "task" || skel === "decision" || skel === "fact")
          ? new Set<string>([skel])
          : filters.types,
      axes: filters.axes,
    }),
    [filters, viewMode, skel],
  );

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

  useCenterOnFocus(nodes, resolvedFocusId);

  const onNodeClick = useCallback(
    (_evt: any, node: any) => {
      if (node.type === "territoryChip") {
        const d = node.data ?? {};
        if (d.entity === "fold") {
          if (d.zoneId) toggleZone(d.zoneId);
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
      if (viewMode === "territory" && skel === "unified") {
        const navRef = node.data?.navRef;
        if (navRef) enterSpotlight(navRef);
        return;
      }
      if (viewMode === "spotlight") {
        selectNode(node.id);
      }
      if (node.data?.expanded) return;
      expandNode(node.id);
    },
    [expandNode, toggleZone, enterSpotlight, viewMode, skel, selectNode],
  );

  const onNodeDoubleClick = useCallback(
    (_evt: any, node: any) => {
      if (viewMode === "territory") return;
      if (node.type !== "ego" || typeof node.id !== "string") return;
      openFocus(node.id);
    },
    [openFocus, viewMode],
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
    clearSelect();
  }, [clearSelect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,select")) return;
      setDrawerState((prev) => ({ ...prev, selectedId: null, focusEdgeId: null }));
      clearSelect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelect]);

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

  const focusNode = focusId ? nodes.find((n) => n.id === focusId) : null;
  const breadcrumbNode =
    focusNode ?? (resolvedFocusId ? nodes.find((n) => n.id === resolvedFocusId) ?? null : null);
  const selectedNode = drawer.selectedId ? nodes.find((n) => n.id === drawer.selectedId) : null;
  const focusEdge = drawer.focusEdgeId ? edges.find((e) => e.id === drawer.focusEdgeId) : null;

  // 实体状态筛选:Task.coordinationStatus / Decision.state。默认全选不改布局。
  // 焦点恒可见;被滤掉节点的关联边一并隐藏(与 kind 筛选交集)。
  const statusVisibleIds = useMemo(
    () =>
      computeStatusVisibleNodeIds(nodes, filters.entityStatus, [
        resolvedFocusId,
        focusId,
      ]),
    [nodes, filters.entityStatus, resolvedFocusId, focusId],
  );

  const visibleNodeCount = useMemo(
    () =>
      (statusVisibleIds
        ? nodes.filter((n) => statusVisibleIds.has(n.id))
        : nodes
      ).filter(
        (n) =>
          n.type !== "moduleGroup" &&
          n.type !== "laneBackground" &&
          n.type !== "territoryZone",
      ).length,
    [nodes, statusVisibleIds],
  );

  const displayNodes = useMemo(
    () =>
      nodes
        .filter((n) => (statusVisibleIds ? statusVisibleIds.has(n.id) : true))
        .map((n) => {
          if (n.type === "ego") {
            const dimmed =
              oneHopHighlight !== null && !oneHopHighlight.has(n.id);
            return {
              ...n,
              selected: selectId !== null && n.id === selectId,
              data: {
                ...n.data,
                id: n.id,
                dimmed,
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
    [
      nodes,
      collapseNode,
      openFocus,
      onNavigateEntity,
      setSizeOverride,
      enterSpotlight,
      toggleZone,
      oneHopHighlight,
      selectId,
      statusVisibleIds,
    ],
  );

  // 边后处理:kind 筛选 ∩ 状态筛选(两端节点都可见) + 单跳高亮 + flowMode 注入。
  const displayEdges = useMemo(() => {
    const kindFiltered = edges.filter((e) => {
      const kind = (e.data as { kind?: RelationKind } | undefined)?.kind;
      if (kind && !edgePassesKindFilter({ kind }, filters.kinds)) return false;
      if (statusVisibleIds && !edgeEndpointsVisible(e.source, e.target, statusVisibleIds)) {
        return false;
      }
      return true;
    });
    return kindFiltered.map((e) => {
      const baseData = (e.data as Record<string, unknown> | undefined) ?? {};
      if (oneHopHighlight === null) {
        return {
          ...e,
          data: { ...baseData, flowMode, adjacent: false },
        };
      }
      const keep =
        oneHopHighlight.has(e.source) && oneHopHighlight.has(e.target);
      if (keep) {
        return {
          ...e,
          data: { ...baseData, flowMode, adjacent: true },
        };
      }
      return {
        ...e,
        style: {
          ...(e.style ?? {}),
          opacity: 0.18,
        },
        data: { ...baseData, flowMode, adjacent: false },
      };
    });
  }, [edges, oneHopHighlight, filters.kinds, flowMode, statusVisibleIds]);

  const switchFocusFromList = useCallback(
    (nodeId: string) => {
      openFocus(nodeId);
      setDrawerState((prev) => ({ ...prev, focusEdgeId: null }));
    },
    [openFocus],
  );

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
          recentHits={recentHits ?? []}
          entityIndex={entityIndex}
          focusId={focusId}
          onFocus={switchFocusFromList}
          onOpenPalette={onOpenPalette ?? (() => undefined)}
        />
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={graphNodeTypes}
          edgeTypes={graphEdgeTypes}
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
            bgColor="var(--color-surface)"
            nodeColor={(n) => {
              if (n.type === "laneBackground" || n.type === "territoryZone") return "rgba(255, 255, 255, 0.04)";
              if (n.type === "ego") return MINIMAP_AXIS[(n.data as any)?.entity as string] ?? "var(--color-axis-execution)";
              if (n.type === "territoryChip") return territoryChipColor((n.data as any)?.entity as string) ?? "var(--color-border-strong)";
              if (n.type === "decisionFocus" || n.type === "decision") return "var(--color-accent)";
              if (n.type === "fact") return "var(--color-stale)";
              return "var(--color-border-strong)";
            }}
            nodeStrokeColor="var(--color-border-strong)"
            maskColor={colorMode === "dark" ? "rgba(0, 0, 0, 0.5)" : "rgba(255, 255, 255, 0.6)"}
            className="border border-border rounded overflow-hidden"
          />
          {viewMode === "territory" && (
            <TerritorySkelToggle skel={skel} onSkelChange={setSkel} />
          )}
          <Panel position="top-left">
            <GraphFilterPanel
              filters={filters}
              setFilters={setFilters}
              availableModules={availableModules}
              showEntityTypes={viewMode === "spotlight" || skel === "unified"}
              flowMode={flowMode}
              onFlowModeChange={setFlowMode}
            />
          </Panel>
        </ReactFlow>

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
