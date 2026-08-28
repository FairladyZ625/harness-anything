import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { TerritoryZoneNode, TerritoryChipNode } from "../graph/nodes/TerritoryNode";
import { GraphFilterPanel, type GraphFilters } from "../components/GraphFilterPanel";
import { GraphLegend } from "../components/GraphLegend.tsx";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { FocusSwitcher } from "../components/FocusSwitcher";
import type { PaletteEntry } from "../components/CommandPalette.tsx";
import { TerritorySkelToggle, type TerritorySkel } from "../components/TerritoryModeBar";
import { useColorMode, minimapMaskColor } from "../graph/colorMode";
import { EgoNeighborhood } from "../graph/EgoNeighborhood";
import { partitionForSkel } from "../graph/territory";
import { layoutTerritory } from "../graph/territoryLayout";
import { defaultKindFilter, defaultAxisFilter, type FlowAnimMode } from "../graph/relationVisual";
import {
  defaultEntityStatusFilter,
  taskPassesStatusFilter,
  decisionPassesStateFilter,
} from "../graph/entityStatusFilter";
import { focusHistoryReducer, EMPTY_HISTORY, canBack, canForward } from "../navigation/focusHistory";
import { activeProducesFactRefs } from "../model/triadic";
import { isTaskArchiveNoise } from "../model/taskFilters";
import {
  graphTerritoryPreferenceStorage,
  readGraphTerritoryShowArchived,
  writeGraphTerritoryShowArchived,
} from "../graph-territory-preferences";

export type ViewMode = "territory" | "spotlight";

/**
 * 关系图页:领地 + 聚光灯双模式。
 *
 * 聚光灯的 ego 画布自 W4 起抽为可复用组件 graph/EgoNeighborhood(契约见彼处),
 * 本页是它的首个宿主 —— 领地模式下该组件不渲染画布子树但保持挂载,画布累积态
 * (已铺开邻居/已展开卡片)在两态间不丢(D6 焦点连续性),DOM 里同一时刻只有一个
 * ReactFlow。
 */
