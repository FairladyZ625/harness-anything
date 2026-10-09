import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Panel,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { EdgeMouseHandler, NodeMouseHandler, OnMoveEnd } from "@xyflow/react";
import type { ReactNode } from "react";
import type { TaskRow, RelationEdge, DecisionRow, FactRef, RelationKind } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import {
  layoutEgoCanvas,
  type EgoAxisFilter,
  type EgoFlowEdge,
  type EgoFlowNode,
  type EgoHopBudget,
} from "./egoCanvas";
import { mergeEgoSession, readEgoSessionFor } from "./egoSession";
import { useEntryMotion } from "../motion-config.tsx";
import { GraphDrawer } from "./GraphDrawer";
import { EgoNode } from "./nodes/EgoNode";
import { InteractiveEdge } from "./edges/InteractiveEdge";
import { useColorMode, minimapMaskColor } from "./colorMode";
import { EGO_DEFAULT_HOPS, useEgoCanvas } from "./useEgoCanvas";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";
import { defaultAxisFilter, defaultKindFilter, edgePassesKindFilter, type FlowAnimMode } from "./relationVisual";
import {
  defaultEntityStatusFilter,
  isEntityStatusFilterNarrowed,
  nodePassesEntityStatusFilter,
  type EntityStatusFilterState,
} from "./entityStatusFilter";

/**
 * 可复用邻域画布(W4):「这个实体周围有什么」的独立组件形态。
 *
 * 从 GraphView 的聚光灯分支抽出,自包含 ego 状态机(useEgoCanvas)+ 布局
 * (layoutEgoCanvas)+ 交互(单击原位展开/双击设中心/Esc 收正文)+ 边抽屉
 * (GraphDrawer)。图场景 2026-10-02 恢复节点原位展开(task_baca8e2b3e32c288fbd14b71f0,
 * 业主批准;旧 §5.2「节点一律 chip、摘要进抽屉」被该指令覆盖):单击节点 = 原位展开
 * 摘要卡片并长出下一环邻居(不自动开抽屉,节点与抽屉正文不重复);双击 = 以它为中心
 * 重排邻域;Esc = 收正文(已长出的邻居保留)。不含页面级状态:领地模式、筛选面板、
 * 焦点历史条、左栏焦点切换器都留在宿主里,宿主通过 props 注入筛选与跳转回调。
 * 首个消费者是关系图页本身,随后是 Fact/Decision 详情页与 Task 详情(W3)。
 *
 * 契约:
 *   focusRef 变化 → 画布重排到新焦点(±hops 跳);
 *   focusRef 变 null → 累积态清空(与 GraphView 原 clearFocus 行为一致);
 *   主图启用 rememberSession 后同仓同焦点挂载 → 原样接续;嵌入邻域不读写会话;
 *   onRefocus        — 双击节点 / 卡片「设为焦点」(宿主决定是换焦点还是跳页);
 *   onNavigateEntity — 卡片「详情」(跳去该实体的详情页,返回经会话恢复原图)。
 */
export interface EgoNeighborhoodFilters {
  axes: EgoAxisFilter;
  kinds: ReadonlySet<RelationKind>;
  /** 选中的实体种类;null = 不按种类筛。清单来自已注册 kind 读面,本文件不持有副本。 */
  types: ReadonlySet<string> | null;
  flowMode: FlowAnimMode;
  /** 实体状态筛选(聚光灯灰化口径);缺省 = 全选不筛。 */
  statusFilter?: EntityStatusFilterState;
}

export function defaultNeighborhoodFilters(): EgoNeighborhoodFilters {
  return {
    axes: defaultAxisFilter(),
    kinds: defaultKindFilter(),
    types: null,
    flowMode: "focus",
  };
}

