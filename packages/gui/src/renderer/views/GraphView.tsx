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
  const [focusId, setFocusId] = useState<string | null>(null);
  const [resolvedFocusId, setResolvedFocusId] = useState<string | null>(null);
  const [expandedFacts, setExpandedFacts] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (focusRef) setFocusId(endpointToNodeId(focusRef));
  }, [focusRef]);

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

  const onNodeClick = useCallback(
    (_: any, node: any) => {
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
      // 点击 decisionFocus 上的 claim 行(带 data.claimRow)→ toggle 展开该 claim 的 evidence facts
      if (node.type === "decisionFocus" && node.data?.claimRows) {
        const claimRows: Array<{ claimId: string; evidenceCount: number }> = node.data.claimRows;
        const decisionId: string = node.data.decisionId;
        const factsToToggle = claimRows
          .filter((r) => r.evidenceCount > 0)
          .flatMap((r) => {
            // 展开 coverageRows 给的 coveringFactRef(从 coverageRows 找)
            const refs = (coverageRows ?? [])
              .filter((c) => c.claimRef === `decision/${decisionId}/${r.claimId}` && c.coveringFactRef)
              .map((c) => c.coveringFactRef as string);
            return refs;
          });
        if (factsToToggle.length > 0) {
          setExpandedFacts((prev) => {
            const next = new Set(prev);
            const allOpen = factsToToggle.every((f) => next.has(f));
            if (allOpen) factsToToggle.forEach((f) => next.delete(f));
            else factsToToggle.forEach((f) => next.add(f));
            return next;
          });
          return;
        }
      }
      setFocusId((prev) => (prev === node.id ? null : node.id));
    },
    [coverageRows],
  );

  const onEdgeClick = useCallback((_: any, edge: any) => {
    setFocusId((prev) => (prev === edge.id ? null : edge.id));
  }, []);

  const onPaneClick = useCallback(() => {
    setFocusId(null);
  }, []);

  // Drawer
  const focusNode =
    focusId && !focusId.startsWith("e_") ? nodes.find((n) => n.id === focusId) : null;
  const focusEdge =
    focusId && focusId.startsWith("e_") ? edges.find((e) => e.id === focusId) : null;

  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => {
      if (n.type === "moduleGroup" || n.type === "laneBackground") return;
      map.set(n.id, {
        id: n.id,
        entity: n.type === "decisionFocus" ? "decision" : n.type,
        label: n.data.label,
        sub: n.data.sub,
        task: n.type === "task" ? n.data : undefined,
        raw: n.data,
      });
    });
    return map;
  }, [nodes]);

  // Node/edge count for header (exclude lane backgrounds)
  const visibleNodeCount = useMemo(
    () => nodes.filter((n) => n.type !== "moduleGroup" && n.type !== "laneBackground").length,
    [nodes],
  );

  // 上游 / 下游 1-hop 邻居计数 (供 GraphDrawer「链路」展示)。
  const { upCount, downCount } = useMemo(() => {
    if (!focusId) return { upCount: 0, downCount: 0 };
    let up = 0;
    let down = 0;
    for (const e of relations) {
      const from = endpointToNodeId(e.from);
      const to = endpointToNodeId(e.to);
      if (from === focusId) down += 1;
      if (to === focusId) up += 1;
    }
    return { upCount: up, downCount: down };
  }, [focusId, relations]);

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
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-text-muted">
        <span className="font-mono text-text-faint">
          {visibleNodeCount} 节点 · {edges.length} 边
          {resolvedFocusId ? ` · 聚焦 ${resolvedFocusId}` : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm border"
            style={{
              borderColor: "var(--color-axis-execution)",
              background: "var(--color-surface-raised)",
            }}
          />
          task（方块·派生）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded border" style={{ borderColor: "var(--color-accent)", background: "rgba(176,124,240,0.2)" }} />
          decision（菱形·主张+claim）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border" style={{ borderColor: "var(--color-axis-evidence)", background: "rgba(240,162,60,0.2)" }} />
          fact（圆·证据徽章）
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-text-faint">coverage:</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--color-status-done)" }} /> 已佐证
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--color-danger)" }} /> 无证据
          </span>
        </span>
        {cycleWarning.count > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger"
            title={cycleWarning.cycles.map((c) => c.join(" → ")).join("\n")}
          >
            INV-3 环警告 · {cycleWarning.count}
          </span>
        )}
        <span className="ml-auto text-text-faint">
          {focusId
            ? "Esc / 点击空白处退出聚焦 · 点击 claim 行展开证据 fact"
            : "默认聚焦式 ego · 点击节点切换焦点 (Powered by React Flow)"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
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

        {(focusNode || focusEdge) && (
          <GraphDrawer
            focusNode={focusNode ? drawerNodesMap.get(focusId) : undefined}
            focusEdge={focusEdge ? focusEdge.data : undefined}
            nodes={drawerNodesMap}
            edges={relations}
            upCount={upCount}
            downCount={downCount}
            onClose={() => setFocusId(null)}
            onFocus={setFocusId}
            onNavigateEntity={onNavigateEntity}
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
