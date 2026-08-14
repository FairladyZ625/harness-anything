import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
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
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { FactAnchorRow, RelationCoverageRow } from "../../api/renderer-dto";
import { parseEndpoint, endpointToNodeId } from "../graph/endpoint";
import { GraphDrawer } from "../graph/GraphDrawer";
import { EgoNode } from "../graph/nodes/EgoNode";
import { TerritoryZoneNode, TerritoryLandingNode } from "../graph/nodes/TerritoryNode";
import { InteractiveEdge } from "../graph/edges/InteractiveEdge";
import { GraphFilterPanel, type GraphFilters } from "../components/GraphFilterPanel";
import { GraphLegend } from "../components/GraphLegend.tsx";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { TerritorySkelToggle, type TerritorySkel } from "../components/TerritoryModeBar";
import { useColorMode, minimapMaskColor } from "../graph/colorMode";
import { layoutEgoCanvas } from "../graph/egoCanvas";
import { useEgoCanvas } from "../graph/useEgoCanvas";
import { partitionForSkel } from "../graph/territory";
import { UNPROJECTED_MODULE } from "../graph/moduleAssignment";
import {
  defaultKindFilter,
  defaultAxisFilter,
  edgePassesKindFilter,
  type FlowAnimMode,
} from "../graph/relationVisual";
import {
  defaultEntityStatusFilter,
  nodePassesEntityStatusFilter,
  type EntityStatusFilterState,
} from "../graph/entityStatusFilter";
import {
  focusHistoryReducer,
  EMPTY_HISTORY,
  canBack,
  canForward,
} from "../navigation/focusHistory";

export type ViewMode = "territory" | "spotlight";