export type EgoNeighborhoodProps = {
  /** 会话归属仓:egoSession 按 repoId 隔离,同名 ref 跨仓不互读。 */
  repoId: string;
  /** 主图导航上下文持有会话;嵌入邻域默认不读写它。 */
  rememberSession?: boolean;
  /** The host resolves the shared reading cap from its actual container height. */
  cardHeightCap?: number;
  focusRef: string | null;
  tasks: readonly TaskRow[];
  decisions: DecisionRow[];
  facts: readonly FactRef[];
  relations: RelationEdge[];
  factAnchors: ReadonlyArray<FactAnchorRow>;
  /** 运行时平面节点行(agent/schedule);缺省 = 该平面缺席,图照常。 */
  agents?: ReadonlyArray<AgentNodeRow>;
  schedules?: ReadonlyArray<ScheduleNodeRow>;
  /** 声明实体行(vertical kind);缺省 = 该层缺席。 */
  governed?: ReadonlyArray<GovernedEntityRow>;
  filters?: EgoNeighborhoodFilters;
  /** 铺开跳数预算(父 ↑ / 子 ↓);缺省 = EGO_DEFAULT_HOPS(±2)。 */
  hops?: EgoHopBudget;
  /** 重点模式可见集(null = 不分层)。 */
  focusSet?: { readonly taskIds: ReadonlySet<string>; readonly neighborIds: ReadonlySet<string> } | null;
  /** 重点模式开关(翻转时从当前焦点重铺)。 */
  densityFocus?: boolean;
  onNavigateEntity?: (ref: string) => void;
  /** 现有 task pin 动作;其他实体没有 action 时保持只读。 */
  onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  onRefocus?: (ref: string) => void;
  /** 「设为焦点」按钮/双击的提示文案;详情页里该动作语义是跳页,由宿主改写。 */
  refocusTitle?: string;
  /** 布局统计回调(宿主页头用:聚光灯 header 的「N 节点 · M 边」与焦点面包屑标题)。 */
  onLayoutStats?: (stats: { nodes: number; edges: number; focusLabel: string | null }) => void;
  /** 左上角面板插槽(宿主塞筛选面板等页面级 chrome)。 */
  panelSlot?: ReactNode;
  /** false = 隐藏但保持挂载(宿主切换领地/聚光灯时保留画布累积态)。 */
  active?: boolean;
};

const nodeTypes = { ego: EgoNode };
const edgeTypes = { interactive: InteractiveEdge };
const DEFAULT_STATUS_FILTER = defaultEntityStatusFilter();
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

