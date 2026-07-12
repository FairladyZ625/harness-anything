import { useEffect, useMemo, useState, useCallback } from "react";
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
  moduleGroup: ModuleGroupNode,
  laneBackground: LaneBackgroundNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

const EMPTY_LOOP = new Set<string>();

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
  const { fitView } = useReactFlow();
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
  const [expandedFacts, setExpandedFacts] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<FocusHistoryState>(createFocusHistory);

  // 焦点切换统一入口:更新 focusId + 推历史。重复推同 id 会被 pushFocus 折叠。
  const setFocusAndPushHistory = useCallback((id: string) => {
    setFocusId(id);
    setHistory((prev) => pushFocus(prev, id));
  }, []);

  // 跨视图带入的 focusRef → 换焦点 + 入历史(用户「跳到这张图」的足迹)。
  useEffect(() => {
    if (!focusRef) return;
    const nodeId = endpointToNodeId(focusRef);
    if (nodeId) setFocusAndPushHistory(nodeId);
    // 仅依赖 focusRef:每次外部 ref 变更都要响应,即便值相同(避免漏触发)。
  }, [focusRef, setFocusAndPushHistory]);

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
  ]);

  // Fit view when node count changes or focus changes
  useEffect(() => {
    if (nodes.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: 200 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [edges.length, fitView, nodes.length, resolvedFocusId]);

  // 单击 = 选中并开抽屉(不换焦点)。fact 节点 / claim 行的展开 toggle 仍走单击,
  // 因为它们是「展开 / 收起」局部交互,不涉及抽屉。
  const onNodeClick = useCallback(
    (evt: any, node: any) => {
      if (node.type === "laneBackground" || node.type === "moduleGroup") return;
      // 点击 fact 节点 → 折叠回去 (toggle expand)
      if (node.type === "fact" && typeof node.id === "string" && node.id.startsWith("fact/")) {
        setExpandedFacts((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
        return;
      }
      // 点击 decisionFocus 上的具体 claim 行 → 仅 toggle 该 claim 的 evidence facts。
      // 修 #4:此前点击焦点卡片任意位置都批量 toggle 所有 claim 的 fact,无法定位
      // 具体行;现在用 data-claim-id 锚到具体 claim。
      // 修 #5:factRefs 在 threeLaneLayout 里取 coverageRows.coveringFactRef 与
      // evidence 边的并集,避免仅有规范/transitive 覆盖但无 direct edge 时漏掉。
      if (node.type === "decisionFocus" && node.data?.claimRows) {
        const target = evt?.target as HTMLElement | null;
        const claimRowEl = target?.closest?.("[data-claim-id]");
        const claimId = claimRowEl?.getAttribute("data-claim-id");
        if (claimId) {
          const rows = node.data.claimRows as Array<{
            claimId: string;
            factRefs?: string[];
          }>;
          const row = rows.find((r) => r.claimId === claimId);
          const refs = row?.factRefs ?? [];
          if (refs.length > 0) {
            setExpandedFacts((prev) => {
              const next = new Set(prev);
              const allOpen = refs.every((f) => next.has(f));
              if (allOpen) refs.forEach((f) => next.delete(f));
              else refs.forEach((f) => next.add(f));
              return next;
            });
          }
          return;
        }
        // 未命中 claim 行 → 落到「选中开抽屉」(不再像旧版那样 toggle 焦点)。
      }
      setSelectedId(node.id);
      setFocusEdgeId(null);
    },
    [],
  );

  // 双击 = 设为焦点(显式切换,推历史)。
  const onNodeDoubleClick = useCallback(
    (_evt: any, node: any) => {
      if (node.type === "laneBackground" || node.type === "moduleGroup") return;
      if (!node.id || typeof node.id !== "string") return;
      setFocusAndPushHistory(node.id);
      // 双击后也把抽屉对齐到焦点,符合「我想看它的全貌」。
      setSelectedId(node.id);
      setFocusEdgeId(null);
    },
    [setFocusAndPushHistory],
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
  // 抽屉里点边列表项 = 既选中(抽屉跟着走)又换焦点(因为「跳到那个节点」就是
  // 想看它的图)。这种「抽屉里跳」就是用户的 focus 意图,推历史。
  const focusFromDrawer = useCallback(
    (id: string | null) => {
      if (!id) {
        closeDrawer();
        return;
      }
      setSelectedId(id);
      setFocusEdgeId(null);
      setFocusAndPushHistory(id);
    },
    [closeDrawer, setFocusAndPushHistory],
  );
  // 抽屉里「设为焦点」按钮 = 把当前抽屉里的节点升级为焦点(不切抽屉内容)。
  const setDrawerAsFocus = useCallback(() => {
    if (!drawerNodeId) return;
    setFocusAndPushHistory(drawerNodeId);
  }, [drawerNodeId, setFocusAndPushHistory]);

  // 历史导航:back/forward。currentFocus 为 null 表示走到历史外(默认焦点),
  // 此时仍把 focusId 同步到 null 让布局器挑默认。
  const goBackStack = useCallback(() => {
    setHistory((prev) => {
      const next = historyGoBack(prev);
      if (next === prev) return prev;
      setFocusId(currentFocus(next));
      return next;
    });
  }, []);
  const goForwardStack = useCallback(() => {
    setHistory((prev) => {
      const next = historyGoForward(prev);
      if (next === prev) return prev;
      setFocusId(currentFocus(next));
      return next;
    });
  }, []);
  const clearFocus = useCallback(() => {
    setFocusId(null);
    // 不动历史:用户「退出聚焦」不脚印化(经典浏览器也不会因为关 tab 入栈)。
  }, []);

  // Switcher 入口:点选 = 设焦点 + 抽屉跟着走。
  const switchFocusFromList = useCallback(
    (nodeId: string) => {
      setFocusAndPushHistory(nodeId);
      setSelectedId(nodeId);
      setFocusEdgeId(null);
    },
    [setFocusAndPushHistory],
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
          nodes={nodes}
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

        {(selectedNode || focusNode || focusEdge) && (
          <GraphDrawer
            focusNode={
              selectedNode
                ? drawerNodesMap.get(selectedId)
                : focusNode
                  ? drawerNodesMap.get(focusId)
                  : undefined
            }
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
