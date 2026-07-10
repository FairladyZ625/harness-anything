import { useEffect, useMemo, useState, useCallback } from "react";
import { ReactFlow, MiniMap, Controls, Background, BackgroundVariant, ReactFlowProvider, Panel, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { collectClosure, endpointToNodeId } from "../graph/endpoint";
import { GraphDrawer } from "../graph/GraphDrawer";
import { computeGraphLayout } from "../graph/graphLayout";

import { TaskNode } from "../graph/nodes/TaskNode";
import { DecisionNode } from "../graph/nodes/DecisionNode";
import { FactNode } from "../graph/nodes/FactNode";
import { ModuleGroupNode } from "../graph/nodes/ModuleGroupNode";
import { InteractiveEdge } from "../graph/edges/InteractiveEdge";
import { GraphFilterPanel, type GraphFilters } from "../components/GraphFilterPanel";

const nodeTypes = {
  task: TaskNode,
  decision: DecisionNode,
  fact: FactNode,
  moduleGroup: ModuleGroupNode,
};

const edgeTypes = {
  interactive: InteractiveEdge,
};

function GraphViewInner({
  tasks,
  relations,
  decisions,
  facts,
  onNavigateEntity,
}: {
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions?: DecisionRow[];
  facts?: FactRef[];
  /** W2B 活链接:图→列表/详情侧互通 */
  onNavigateEntity?: (ref: string) => void;
}) {
  const { fitView } = useReactFlow();
  const [focusId, setFocusId] = useState<string | null>(null);
  
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [cycleWarning, setCycleWarning] = useState<{ count: number; cycles: string[][] }>({ count: 0, cycles: [] });
  const [error, setError] = useState<string | null>(null);

  const availableModules = useMemo(() => {
    const mods = new Set(tasks.map(t => t.module));
    return Array.from(mods).sort();
  }, [tasks]);

  const [filters, setFilters] = useState<GraphFilters>(() => ({
    modules: new Set(tasks.map(t => t.module)),
    types: new Set(['decision', 'task', 'fact'])
  }));

  useEffect(() => {
    setFilters((current) => {
      const nextModules = new Set(availableModules);
      if (current.modules.size === nextModules.size && [...current.modules].every((module) => nextModules.has(module))) return current;
      return { ...current, modules: nextModules };
    });
  }, [availableModules]);

  // Calculate closures for focus
  const chain = useMemo(() => {
    if (!focusId) return null;
    const up = collectClosure(relations, focusId, "out");
    const down = collectClosure(relations, focusId, "in");
    const nodeSet = new Set([...up, ...down]);
    const edgeSet = new Set(
      relations
        .filter((e) => {
          const from = endpointToNodeId(e.from);
          const to = endpointToNodeId(e.to);
          return (up.has(from) && up.has(to)) || (down.has(from) && down.has(to));
        })
        .map((e) => `${e.from}|${e.to}`),
    );
    return { nodeSet, edgeSet, upCount: up.size - 1, downCount: down.size - 1 };
  }, [focusId, relations]);

  const loopData = useMemo(() => {
    const loopNodes = new Set<string>();
    const loopEdges = new Set<string>();
    if (!focusId || focusId.startsWith('e_')) return { loopNodes, loopEdges };
    
    const rootId = focusId;
    
    // Dynamically find the Decision-Task-Fact triplet
    const validKinds = new Set(["derives", "supports", "evidenced-by", "produces", "evidences"]);
    
    // A simple 2-hop undirected traversal restricted to triplet edges
    const queue = [rootId];
    loopNodes.add(rootId.replace('task/', ''));
    
    // Limit to 2 hops to capture the whole triplet (e.g. Fact -> Task -> Decision)
    for (let hop = 0; hop < 2; hop++) {
      const currentHop = Array.from(queue);
      queue.length = 0;
      
      for (const node of currentHop) {
        for (const e of relations) {
          if (validKinds.has(e.kind)) {
            const from = endpointToNodeId(e.from);
            const to = endpointToNodeId(e.to);
            if (from === node && !loopNodes.has(to)) {
              loopNodes.add(to);
              loopEdges.add(`${e.from}|${e.to}`);
              queue.push(to);
            }
            if (to === node && !loopNodes.has(from)) {
              loopNodes.add(from);
              loopEdges.add(`${e.from}|${e.to}`);
              queue.push(from);
            }
            // If both ends are in the loop, make sure the edge is highlighted too
            if (loopNodes.has(from) && loopNodes.has(to)) {
              loopEdges.add(`${e.from}|${e.to}`);
            }
          }
        }
      }
    }
    
    // Only return loop data if we found a triplet (more than 1 node)
    if (loopNodes.size <= 1) {
      loopNodes.clear();
      loopEdges.clear();
    }
    
    return { loopNodes, loopEdges };
  }, [focusId, relations]);

  useEffect(() => {
    const focusNodes = chain ? chain.nodeSet : new Set<string>();
    computeGraphLayout(tasks, relations, decisions ?? [], facts ?? [], focusNodes, loopData.loopNodes, loopData.loopEdges, filters)
      .then(({ nodes: rfNodes, edges: rfEdges, cycleWarning: warning }) => {
        setError(null);
        setNodes(rfNodes);
        setEdges(rfEdges);
        setCycleWarning(warning);
      })
      .catch(err => {
        console.error("Failed to compute graph layout", err);
        setError(err instanceof Error ? err.stack || err.message : String(err));
      });
  }, [tasks, relations, decisions, facts, chain, loopData, filters]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: 120 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [edges.length, fitView, nodes.length]);

  const onNodeClick = useCallback((_: any, node: any) => {
    if (node.type === 'moduleGroup') return;
    setFocusId(prev => prev === node.id ? null : node.id);
  }, []);

  const onEdgeClick = useCallback((_: any, edge: any) => {
    setFocusId(prev => prev === edge.id ? null : edge.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setFocusId(null);
  }, []);

  // For Drawer
  const focusNode = focusId && !focusId.startsWith('e_') ? nodes.find(n => n.id === focusId) : null;
  const focusEdge = focusId && focusId.startsWith('e_') ? edges.find(e => e.id === focusId) : null;

  // Index rendered entities for drawer navigation.
  const drawerNodesMap = useMemo(() => {
    const map = new Map();
    nodes.forEach(n => {
      if (n.type !== 'moduleGroup') {
        map.set(n.id, { 
          id: n.id, 
          entity: n.type, 
          label: n.data.label, 
          sub: n.data.sub, 
          task: n.type === 'task' ? n.data : undefined,
          raw: n.data 
        });
      }
    });
    return map;
  }, [nodes]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-red-50 p-8">
        <div className="text-red-700 whitespace-pre-wrap font-mono text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (tasks.length === 0 && (decisions?.length ?? 0) === 0 && (facts?.length ?? 0) === 0) {
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
          {nodes.filter(n=>n.type !== 'moduleGroup').length} 节点 · {edges.length} 边
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-border-strong bg-surface-raised" />
          task（方块）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rotate-45 border border-accent bg-accent-fg" />
          decision（脊梁·菱形）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-stale bg-surface-raised" />
          fact（底料·圆）
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="22" height="6">
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-accent)" strokeWidth="2" />
          </svg>
          supports（覆盖度边）
        </span>
        {cycleWarning.count > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger"
            title={cycleWarning.cycles.map((cycle) => cycle.join(" → ")).join("\n")}
          >
            INV-3 环警告 · {cycleWarning.count}
          </span>
        )}
        <span className="ml-auto text-text-faint">
          {focusId ? "Esc / 点击空白处退出聚焦" : "点击节点聚焦其完整链路 (Powered by React Flow + dagre)"}
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
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-border)" />
          <Controls className="bg-surface-raised border-border" />
          <MiniMap 
            nodeColor={(n) => {
              if (n.type === 'moduleGroup') return 'rgba(255, 255, 255, 0.05)';
              if (n.type === 'decision') return 'var(--color-accent)';
              if (n.type === 'fact') return 'var(--color-stale)';
              return 'var(--color-border-strong)';
            }}
            maskColor="rgba(0, 0, 0, 0.5)"
            className="bg-surface border border-border rounded overflow-hidden"
          />
          <Panel position="top-left">
            <GraphFilterPanel filters={filters} setFilters={setFilters} availableModules={availableModules} />
          </Panel>
        </ReactFlow>

        {(focusNode || focusEdge) && chain && (
          <GraphDrawer
            focusNode={focusNode ? drawerNodesMap.get(focusId)! : undefined}
            focusEdge={focusEdge ? focusEdge.data : undefined}
            nodes={drawerNodesMap}
            edges={relations}
            upCount={chain.upCount}
            downCount={chain.downCount}
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