function EgoNeighborhoodInner({
  repoId,
  rememberSession = false,
  cardHeightCap,
  focusRef,
  tasks,
  decisions,
  facts,
  relations,
  factAnchors,
  agents,
  schedules,
  governed,
  filters,
  hops = EGO_DEFAULT_HOPS,
  focusSet = null,
  densityFocus = false,
  onNavigateEntity,
  onSetTaskPin,
  onRefocus,
  refocusTitle,
  onLayoutStats,
  panelSlot,
  active = true,
}: EgoNeighborhoodProps & { filters: EgoNeighborhoodFilters; hops: EgoHopBudget }) {
  const colorMode = useColorMode();
  const motion = useEntryMotion();
  const motionDuration = useRef(200);
  motionDuration.current = motion.enabled ? (motion.reduced ? 100 : 200) : 0;
  const { setCenter, getZoom } = useReactFlow();
  // 会话恢复的视口只取一次(挂载时的初值);之后视口归用户的 pan/zoom。
  const [session] = useState(() => (rememberSession ? readEgoSessionFor(repoId, focusRef) : null));
  const initialViewport = session?.viewport ?? DEFAULT_VIEWPORT;

  const statusFilter = filters.statusFilter ?? DEFAULT_STATUS_FILTER;
  const [focusEdgeId, setFocusEdgeId] = useState<string | null>(null);

  // 重点模式可见集:task 裸 id + 非 task `<kind>/<id>`,与 ego 键空间一致。
  const allowedIds = useMemo(() => {
    if (!densityFocus || !focusSet) return null;
    return new Set<string>([...focusSet.taskIds, ...focusSet.neighborIds]);
  }, [densityFocus, focusSet]);

  const canvas = useEgoCanvas({
    tasks,
    decisions,
    facts,
    relations,
    factAnchors,
    agents,
    schedules,
    governed,
    axes: filters.axes,
    repoId,
    rememberSession,
    focusRef,
    hops,
    allowedIds,
    layered: densityFocus,
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
              flowMode: motion.enabled && !motion.reduced ? filters.flowMode : "off",
            },
            shown: canvas.shown,
            expanded: canvas.expanded,
            cardHeightCap,
          })
        : null,
    [
      canvas.focusId,
      cardHeightCap,
      motion.enabled,
      motion.reduced,
      canvas.graph,
      canvas.shown,
      canvas.expanded,
      relations,
      filters.axes,
      filters.kinds,
      filters.types,
      filters.flowMode,
    ],
  );

  const statusVisibleIds = useMemo(() => {
    if (!spotlight) return null;
    if (!isEntityStatusFilterNarrowed(statusFilter)) return null;
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
        data: {
          ...n.data,
          onCollapse: canvas.collapseNode,
          onRefocus: openFocus,
          onNavigate: onNavigateEntity,
          onSetPin: onSetTaskPin,
          ...(refocusTitle ? { refocusTitle } : {}),
        },
      }));
  }, [spotlight, statusVisibleIds, canvas.collapseNode, openFocus, onNavigateEntity, onSetTaskPin, refocusTitle]);

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

  // 视口策略:相机归用户动作管,不归内容管。换焦点(双击设为中心 / 领地 chip / 搜索 /
  // 命令面板 / 焦点历史)是用户动作,平移到新焦点;展开长出邻居只是内容变多,相机不动。
  // 布局器把焦点节点的几何中心恒置于流坐标原点,所以定心到 (0,0) 即是定心到焦点;
  // zoom 原样带过去 —— 缩放级别只由用户自己改,不由节点数决定。会话恢复的那次挂载
  // 不平移:用户离开时的 pan/zoom 由 defaultViewport 原样接续。
  const hydratedFocusRef = useRef(canvas.restored ? canvas.focusId : null);
  useEffect(() => {
    if (!active) return;
    if (!canvas.focusId) return;
    if (hydratedFocusRef.current === canvas.focusId) return;
    hydratedFocusRef.current = null;
    const frame = requestAnimationFrame(
      () => void setCenter(0, 0, { zoom: getZoom(), duration: motionDuration.current }),
    );
    return () => cancelAnimationFrame(frame);
  }, [active, canvas.focusId, setCenter, getZoom]);

  // 用户 pan/zoom 落进会话(详情页返回按它恢复;非恢复挂载的初值即 DEFAULT_VIEWPORT)。
  const onMoveEnd: OnMoveEnd = useCallback(
    (_event, viewport) => {
      if (rememberSession) mergeEgoSession(repoId, { viewport });
    },
    [repoId, rememberSession],
  );

  // Esc 收正文:收起全部原位卡片 + 清边选中。只动阅读层 —— 已长出的邻居(shown)
  // 与焦点不动,探索范围不缩水。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,select")) return;
      canvas.collapseAll();
      setFocusEdgeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas]);

  // 单击 = 原位展开摘要卡片 + 长出下一环邻居;再点已展开的卡片 = 收起
  // (已长出的邻居保留,画布不重排)。
  const onNodeClick: NodeMouseHandler<EgoFlowNode> = useCallback(
    (event, node) => {
      // The first click can replace a chip with a card. Handle the second click here,
      // before toggling it closed, instead of relying on a dblclick on the replaced DOM.
      if (event.detail >= 2) {
        openFocus(node.data.navRef);
        return;
      }
      if (canvas.expanded.has(node.id)) canvas.collapseNode(node.id);
      else canvas.expandNode(node.id);
    },
    [canvas, openFocus],
  );

  const onEdgeClick: EdgeMouseHandler<EgoFlowEdge> = useCallback((_, edge) => {
    setFocusEdgeId((prev) => (prev === edge.id ? null : edge.id));
  }, []);

  const onPaneClick = useCallback(() => {
    setFocusEdgeId(null);
  }, []);

  const focusEdge = useMemo(
    () => (focusEdgeId ? displayEdges.find((e) => e.id === focusEdgeId) : null),
    [focusEdgeId, displayEdges],
  );

  // 非激活(宿主在领地模式)时不渲染画布子树:DOM 里同一时刻只有一个
  // ReactFlow(可访问性 role=application 不重复,`.react-flow` 选择器不二义)。
  // ego 累积态(shown/expanded)在 hooks 里,组件保持挂载即保留。
  if (!active) return null;

  return (
    // 画布铺满内容区(§2.6);GraphDrawer 是 fixed 定位的右侧覆盖抽屉,只承载边。
    <div className="content-viewport graph-ego-canvas relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <ReactFlow<EgoFlowNode, EgoFlowEdge>
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onMoveEnd={onMoveEnd}
        defaultViewport={initialViewport}
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
            if (entity === "agent" || entity === "schedule") return "var(--color-axis-assoc)";
            return "var(--color-axis-execution)";
          }}
          nodeStrokeColor="var(--color-border-strong)"
          maskColor={minimapMaskColor(colorMode)}
          className="border border-border rounded overflow-hidden"
          pannable
          zoomable
        />
        {panelSlot && (
          <Panel position="top-left" data-testid="ego-panel">
            {panelSlot}
          </Panel>
        )}
      </ReactFlow>

      {focusEdge && (
        <GraphDrawer
          focusEdge={focusEdge.data!}
          onClose={() => setFocusEdgeId(null)}
          onFocus={(id) => {
            if (id) openFocus(id);
          }}
          onNavigateEntity={onNavigateEntity}
        />
      )}
    </div>
  );
}

export function EgoNeighborhood(props: EgoNeighborhoodProps) {
  return (
    <ReactFlowProvider>
      <EgoNeighborhoodInner
        {...props}
        filters={props.filters ?? defaultNeighborhoodFilters()}
        hops={props.hops ?? EGO_DEFAULT_HOPS}
      />
    </ReactFlowProvider>
  );
}
