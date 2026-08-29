import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { EdgeMouseHandler, NodeMouseHandler } from "@xyflow/react";
import type { ReactNode } from "react";
import type { TaskRow, RelationEdge, DecisionRow, FactRef, RelationKind } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import { endpointToNodeId, type NodePos } from "./endpoint";
import { GraphDrawer } from "./GraphDrawer";
import { EgoNode } from "./nodes/EgoNode";
import { InteractiveEdge } from "./edges/InteractiveEdge";
import { useColorMode, minimapMaskColor } from "./colorMode";
import { useEgoCanvas } from "./useEgoCanvas";
import { layoutEgoCanvas, type EgoAxisFilter, type EgoFlowEdge, type EgoFlowNode } from "./egoCanvas";
import { defaultKindFilter, edgePassesKindFilter, type FlowAnimMode } from "./relationVisual";
import {
  defaultEntityStatusFilter,
  nodePassesEntityStatusFilter,
  type EntityStatusFilterState,
} from "./entityStatusFilter";

/**
 * 可复用邻域画布(W4):「这个实体周围有什么」的独立组件形态。
 *
 * 从 GraphView 的聚光灯分支抽出,自包含 ego 状态机(useEgoCanvas)+ 布局
 * (layoutEgoCanvas)+ 交互(单击展开/双击设中心/Esc 清选)+ 抽屉(GraphDrawer)。
 * 不含页面级状态:领地模式、筛选面板、焦点历史条、左栏焦点切换器都留在宿主里,
 * 宿主通过 props 注入筛选与跳转回调。首个消费者是关系图页本身(同一渲染路径,
 * 行为不变),随后是 Fact/Decision 详情页与 Task 详情(W3)。
 *
 * 契约:
 *   focusRef 变化 → 画布重排到新焦点(±EGO_DEFAULT_HOPS 跳);
 *   focusRef 变 null → 累积态清空(与 GraphView 原 clearFocus 行为一致);
 *   onRefocus        — 双击节点 / 卡片「设为画布中心」(宿主决定是换焦点还是跳页);
 *   onNavigateEntity — 卡片「详情」/ 抽屉「打开」(跳去该实体的详情页)。
 */
export interface EgoNeighborhoodFilters {
  axes: EgoAxisFilter;
  kinds: ReadonlySet<RelationKind>;
  types: ReadonlySet<string>;
  flowMode: FlowAnimMode;
  /** 实体状态筛选(聚光灯灰化口径);缺省 = 全选不筛。 */
  statusFilter?: EntityStatusFilterState;
}

export function defaultNeighborhoodFilters(): EgoNeighborhoodFilters {
  return {
    axes: { authority: true, evidence: true, execution: true, assoc: false },
    kinds: defaultKindFilter(),
    types: new Set(["decision", "task", "fact"]),
    flowMode: "focus",
  };
}

export type EgoNeighborhoodProps = {
  focusRef: string | null;
  tasks: readonly TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  factAnchors: ReadonlyArray<FactAnchorRow>;
  filters?: EgoNeighborhoodFilters;
  onNavigateEntity?: (ref: string) => void;
  onRefocus?: (ref: string) => void;
  /** 布局统计回调(宿主页头用:聚光灯 header 的「N 节点 · M 边」与焦点面包屑标题)。 */
  onLayoutStats?: (stats: { nodes: number; edges: number; focusLabel: string | null }) => void;
  /** 左上角面板插槽(宿主塞筛选面板等页面级 chrome)。 */
  panelSlot?: ReactNode;
  /** 「设为画布中心」按钮/双击的提示文案;详情页里该动作语义是跳页,由宿主改写。 */
  refocusTitle?: string;
  /** false = 隐藏但保持挂载(宿主切换领地/聚光灯时保留画布累积态)。 */
  active?: boolean;
};

const nodeTypes = { ego: EgoNode };
const edgeTypes = { interactive: InteractiveEdge };
const DEFAULT_STATUS_FILTER = defaultEntityStatusFilter();

