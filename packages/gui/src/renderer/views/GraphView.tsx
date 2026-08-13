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
import { parseEndpoint } from "../graph/endpoint";
import { GraphDrawer } from "../graph/GraphDrawer";
import { TaskNode } from "../graph/nodes/TaskNode";
import { DecisionNode } from "../graph/nodes/DecisionNode";
import { FactNode } from "../graph/nodes/FactNode";
import { ModuleGroupNode } from "../graph/nodes/ModuleGroupNode";
import { LaneBackgroundNode } from "../graph/nodes/LaneBackgroundNode";
import { TerritoryZoneNode, TerritoryLandingNode } from "../graph/nodes/TerritoryNode";
import { InteractiveEdge } from "../graph/edges/InteractiveEdge";
import { GraphFilterPanel, type GraphFilters } from "../components/GraphFilterPanel";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { TerritorySkelToggle, type TerritorySkel } from "../components/TerritoryModeBar";
import { useColorMode, minimapMaskColor } from "../graph/colorMode";
import { computeSpotlightLayout } from "../graph/threeLane";
import { partitionForSkel } from "../graph/territory";
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
  task: TaskNode,
  decision: DecisionNode,
  fact: FactNode,
  moduleGroup: ModuleGroupNode,
  laneBackground: LaneBackgroundNode,
  territoryZone: TerritoryZoneNode,
  territoryLanding: TerritoryLandingNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // 外部 focusRef 变更 → push(去重当前位,截断 forward)。
  // 只在 focusRef 真正变化时 push(useEffect 依赖 [focusRef])。
  useEffect(() => {
    if (focusRef) {
      histDispatch({ type: "push", ref: focusRef });
    }
  }, [focusRef]);

  const openFocus = useCallback(
    (ref: string | null) => {
      if (!ref) {
        onFocusEntityChange?.(null);
        return;
      }
      onFocusEntityChange?.(ref);
    },
    [onFocusEntityChange],
  );

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
    setSelectedId(null);
    setFocusEdgeId(null);
  }, [onFocusEntityChange]);

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

  const territoryNodes = useMemo(() => {
    if (!territory) return [];
    const nodes: any[] = [];
    const colW = 260;
    const colGap = 32;
    const maxPerCol = 3;
    territory.zones.forEach((zone, i) => {
      const col = i % maxPerCol;
      const row = Math.floor(i / maxPerCol);
      nodes.push({
        id: zone.zoneId,
        type: "territoryZone",
        position: { x: col * (colW + colGap), y: row * 220 },
        data: { zone, collapsed: collapsedZones.has(zone.zoneId), onOpen: enterSpotlight, onFold: toggleZone },
        draggable: false,
      });
    });
    // landing chips(孤立 decision)。
    if (territory.landing.length > 0) {
      const landingCol = territory.zones.length % maxPerCol;
      const landingRow = Math.floor(territory.zones.length / maxPerCol);
      nodes.push({
        id: "__landing__",
        type: "territoryLanding",
        position: { x: landingCol * (colW + colGap), y: landingRow * 220 },
        data: { chips: territory.landing, onOpen: enterSpotlight },
        draggable: false,
      });
    }
    return nodes;
  }, [territory, collapsedZones, enterSpotlight, toggleZone]);

  // ---- 聚光灯布局 ----
  const spotlight = useMemo(() => {
    if (viewMode !== "spotlight") return null;
    return computeSpotlightLayout(
      focusRef,
      tasks,
      decisions,
      facts,
      factAnchors ?? [],
      relations,
      coverageRows ?? [],
      {
        axes: filters.axes,
        kinds: filters.kinds,
        modules: filters.modules,
        types: filters.types,
        flowMode,
      },
    );
  }, [viewMode, focusRef, tasks, decisions, facts, factAnchors, relations, coverageRows, filters, flowMode]);

  // ---- 实体状态筛选(聚光灯) ----
  const statusVisibleIds = useMemo(() => {
    if (!spotlight) return null;
    const narrowed = isStatusNarrowed(filters.entityStatus);
    if (!narrowed) return null;
    const ids = new Set<string>();
    for (const n of spotlight.nodes) {
      if (n.type === "laneBackground") {
        ids.add(n.id);
        continue;
      }
      if (n.id === spotlight.focusId) {
        ids.add(n.id);
        continue;
      }
      const data = n.data as any;
      const entity = data?.entity ?? n.type;
      if (nodePassesEntityStatusFilter(entity, data?.raw ?? data, filters.entityStatus)) {
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
      .map((n) => {
        if (n.id === selectedId) return { ...n, selected: true };
        return n;
      });
  }, [viewMode, territoryNodes, spotlight, statusVisibleIds, selectedId]);

  const displayEdges = useMemo(() => {
    if (viewMode !== "spotlight" || !spotlight) return [];
    return spotlight.edges.filter((e) => {
      if (!edgePassesKindFilter({ kind: (e.data as any)?.kind }, filters.kinds)) return false;
      if (statusVisibleIds && (!statusVisibleIds.has(e.source) || !statusVisibleIds.has(e.target))) return false;
      return true;
    });
  }, [viewMode, spotlight, filters.kinds, statusVisibleIds]);

  // fitView on layout/mode change.
  useEffect(() => {
    if (displayNodes.length === 0) return;
    const frame = requestAnimationFrame(() => fitView({ padding: 0.12, duration: 120 }));
    return () => cancelAnimationFrame(frame);
  }, [displayNodes.length, displayEdges.length, fitView, viewMode, skel]);

  // Esc 清选/清边。
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

  const onNodeClick = useCallback(
    (_: any, node: any) => {
      if (node.type === "laneBackground" || node.type === "territoryZone" || node.type === "territoryLanding") return;
      setSelectedId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );

  const onNodeDoubleClick = useCallback(
    (_: any, node: any) => {
      if (viewMode === "territory") return;
      if (node.type === "laneBackground") return;
      const data = node.data as any;
      // 把 nodeId 翻译回 navRef 设焦点。
      const entity = data?.entity ?? node.type;
      const ref =
        entity === "task"
          ? `task/${node.id}`
          : entity === "decision"
            ? node.id
            : node.id;
      openFocus(ref);
    },
    [viewMode, openFocus],
  );

  const onEdgeClick = useCallback((_: any, edge: any) => {
    setSelectedId(null);
    setFocusEdgeId((prev) => (prev === edge.id ? null : edge.id));
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    setFocusEdgeId(null);
  }, []);

  // ---- Drawer ----
  const focusNode = useMemo(() => {
    if (!spotlight) return null;
    const id = selectedId ?? spotlight.focusId;
    return spotlight.nodes.find((n) => n.id === id && n.type !== "laneBackground") ?? null;
  }, [spotlight, selectedId]);

  const focusEdge = useMemo(
    () => (focusEdgeId ? displayEdges.find((e) => e.id === focusEdgeId) : null),
    [focusEdgeId, displayEdges],
  );

  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    if (spotlight) {
      for (const n of spotlight.nodes) {
        if (n.type === "laneBackground") continue;
        const data = n.data as any;
        map.set(n.id, {
          id: n.id,
          entity: data?.entity ?? n.type,
          label: data?.label,
          sub: data?.sub,
          task: data?.entity === "task" ? data : undefined,
          raw: data?.raw ?? data,
        });
      }
    }
    return map;
  }, [spotlight]);

  // ---- 焦点直接邻居计数(drawer 上下游) ----
  const { upCount, downCount } = useMemo(() => {
    if (!spotlight?.focusId) return { upCount: 0, downCount: 0 };
    let up = 0;
    let down = 0;
    for (const e of spotlight.edges) {
      if (e.source === spotlight.focusId) down += 1;
      if (e.target === spotlight.focusId) up += 1;
    }
    return { upCount: up, downCount: down };
  }, [spotlight]);

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

  const visibleNodeCount =
    viewMode === "spotlight"
      ? displayNodes.filter((n) => n.type !== "laneBackground").length
      : displayNodes.length;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-text-muted">
        <span className="font-mono text-text-faint">
          {viewMode === "territory" ? `领地 · ${territory?.zones.length ?? 0} zone` : `聚光灯 · ${visibleNodeCount} 节点 · ${displayEdges.length} 边`}
        </span>
        {viewMode === "spotlight" && spotlight && (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-border-strong bg-surface-raised" />
              task
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rotate-45 border border-accent bg-accent-fg" />
              decision
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full border border-stale bg-surface-raised" />
              fact
            </span>
          </>
        )}
        {territory && territory.unprojectedCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-stale/10 px-1.5 py-0.5 font-mono text-stale"
            title="module/PLT 字段缺失,归入「未投影」zone —— 严禁缺字段当绿灯"
          >
            未投影 · {territory.unprojectedCount}
          </span>
        )}
        <span className="ml-auto text-text-faint">
          {viewMode === "spotlight"
            ? focusRef
              ? "单击选中 · 双击设焦点 · Esc 退出"
              : "从领地选实体,或在命令面板(⌘K)搜索"
            : "zone chip 单击 → 聚光灯"}
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
          minZoom={0.1}
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
              if (n.type === "laneBackground" || n.type === "territoryZone") return "rgba(255, 255, 255, 0.04)";
              if (n.type === "decision") return "var(--color-accent)";
              if (n.type === "fact") return "var(--color-stale)";
              return "var(--color-border-strong)";
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
                <span>折叠 zone:</span>
                <button
                  onClick={() => {
                    const all = new Set(territory?.zones.map((z) => z.zoneId) ?? []);
                    setCollapsedZones((cur) => (cur.size === all.size ? new Set() : all));
                  }}
                  className="rounded px-1 font-mono text-[10px] hover:bg-surface"
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

        {viewMode === "spotlight" && (focusNode || focusEdge) && (
          <GraphDrawer
            focusNode={
              focusNode
                ? (drawerNodesMap.get(focusNode.id) ?? undefined)
                : undefined
            }
            focusEdge={focusEdge ? (focusEdge.data as unknown as RelationEdge) : undefined}
            nodes={drawerNodesMap}
            edges={relations}
            upCount={upCount}
            downCount={downCount}
            onClose={() => {
              setSelectedId(null);
              setFocusEdgeId(null);
            }}
            onFocus={(id) => {
              const data = drawerNodesMap.get(id);
              const ref = data?.entity === "task" ? `task/${id}` : id;
              openFocus(ref);
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