const nodeTypes = {
  territoryZone: TerritoryZoneNode,
  territoryChip: TerritoryChipNode,
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
  recentRefs = [],
  entries = [],
  onOpenPalette = () => {},
}: {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity?: (ref: string) => void;
  onFocusEntityChange?: (ref: string | null) => void;
  /** 最近访问 navRef 列表(App 层 pushRecent 维护),左栏 Recent 段数据源。 */
  recentRefs?: ReadonlyArray<string>;
  /** 统一实体索引(buildPaletteIndex 产物),左栏 typeahead 与 Recent 反解共用。 */
  entries?: ReadonlyArray<PaletteEntry>;
  /** 点击 ⌘K 徽标打开全局面板。 */
  onOpenPalette?: () => void;
  focusRef: string | null;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
}) {
  const colorMode = useColorMode();
  const { setViewport } = useReactFlow();

  const [skel, setSkel] = useState<TerritorySkel>("unified");
  // 折叠语义与老版同源:默认折叠(只显每块前 N 个热点 chip),expandedZones 是
  // 用户手动展开的 zone 集。上千实体的真实数据下,折叠态保证首屏可读。
  const [expandedZones, setExpandedZones] = useState<Set<string>>(() => new Set());
  const [flowMode, setFlowMode] = useState<FlowAnimMode>("focus");
  // 领地降噪开关(task_b92c5138):默认关 = 隐藏 cancelled/archived task(看板同规则,
  // 判定 isTaskArchiveNoise 单一定义);localStorage 按视图记忆,坏值回落默认。
  const [showArchived, setShowArchived] = useState(() =>
    readGraphTerritoryShowArchived(graphTerritoryPreferenceStorage()),
  );
  useEffect(() => {
    writeGraphTerritoryShowArchived(graphTerritoryPreferenceStorage(), showArchived);
  }, [showArchived]);
  // 聚光灯布局统计(EgoNeighborhood 上报,页头计数与焦点面包屑共用)。
  const [spotlightStats, setSpotlightStats] = useState<{ nodes: number; edges: number; focusLabel: string | null }>({
    nodes: 0,
    edges: 0,
    focusLabel: null,
  });

  // 领地摆放区宽度(ResizeObserver 实测):列数由它派生,而非固定 3 列。
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((prev) => (Math.abs(prev - width) > 1 ? width : prev));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const availableModules = useMemo(() => Array.from(new Set(tasks.map((t) => t.module))).sort(), [tasks]);

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
    // ego 画布累积态由 EgoNeighborhood 在 focusRef→null 时自清。
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
  // 筛选口径与 archive 线对齐:module/实体类型/实体状态筛选同样作用于领地。单种类 skel
  // 下 types 由 skel 独占。状态筛选在**行**上生效(archive 是过滤已渲染节点):块计数因此
  // 与可见 chip 一致,不会出现「徽章记了一笔、屏幕纹丝不动」的空筛。fact 不受状态筛选。
  // 降噪(默认隐藏 cancelled/archived task)走同一条行过滤(isTaskArchiveNoise,与看板
  // 共用),所以块/进度计数同样只数可见行;领地 L1 无关系线,隐藏行不留下悬空边。
  const territoryTypes = useMemo(
    () => (skel === "task" || skel === "decision" || skel === "fact" ? new Set<string>([skel]) : filters.types),
    [skel, filters.types],
  );
  const territory = useMemo(() => {
    if (viewMode !== "territory") return null;
    const taskVisible = (task: TaskRow) =>
      filters.modules.has(task.module) &&
      territoryTypes.has("task") &&
      taskPassesStatusFilter(task, filters.entityStatus) &&
      (showArchived || !isTaskArchiveNoise(task));
    const visibleTasks = tasks.filter(taskVisible);
    const moduleByTaskId = new Map(tasks.map((task) => [task.taskId, task.module] as const));
    // fact 跟随宿主 task 的 module 可见性;无宿主(未知/外部)不因 module 筛选隐藏。
    const ownerTaskForFact = (fact: FactRef) => {
      const ref = fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`;
      return activeProducesFactRefs(relations)
        .find((edge) => edge.targetRef === ref)
        ?.sourceRef.slice("task/".length);
    };
    const factVisible = (fact: FactRef) => {
      const ownerTaskId = ownerTaskForFact(fact),
        ownerModule = ownerTaskId ? moduleByTaskId.get(ownerTaskId) : undefined;
      return territoryTypes.has("fact") && (ownerModule === undefined || filters.modules.has(ownerModule));
    };
    return partitionForSkel(
      skel,
      visibleTasks,
      territoryTypes.has("decision")
        ? decisions.filter((decision) => decisionPassesStateFilter(decision, filters.entityStatus))
        : [],
      facts.filter(factVisible),
      factAnchors ?? [],
      relations,
      coverageRows ?? [],
    );
  }, [
    viewMode,
    skel,
    tasks,
    decisions,
    facts,
    factAnchors,
    relations,
    coverageRows,
    filters.modules,
    filters.entityStatus,
    territoryTypes,
    showArchived,
  ]);

  const toggleZone = useCallback((zoneId: string) => {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  // 两级布局(archive 结构):zone 壳 + 独立 chip 节点,列数随容器宽派生,
  // 盒高跟随 chip 数(行推进用行内最大高,零重叠)。分区数据见 graph/territory.ts。
  const territoryNodes = useMemo(() => {
    if (!territory) return [];
    return layoutTerritory({
      partition: territory,
      expandedZones,
      containerWidth,
      onOpen: enterSpotlight,
      onFold: toggleZone,
    }).nodes;
  }, [territory, expandedZones, containerWidth, enterSpotlight, toggleZone]);

  // 视口策略(与老版同源):聚光灯 fitView 在 EgoNeighborhood 内;领地**不 fitView** ——
  // 上千块 fit 进一屏正是「块被压成几像素细横条」的成因,领地以默认视口(zoom 1,
  // 左上角)打开,块保持可读尺寸,漫游交给 pan/zoom + MiniMap。
  useEffect(() => {
    if (viewMode !== "territory") return;
    const frame = requestAnimationFrame(() => void setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [setViewport, viewMode, skel]);

  const breadcrumb = useMemo(() => {
    if (!focusRef) return null;
    const parsed = parseEndpoint(focusRef);
    if (!parsed) return null;
    return {
      kindLabel: parsed.entity,
      title: spotlightStats.focusLabel ?? parsed.id,
      nodeId: parsed.id,
    };
  }, [focusRef, spotlightStats.focusLabel]);

  if (tasks.length === 0 && decisions.length === 0 && facts.length === 0 && (factAnchors?.length ?? 0) === 0) {
    return (
      <div
        data-testid="triadic-graph-empty-state"
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
      >
        <div className="text-[14px] font-semibold text-text">暂无三元语关系数据</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          当前 ledger 没有可投影的 task、decision 或 fact。记录出现后,领地与聚光灯会自动显示真实节点与 kernel relation
          边。
        </div>
      </div>
    );
  }

  const filterPanel = (
    <GraphFilterPanel
      filters={filters}
      setFilters={setFilters}
      availableModules={availableModules}
      showEntityTypes={viewMode === "spotlight" || skel === "unified"}
      flowMode={flowMode}
      onFlowModeChange={setFlowMode}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-text-muted">
        <span className="font-mono text-text-faint">
          {viewMode === "territory"
            ? `领地 · ${territory?.zones.length ?? 0} 块`
            : `聚光灯 · ${spotlightStats.nodes} 节点 · ${spotlightStats.edges} 边`}
        </span>
        <GraphLegend showFulfillment={(coverageRows?.length ?? 0) > 0} />
        {viewMode === "territory" && (
          <span
            className="inline-flex items-center gap-1 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted"
            title="与看板同一条降噪规则:status=cancelled 或 package disposition≠active 的 task 默认不画;点击切回全量(本机记忆)"
          >
            已归档
            <button
              data-testid="territory-archive-toggle"
              onClick={() => setShowArchived((v) => !v)}
              className="rounded px-1 text-[11px] text-text hover:bg-surface"
            >
              {showArchived ? "显示" : "隐藏"}
            </button>
          </span>
        )}
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

      <div className="flex min-h-0 flex-1">
        <FocusSwitcher
          recentRefs={recentRefs}
          entries={entries}
          focusRef={focusRef}
          onFocus={(ref) => (viewMode === "territory" ? enterSpotlight(ref) : openFocus(ref))}
          onOpenPalette={onOpenPalette}
        />
        <div ref={canvasHostRef} className="flex min-h-0 min-w-0 flex-1 relative">
          {viewMode === "territory" && (
            <ReactFlow
              nodes={territoryNodes}
              nodeTypes={nodeTypes}
              colorMode={colorMode}
              minZoom={0.05}
              maxZoom={2}
              zoomOnDoubleClick={false}
              nodesDraggable={false}
              nodesConnectable={false}
              attributionPosition="bottom-right"
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-border)" />
              <Controls className="bg-surface-raised border-border" />
              <MiniMap
                data-testid="graph-minimap"
                bgColor="var(--color-surface)"
                nodeColor={(n) => {
                  if (n.type === "territoryZone") return "var(--color-border)";
                  if (n.type === "territoryChip") {
                    const entity = (n.data as any)?.chip?.entity;
                    if (entity === "decision") return "var(--color-axis-authority)";
                    if (entity === "fact") return "var(--color-axis-evidence)";
                    if (entity === "task") return "var(--color-axis-execution)";
                    return "var(--color-border-strong)";
                  }
                  return "var(--color-border-strong)";
                }}
                nodeStrokeColor="var(--color-border-strong)"
                maskColor={minimapMaskColor(colorMode)}
                className="border border-border rounded overflow-hidden"
                pannable
                zoomable
              />
              <Panel position="top-left">
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-muted">
                  <span>折叠块:</span>
                  <button
                    onClick={() => {
                      const all = new Set(territory?.zones.map((z) => z.zoneId) ?? []);
                      setExpandedZones((cur) => (cur.size === all.size ? new Set() : all));
                    }}
                    className="rounded px-1 font-mono text-[11px] hover:bg-surface"
                  >
                    {territory && expandedZones.size > 0 && expandedZones.size >= territory.zones.length
                      ? "全部折叠"
                      : "全部展开"}
                  </button>
                </div>
              </Panel>
              <TerritorySkelToggle skel={skel} onSkelChange={setSkel} />
              <Panel position="top-left">{filterPanel}</Panel>
            </ReactFlow>
          )}
          <EgoNeighborhood
            focusRef={focusRef}
            tasks={tasks}
            decisions={decisions}
            facts={facts}
            relations={relations}
            factAnchors={factAnchors ?? EMPTY_ANCHORS}
            filters={{
              axes: filters.axes,
              kinds: filters.kinds,
              types: filters.types,
              flowMode,
              statusFilter: filters.entityStatus,
            }}
            onNavigateEntity={onNavigateEntity}
            onRefocus={openFocus}
            onLayoutStats={setSpotlightStats}
            panelSlot={filterPanel}
            active={viewMode === "spotlight"}
          />
        </div>
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