const nodeTypes = {
  ego: EgoNode,
  territoryZone: TerritoryZoneNode,
  territoryLanding: TerritoryLandingNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

const EMPTY_ANCHORS: ReadonlyArray<FactAnchorRow> = [];

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
  viewMode,
  onViewModeChange,
}: {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity?: (ref: string) => void;
  onFocusEntityChange?: (ref: string | null) => void;
  focusRef: string | null;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
}) {
  const colorMode = useColorMode();
  const { fitView } = useReactFlow();

  const [skel, setSkel] = useState<TerritorySkel>("unified");
  const [collapsedZones, setCollapsedZones] = useState<Set<string>>(() => new Set());
  const [flowMode, setFlowMode] = useState<FlowAnimMode>("focus");
  const [focusEdgeId, setFocusEdgeId] = useState<string | null>(null);

  const availableModules = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.module))).sort(),
    [tasks],
  );

  const [filters, setFilters] = useState<GraphFilters>(() => ({
    modules: new Set(availableModules.length ? availableModules : []),
    types: new Set(["decision", "task", "fact"] as const),
    axes: defaultAxisFilter(),
    kinds: defaultKindFilter(),
    entityStatus: defaultEntityStatusFilter(),
  }));

  useEffect(() => {
    setFilters((cur) => {
      const next = new Set(availableModules);
      if (cur.modules.size === next.size && [...cur.modules].every((m) => next.has(m))) return cur;
      return { ...cur, modules: next };
    });
  }, [availableModules]);

  // ---- 焦点历史(stable reducer,无自触发循环) ----
  const [histState, histDispatch] = useReducer(focusHistoryReducer, EMPTY_HISTORY);

  useEffect(() => {
    if (focusRef) {
      histDispatch({ type: "push", ref: focusRef });
    }
  }, [focusRef]);

  const openFocus = useCallback(
    (ref: string | null) => {
      onFocusEntityChange?.(ref ?? null);
    },
    [onFocusEntityChange],
  );

  // ---- 无限画布 ego 状态机(dec_01KXBGJQFQARSZHHQW1WADFDNC) ----
  const canvas = useEgoCanvas({
    tasks,
    decisions,
    facts,
    relations,
    factAnchors: factAnchors ?? EMPTY_ANCHORS,
    axes: filters.axes,
    focusRef: viewMode === "spotlight" ? focusRef : null,
  });

  const goBack = useCallback(() => {
    histDispatch({ type: "back" });
    const prev = histState.stack[histState.index - 1];
    if (prev) onFocusEntityChange?.(prev);
  }, [histState, onFocusEntityChange]);

  const goForward = useCallback(() => {
    histDispatch({ type: "forward" });
    const next = histState.stack[histState.index + 1];
    if (next) onFocusEntityChange?.(next);
  }, [histState, onFocusEntityChange]);

  const clearFocus = useCallback(() => {
    histDispatch({ type: "clear" });
    onFocusEntityChange?.(null);
    canvas.clearCanvas();
    setFocusEdgeId(null);
  }, [onFocusEntityChange, canvas]);

  // ---- 进入聚光灯(territory chip 单击) ----
  const enterSpotlight = useCallback(
    (navRef: string) => {
      onViewModeChange("spotlight");
      openFocus(navRef);
    },
    [onViewModeChange, openFocus],
  );

  // ---- 领地布局 ----
  const territory = useMemo(() => {
    if (viewMode !== "territory") return null;
    return partitionForSkel(
      skel,
      tasks,
      decisions,
      facts,
      factAnchors ?? [],
      relations,
      coverageRows ?? [],
    );
  }, [viewMode, skel, tasks, decisions, facts, factAnchors, relations, coverageRows]);

  const toggleZone = useCallback((zoneId: string) => {
    setCollapsedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  // 未投影 zone 默认折叠(降权:不许占 C 位)。用户手动展开后不再被覆盖。
  const [autoCollapsedSkel, setAutoCollapsedSkel] = useState<string | null>(null);
  useEffect(() => {
    if (!territory || autoCollapsedSkel === skel) return;
    const unprojected = territory.zones
      .filter((z) => z.moduleId === UNPROJECTED_MODULE)
      .map((z) => z.zoneId);
    setAutoCollapsedSkel(skel);
    if (unprojected.length > 0) {
      setCollapsedZones((prev) => new Set([...prev, ...unprojected]));
    }
  }, [territory, skel, autoCollapsedSkel]);

  const territoryNodes = useMemo(() => {
    if (!territory) return [];
    const nodes: any[] = [];
    const colW = 300;
    const colGap = 32;
    const maxPerCol = 3;
    territory.zones.forEach((zone, i) => {
      const col = i % maxPerCol;
      const row = Math.floor(i / maxPerCol);
      nodes.push({
        id: zone.zoneId,
        type: "territoryZone",
        position: { x: col * (colW + colGap), y: row * 260 },
        data: { zone, collapsed: collapsedZones.has(zone.zoneId), onOpen: enterSpotlight, onFold: toggleZone },
        draggable: false,
      });
    });
    if (territory.landing.length > 0) {
      const landingCol = territory.zones.length % maxPerCol;
      const landingRow = Math.floor(territory.zones.length / maxPerCol);
      nodes.push({
        id: "__landing__",
        type: "territoryLanding",
        position: { x: landingCol * (colW + colGap), y: landingRow * 260 },
        data: { chips: territory.landing, onOpen: enterSpotlight },
        draggable: false,
      });
    }
    return nodes;
  }, [territory, collapsedZones, enterSpotlight, toggleZone]);

  // ---- 聚光灯布局(纯函数:焦点 + 累积集 + 筛选 → 位置) ----
  const spotlight = useMemo(() => {
    if (viewMode !== "spotlight" || !canvas.focusId) return null;
    return layoutEgoCanvas({
      focusId: canvas.focusId,
      graph: canvas.graph,
      relations,
      filters: {
        axes: filters.axes,
        kinds: filters.kinds,
        types: filters.types,
        flowMode,
      },
      shown: canvas.shown,
      expanded: canvas.expanded,
      highlight: canvas.highlight,
    });
  }, [viewMode, canvas.focusId, canvas.graph, canvas.shown, canvas.expanded, canvas.highlight, relations, filters.axes, filters.kinds, filters.types, flowMode]);

  // ---- 实体状态筛选(聚光灯) ----
  const statusVisibleIds = useMemo(() => {
    if (!spotlight) return null;
    if (!isStatusNarrowed(filters.entityStatus)) return null;
    const ids = new Set<string>();
    for (const n of spotlight.nodes) {
      const data = n.data as any;
      if (n.id === spotlight.focusId) {
        ids.add(n.id);
        continue;
      }
      if (nodePassesEntityStatusFilter(data?.entity, data?.raw ?? data, filters.entityStatus)) {
        ids.add(n.id);
      }
    }
    return ids;
  }, [spotlight, filters.entityStatus]);

  const displayNodes = useMemo(() => {
    if (viewMode === "territory") return territoryNodes;
    if (!spotlight) return [];
    return spotlight.nodes
      .filter((n) => (statusVisibleIds ? statusVisibleIds.has(n.id) : true))
      .map((n) => ({
        ...n,
        selected: n.id === canvas.selectId,
        data: {
          ...(n.data as any),
          onCollapse: canvas.collapseNode,
          onRefocus: openFocus,
          onNavigate: onNavigateEntity,
        },
      }));
  }, [viewMode, territoryNodes, spotlight, statusVisibleIds, canvas.selectId, canvas.collapseNode, openFocus, onNavigateEntity]);

  const displayEdges = useMemo(() => {
    if (viewMode !== "spotlight" || !spotlight) return [];
    return spotlight.edges.filter((e) => {
      if (!edgePassesKindFilter({ kind: (e.data as any)?.kind }, filters.kinds)) return false;
      if (statusVisibleIds && (!statusVisibleIds.has(e.source) || !statusVisibleIds.has(e.target))) return false;
      return true;
    });
  }, [viewMode, spotlight, filters.kinds, statusVisibleIds]);

  // fitView 只在换焦点 / 换模式时跑 —— 展开、收起、单击都不重排视口(决策 CH1)。
  useEffect(() => {
    if (displayNodes.length === 0) return;
    const frame = requestAnimationFrame(() => fitView({ padding: 0.12, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [canvas.focusId, fitView, viewMode, skel]);

  // Esc 清选/清边。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,select")) return;
      canvas.clearSelect();
      setFocusEdgeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas]);

  // 单击 = 就地展开成卡片并长出下一环邻居;再点收起(已展开邻居累计保留,画布不重排)。
  const onNodeClick = useCallback(
    (_: any, node: any) => {
      if (viewMode === "territory") return;
      if (canvas.expanded.has(node.id)) canvas.collapseNode(node.id);
      else canvas.expandNode(node.id);
      canvas.selectNode(node.id);
    },
    [viewMode, canvas],
  );

  // 双击 = 设为画布中心(唯一会重排画布的节点交互)。
  const onNodeDoubleClick = useCallback(
    (_: any, node: any) => {
      if (viewMode === "territory") return;
      const navRef = (node.data as any)?.navRef ?? node.id;
      openFocus(navRef);
    },
    [viewMode, openFocus],
  );

  const onEdgeClick = useCallback((_: any, edge: any) => {
    canvas.clearSelect();
    setFocusEdgeId((prev) => (prev === edge.id ? null : edge.id));
  }, [canvas]);

  const onPaneClick = useCallback(() => {
    canvas.clearSelect();
    setFocusEdgeId(null);
  }, [canvas]);

  // ---- Drawer ----
  const drawerNodeId = canvas.selectId ?? canvas.focusId;

  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    if (spotlight) {
      for (const n of spotlight.nodes) {
        const data = n.data as any;
        map.set(n.id, {
          id: n.id,
          entity: data?.entity,
          label: data?.label,
          sub: data?.sub,
          task: data?.entity === "task" ? data?.raw : undefined,
          raw: data?.raw ?? data,
        });
      }
    }
    return map;
  }, [spotlight]);

  const focusEdge = useMemo(
    () => (focusEdgeId ? displayEdges.find((e) => e.id === focusEdgeId) : null),
    [focusEdgeId, displayEdges],
  );

  // 上下游计数读**全量 relations**,不是当前可见边 —— 画布只铺开了一部分,
  // 用可见边计数会把「还没铺开」误报成「没有关系」。
  const { upCount, downCount } = useMemo(() => {
    if (!drawerNodeId) return { upCount: 0, downCount: 0 };
    let up = 0;
    let down = 0;
    for (const e of relations) {
      if (endpointToNodeId(e.from) === drawerNodeId) down += 1;
      if (endpointToNodeId(e.to) === drawerNodeId) up += 1;
    }
    return { upCount: up, downCount: down };
  }, [drawerNodeId, relations]);

  const breadcrumb = useMemo(() => {
    if (!focusRef) return null;
    const parsed = parseEndpoint(focusRef);
    if (!parsed) return null;
    const data = spotlight?.nodes.find((n) => n.id === parsed.id)?.data as any;
    return {
      kindLabel: parsed.entity,
      title: data?.label ?? parsed.id,
      nodeId: parsed.id,
    };
  }, [focusRef, spotlight]);

  if (
    tasks.length === 0 &&
    decisions.length === 0 &&
    facts.length === 0 &&
    (factAnchors?.length ?? 0) === 0
  ) {
    return (
      <div
        data-testid="triadic-graph-empty-state"
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
      >
        <div className="text-[14px] font-semibold text-text">暂无三元语关系数据</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          当前 ledger 没有可投影的 task、decision 或 fact。记录出现后,领地与聚光灯会自动显示真实节点与 kernel relation 边。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-text-muted">
        <span className="font-mono text-text-faint">
          {viewMode === "territory"
            ? `领地 · ${territory?.zones.length ?? 0} 块`
            : `聚光灯 · ${displayNodes.length} 节点 · ${displayEdges.length} 边`}
        </span>
        <GraphLegend showFulfillment={(coverageRows?.length ?? 0) > 0} />
        {territory && territory.unprojectedCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-stale/10 px-1.5 py-0.5 font-mono text-stale"
            title="module/PLT 字段缺失,归入「未投影」块 —— 默认折叠并沉底,但绝不隐藏"
          >
            未投影 · {territory.unprojectedCount}
          </span>
        )}
        <span className="ml-auto text-text-faint">
          {viewMode === "spotlight"
            ? focusRef
              ? "单击展开/收起 · 双击设为中心 · Esc 清选"
              : "从领地选实体,或在命令面板(⌘K)搜索"
            : "块内 chip 单击 → 聚光灯"}
        </span>
      </header>

      {viewMode === "spotlight" && (
        <FocusHistoryBar
          canBack={canBack(histState)}
          canForward={canForward(histState)}
          breadcrumb={breadcrumb}
          onBack={goBack}
          onForward={goForward}
          onClear={clearFocus}
        />
      )}

      <div className="flex min-h-0 flex-1 relative">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          colorMode={colorMode}
          minZoom={0.05}
          maxZoom={2}
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-border)" />
          <Controls className="bg-surface-raised border-border" />
          <MiniMap
            data-testid="graph-minimap"
            bgColor="var(--color-surface)"
            nodeColor={(n) => {
              if (n.type === "territoryZone" || n.type === "territoryLanding") return "var(--color-border)";
              const entity = (n.data as any)?.entity;
              if (entity === "decision") return "var(--color-axis-authority)";
              if (entity === "fact") return "var(--color-axis-evidence)";
              return "var(--color-axis-execution)";
            }}
            nodeStrokeColor="var(--color-border-strong)"
            maskColor={minimapMaskColor(colorMode)}
            className="border border-border rounded overflow-hidden"
            pannable
            zoomable
          />
          {viewMode === "territory" && (
            <Panel position="top-left">
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-muted">
                <span>折叠块:</span>
                <button
                  onClick={() => {
                    const all = new Set(territory?.zones.map((z) => z.zoneId) ?? []);
                    setCollapsedZones((cur) => (cur.size === all.size ? new Set() : all));
                  }}
                  className="rounded px-1 font-mono text-[11px] hover:bg-surface"
                >
                  {territory && collapsedZones.size === territory.zones.length ? "全部展开" : "全部折叠"}
                </button>
              </div>
            </Panel>
          )}
          {viewMode === "territory" && (
            <TerritorySkelToggle skel={skel} onSkelChange={setSkel} />
          )}
          {viewMode === "spotlight" && (
            <Panel position="top-left">
              <GraphFilterPanel
                filters={filters}
                setFilters={setFilters}
                availableModules={availableModules}
                flowMode={flowMode}
                onFlowModeChange={setFlowMode}
              />
            </Panel>
          )}
        </ReactFlow>

        {viewMode === "spotlight" && (drawerNodeId || focusEdge) && (
          <GraphDrawer
            focusNode={drawerNodeId ? (drawerNodesMap.get(drawerNodeId) ?? undefined) : undefined}
            focusEdge={focusEdge ? (focusEdge.data as unknown as RelationEdge) : undefined}
            nodes={drawerNodesMap}
            edges={relations}
            upCount={upCount}
            downCount={downCount}
            onClose={() => {
              canvas.clearSelect();
              setFocusEdgeId(null);
            }}
            onFocus={(id) => {
              const data = drawerNodesMap.get(id);
              openFocus(data?.entity === "task" ? `task/${id}` : id);
            }}
            onNavigateEntity={onNavigateEntity}
          />
        )}
      </div>
    </div>
  );
}

function isStatusNarrowed(state: EntityStatusFilterState): boolean {
  const taskFull = 7; // BOARD_COLUMNS length(6) + 1 other
  const decFull = 6;  // DECISION_STATE length(5) + 1 other
  return state.taskStatuses.size < taskFull || state.decisionStates.size < decFull;
}

export function GraphView(props: any) {
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  );
}