function EgoNeighborhoodInner({
  focusRef,
  tasks,
  decisions,
  facts,
  relations,
  factAnchors,
  filters,
  onNavigateEntity,
  onRefocus,
  onLayoutStats,
  panelSlot,
  refocusTitle,
  active = true,
}: EgoNeighborhoodProps & { filters: EgoNeighborhoodFilters }) {
  const colorMode = useColorMode();
  const { fitView } = useReactFlow();

  const statusFilter = filters.statusFilter ?? DEFAULT_STATUS_FILTER;
  const [focusEdgeId, setFocusEdgeId] = useState<string | null>(null);

  const canvas = useEgoCanvas({
    tasks,
    decisions,
    facts,
    relations,
    factAnchors,
    axes: filters.axes,
    focusRef,
  });

  // focusRef → null(清除焦点)= 清空累积态。GraphView 原先在 clearFocus 里显式
  // 调 canvas.clearCanvas() 并清边抽屉;抽组件后由本组件自持该不变量。
  const clearCanvasRef = useRef(canvas.clearCanvas);
  clearCanvasRef.current = canvas.clearCanvas;
  useEffect(() => {
    if (!focusRef) {
      clearCanvasRef.current();
      setFocusEdgeId(null);
    }
  }, [focusRef]);

  const openFocus = useCallback(
    (ref: string) => {
      onRefocus?.(ref);
    },
    [onRefocus],
  );

  const spotlight = useMemo(
    () =>
      canvas.focusId
        ? layoutEgoCanvas({
            focusId: canvas.focusId,
            graph: canvas.graph,
            relations,
            filters: {
              axes: filters.axes,
              kinds: filters.kinds,
              types: filters.types,
              flowMode: filters.flowMode,
            },
            shown: canvas.shown,
            expanded: canvas.expanded,
            highlight: canvas.highlight,
          })
        : null,
    [
      canvas.focusId,
      canvas.graph,
      canvas.shown,
      canvas.expanded,
      canvas.highlight,
      relations,
      filters.axes,
      filters.kinds,
      filters.types,
      filters.flowMode,
    ],
  );

  const statusVisibleIds = useMemo(() => {
    if (!spotlight) return null;
    if (!isStatusNarrowed(statusFilter)) return null;
    const ids = new Set<string>();
    for (const n of spotlight.nodes) {
      const data = n.data;
      if (n.id === spotlight.focusId) {
        ids.add(n.id);
        continue;
      }
      if (data.entity === "fact") {
        ids.add(n.id);
        continue;
      }
      if (nodePassesEntityStatusFilter(data.entity, data.raw, statusFilter)) {
        ids.add(n.id);
      }
    }
    return ids;
  }, [spotlight, statusFilter]);

  const displayNodes = useMemo(() => {
    if (!spotlight) return [];
    return spotlight.nodes
      .filter((n) => (statusVisibleIds ? statusVisibleIds.has(n.id) : true))
      .map((n) => ({
        ...n,
        selected: n.id === canvas.selectId,
        data: {
          ...n.data,
          onCollapse: canvas.collapseNode,
          onRefocus: openFocus,
          onNavigate: onNavigateEntity,
          ...(refocusTitle ? { refocusTitle } : {}),
        },
      }));
  }, [spotlight, statusVisibleIds, canvas.selectId, canvas.collapseNode, openFocus, onNavigateEntity, refocusTitle]);

  const displayEdges = useMemo(() => {
    if (!spotlight) return [];
    return spotlight.edges.filter((e) => {
      if (!e.data || !edgePassesKindFilter(e.data, filters.kinds)) return false;
      if (statusVisibleIds && (!statusVisibleIds.has(e.source) || !statusVisibleIds.has(e.target))) return false;
      return true;
    });
  }, [spotlight, filters.kinds, statusVisibleIds]);

  useEffect(() => {
    const focusLabel = canvas.focusId ? (displayNodes.find((n) => n.id === canvas.focusId)?.data.label ?? null) : null;
    onLayoutStats?.({ nodes: displayNodes.length, edges: displayEdges.length, focusLabel });
  }, [displayNodes, displayEdges.length, onLayoutStats, canvas.focusId]);

  // 视口策略(与原 GraphView 同源):聚光灯 fitView 一屏装下 ego 图。
  useEffect(() => {
    if (!active) return;
    if (displayNodes.length === 0) return;
    const frame = requestAnimationFrame(() => fitView({ padding: 0.12, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [active, canvas.focusId, displayNodes.length, fitView]);

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
  const onNodeClick: NodeMouseHandler<EgoFlowNode> = useCallback(
    (_, node) => {
      if (canvas.expanded.has(node.id)) canvas.collapseNode(node.id);
      else canvas.expandNode(node.id);
      canvas.selectNode(node.id);
    },
    [canvas],
  );

  // 双击 = 设为画布中心(唯一会重排画布的节点交互)。
  const onNodeDoubleClick: NodeMouseHandler<EgoFlowNode> = useCallback(
    (_, node) => {
      const navRef = node.data.navRef;
      openFocus(navRef);
    },
    [openFocus],
  );

  const onEdgeClick: EdgeMouseHandler<EgoFlowEdge> = useCallback(
    (_, edge) => {
      canvas.clearSelect();
      setFocusEdgeId((prev) => (prev === edge.id ? null : edge.id));
    },
    [canvas],
  );

  const onPaneClick = useCallback(() => {
    canvas.clearSelect();
    setFocusEdgeId(null);
  }, [canvas]);

  // ---- Drawer ----
  const drawerNodeId = canvas.selectId ?? canvas.focusId;

  const drawerNodesMap = useMemo(() => {
    const map = new Map<string, NodePos>();
    if (spotlight) {
      for (const n of spotlight.nodes) {
        const data = n.data;
        map.set(n.id, {
          id: n.id,
          entity: data.entity,
          label: data.label,
          ...(data.sub ? { sub: data.sub } : {}),
          task: data.entity === "task" ? (data.raw as TaskRow) : undefined,
          raw: data.raw,
          x: n.position.x,
          y: n.position.y,
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

  // 非激活(宿主在领地模式)时不渲染画布子树:DOM 里同一时刻只有一个
  // ReactFlow(可访问性 role=application 不重复,`.react-flow` 选择器不二义)。
  // ego 累积态(shown/expanded/selectId)在 hooks 里,组件保持挂载即保留。
  if (!active) return null;

  return (
    // 行轴:画布吃剩余宽,GraphDrawer 是它右侧的定宽栏(w-[26rem] shrink-0 border-l)。
    // 写成 flex-col 会把这个侧栏压成底部横条 —— 横条按 shrink-0 占满整条带宽的高度,
    // 却只填得下 26rem,带内其余部分是纯空区,同时把画布高度吃掉(内容一多吃到 0)。
    <div className="relative flex h-full min-h-0 min-w-0 flex-1">
      <ReactFlow<EgoFlowNode, EgoFlowEdge>
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
        attributionPosition="bottom-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-border)" />
        <Controls className="bg-surface-raised border-border" />
        <MiniMap<EgoFlowNode>
          data-testid="graph-minimap"
          bgColor="var(--color-surface)"
          nodeColor={(n) => {
            const entity = n.data.entity;
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
        {panelSlot && <Panel position="top-left">{panelSlot}</Panel>}
      </ReactFlow>

      {(drawerNodeId || focusEdge) && (
        <GraphDrawer
          focusNode={drawerNodeId ? (drawerNodesMap.get(drawerNodeId) ?? undefined) : undefined}
          focusEdge={focusEdge?.data}
          nodes={drawerNodesMap}
          edges={relations}
          upCount={upCount}
          downCount={downCount}
          onClose={() => {
            canvas.clearSelect();
            setFocusEdgeId(null);
          }}
          onFocus={(id) => {
            if (!id) return;
            const data = drawerNodesMap.get(id);
            openFocus(data?.entity === "task" ? `task/${id}` : id);
          }}
          onNavigateEntity={onNavigateEntity}
        />
      )}
    </div>
  );
}

function isStatusNarrowed(state: EntityStatusFilterState): boolean {
  const taskFull = 7; // BOARD_COLUMNS length(6) + 1 other
  const decFull = 6; // DECISION_STATE length(5) + 1 other
  return state.taskStatuses.size < taskFull || state.decisionStates.size < decFull;
}

export function EgoNeighborhood(props: EgoNeighborhoodProps) {
  return (
    <ReactFlowProvider>
      <EgoNeighborhoodInner {...props} filters={props.filters ?? defaultNeighborhoodFilters()} />
    </ReactFlowProvider>
  );
}
