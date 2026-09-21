import { useEffect, useMemo, useState } from "react";
import {
  useNodesInitialized,
  useReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from "@xyflow/react";
import { useColorMode } from "../graph/colorMode.ts";
import dagre from "@dagrejs/dagre";
import type { RelationEdge } from "../model/types.ts";
import { normalizedRef, workspaceGraphSlice } from "../model/workspace-evidence.ts";
import { relationKindLabel, workspaceNodeLabel, workspaceNodeText } from "../model/workspace-readable.ts";
import { t } from "../i18n/index.tsx";

export function workspaceFlowLayout(
  memberTaskIds: readonly string[],
  relations: readonly RelationEdge[],
  titles: ReadonlyMap<string, string>,
  expanded: ReadonlySet<string>,
) {
  const slice = workspaceGraphSlice(memberTaskIds, relations, expanded);
  const layout = new dagre.graphlib.Graph()
    .setGraph({ rankdir: "LR", nodesep: 30, ranksep: 110 })
    .setDefaultEdgeLabel(() => ({}));
  for (const ref of slice.nodeRefs) layout.setNode(ref, { width: 240, height: 90 });
  for (const edge of slice.edges) layout.setEdge(normalizedRef(edge.from), normalizedRef(edge.to));
  dagre.layout(layout);
  // Pack disconnected canonical components instead of fitting one unreadably tall column.
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const component of dagre.graphlib.alg.components(layout)) {
    const left = Math.min(...component.map((id) => layout.node(id).x - 120));
    const top = Math.min(...component.map((id) => layout.node(id).y - 45));
    const width = Math.max(...component.map((id) => layout.node(id).x + 120)) - left;
    const height = Math.max(...component.map((id) => layout.node(id).y + 45)) - top;
    if (x > 0 && x + width > 1800) {
      x = 0;
      y += rowHeight + 60;
      rowHeight = 0;
    }
    for (const id of component) {
      layout.node(id).x += x - left;
      layout.node(id).y += y - top;
    }
    x += width + 60;
    rowHeight = Math.max(rowHeight, height);
  }
  const external = new Set(slice.externalRefs);
  const nodes: Node[] = slice.nodeRefs.map((ref) => ({
    id: ref,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: layout.node(ref).x - 120, y: layout.node(ref).y - 45 },
    data: {
      label: `${workspaceNodeLabel(ref, titles).kindLabel} · ${workspaceNodeText(workspaceNodeLabel(ref, titles))}${external.has(ref) ? " · 外部（点击展开）" : ""}`,
    },
    style: {
      width: 240,
      height: 90,
      fontSize: 12,
      overflow: "hidden",
      background: "var(--color-surface-raised)",
      color: "var(--color-text)",
      borderColor: external.has(ref) ? "var(--color-warning)" : "var(--color-border)",
      overflowWrap: "anywhere",
    },
  }));
  const edges: Edge[] = slice.edges.map((edge) => ({
    id: edge.relationId ?? `${edge.from}:${edge.kind}:${edge.to}`,
    source: normalizedRef(edge.from),
    target: normalizedRef(edge.to),
    label: relationKindLabel(edge.kind),
    markerEnd: { type: MarkerType.ArrowClosed },
    labelStyle: { fill: "var(--color-text)", fontSize: 12 },
    labelBgStyle: { fill: "var(--color-surface-raised)" },
  }));
  return { nodes, edges, external };
}

export function WorkspaceLocalGraph({
  memberTaskIds,
  relations,
  titles,
  onNavigateEntity,
}: {
  readonly memberTaskIds: readonly string[];
  readonly relations: readonly RelationEdge[];
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const colorMode = useColorMode();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const graph = useMemo(
    () => workspaceFlowLayout(memberTaskIds, relations, titles, expanded),
    [memberTaskIds, relations, titles, expanded],
  );
  return (
    <section className="space-y-3" aria-labelledby="workspace-graph">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="workspace-graph" className="text-sm font-semibold text-text">
          {t("views.workspace.localGraph")}
        </h2>
        <button type="button" className="text-sm text-accent" onClick={() => setExpanded(new Set())}>
          收起外部展开
        </button>
      </div>
      <p className="text-sm text-text-muted">
        {t("views.workspace.localGraphNote")} · {graph.nodes.length} 节点 / {graph.edges.length}{" "}
        关系。双击节点打开详情。
      </p>
      <div
        data-testid="workspace-graph-canvas"
        className="h-[calc(100vh-380px)] min-h-[600px] overflow-hidden rounded-lg border border-border"
      >
        <ReactFlowProvider>
          <ReactFlow
            colorMode={colorMode}
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            minZoom={0.05}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_, node) =>
              graph.external.has(node.id) && setExpanded((current) => new Set([...current, node.id]))
            }
            onNodeDoubleClick={(_, node) => onNavigateEntity?.(node.id)}
          >
            <FitWorkspaceGraph
              layoutKey={graph.nodes.map((node) => `${node.id}:${node.position.x}:${node.position.y}`).join("|")}
            />
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </section>
  );
}

function FitWorkspaceGraph({ layoutKey }: { readonly layoutKey: string }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.08, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, layoutKey, fitView]);
  return null;
}
