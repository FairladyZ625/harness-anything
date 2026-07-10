import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { parseEndpoint } from "./endpoint";
import { STATUS_META } from "../components/badges";
import { NODE_W, NODE_H } from "./constants";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType } from "@xyflow/react";

// Graph layout runs on @dagrejs/dagre (MIT). dagre is a directed layered layout
// with compound-graph (cluster) support: modules are clusters, entities are their
// children, and dagre computes both node positions and each cluster's bounding box.
// Node/edge rendering (React Flow node types, colors, edge styles) is unchanged.

interface CycleWarning {
  nodes: Set<string>;
  edges: Set<string>;
  cycles: string[][];
}

function findRelationCycles(edges: { from: string; to: string }[]): CycleWarning {
  const bySource = new Map<string, string[]>();
  for (const edge of edges) {
    if (!bySource.has(edge.from)) bySource.set(edge.from, []);
    bySource.get(edge.from)!.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const cycles: string[][] = [];
  const cycleNodes = new Set<string>();
  const cycleEdges = new Set<string>();

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = cycle.join(">");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
        for (let i = 0; i < cycle.length - 1; i += 1) {
          cycleNodes.add(cycle[i]);
          cycleEdges.add(`${cycle[i]}|${cycle[i + 1]}`);
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    stack.push(node);
    for (const next of bySource.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of bySource.keys()) visit(node);
  return { nodes: cycleNodes, edges: cycleEdges, cycles };
}

// Shared module resolver
function getDecisionModule(decId: string, relations: RelationEdge[], tasks: TaskRow[]) {
  const rel = relations.find((r) => {
    const cleanFrom = r.from.split("/").slice(0, 2).join("/");
    return cleanFrom === decId && r.kind === "derives";
  });
  if (rel) {
    const taskId = rel.to.startsWith("task/") ? rel.to.slice(5).split("/")[0] : rel.to;
    const t = tasks.find((x) => x.taskId === taskId);
    return t?.module ?? "kernel";
  }
  return "kernel";
}

function getFactModule(factId: string, tasks: TaskRow[]) {
  const taskId = factId.split("/")[1];
  const t = tasks.find((x) => x.taskId === taskId);
  return t?.module ?? "kernel";
}

interface PlacedEntity {
  id: string;
  module: string;
  width: number;
  height: number;
  entity: "task" | "decision" | "fact";
  data: TaskRow | DecisionRow | FactRef;
}

export async function computeGraphLayout(
  tasks: TaskRow[],
  relations: RelationEdge[],
  decisions: DecisionRow[],
  facts: FactRef[],
  focusNodes: Set<string>,
  inLoopNodes: Set<string>,
  inLoopEdges: Set<string>,
  filters?: { modules: Set<string>; types: Set<string> }
): Promise<{ nodes: Node[]; edges: Edge[]; cycleWarning: { count: number; cycles: string[][] } }> {
  const validEdges = relations.filter((e) => parseEndpoint(e.from) && parseEndpoint(e.to));

  // Collect entities that survive the filter, tagged with their owning module.
  const placed: PlacedEntity[] = [];

  for (const t of tasks) {
    if (filters && !filters.types.has("task")) continue;
    if (filters && filters.modules.size > 0 && !filters.modules.has(t.module)) continue;
    placed.push({ id: t.taskId, module: t.module, width: NODE_W, height: NODE_H, entity: "task", data: t });
  }

  for (const d of decisions) {
    if (filters && !filters.types.has("decision")) continue;
    const id = `decision/${d.decisionId}`;
    const moduleName = getDecisionModule(id, validEdges, tasks);
    if (filters && filters.modules.size > 0 && !filters.modules.has(moduleName) && moduleName !== "unknown") continue;
    placed.push({ id, module: moduleName, width: 140, height: 52, entity: "decision", data: d });
  }

  for (const f of facts) {
    if (filters && !filters.types.has("fact")) continue;
    const anchor = f.anchor.split("/").pop() ?? f.anchor;
    const id = `fact/${f.taskId}/${anchor}`;
    const moduleName = getFactModule(id, tasks);
    if (filters && filters.modules.size > 0 && !filters.modules.has(moduleName) && moduleName !== "unknown") continue;
    placed.push({ id, module: moduleName, width: 140, height: 40, entity: "fact", data: f });
  }

  const knownModules = new Set(["kernel", "store", "cli", "gui", "adapters", "ci", "unknown"]);
  const resolveModule = (m: string) => (knownModules.has(m) ? m : "unknown");

  const allNodeIds = new Set(placed.map((p) => p.id));

  const g = new graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 48, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  // Create only the clusters that actually receive children (no empty module boxes).
  const usedModules = new Set<string>();
  for (const p of placed) usedModules.add(resolveModule(p.module));
  for (const m of usedModules) g.setNode(`module_${m}`, { label: m });

  for (const p of placed) {
    g.setNode(p.id, { width: p.width, height: p.height, entity: p.entity, data: p.data });
    g.setParent(p.id, `module_${resolveModule(p.module)}`);
  }

  // Populate edges (claim anchors collapse onto the base decision node).
  const normalizedEdges: { from: string; to: string; raw: RelationEdge }[] = [];
  validEdges.forEach((e, i) => {
    let from = parseEndpoint(e.from)!.id;
    let to = parseEndpoint(e.to)!.id;
    if (e.from.startsWith("decision/")) from = e.from.split("/").slice(0, 2).join("/");
    if (e.to.startsWith("decision/")) to = e.to.split("/").slice(0, 2).join("/");
    if (!allNodeIds.has(from) || !allNodeIds.has(to)) return;
    normalizedEdges.push({ from, to, raw: e });
    g.setEdge(from, to, { raw: e, edgeId: `e_${i}` }, `e_${i}`);
  });

  const cycleWarning = findRelationCycles(normalizedEdges);

  try {
    dagreLayout(g);
  } catch (err) {
    console.error("Dagre layout error:", err);
    throw err;
  }

  // dagre reports node centers; convert to top-left for React Flow.
  const topLeft = (id: string) => {
    const n = g.node(id) as { x: number; y: number; width: number; height: number };
    return { x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height };
  };

  const rfNodes: Node[] = [];

  // Module background nodes first so their children can parent onto them.
  for (const m of usedModules) {
    const box = topLeft(`module_${m}`);
    rfNodes.push({
      id: `module_${m}`,
      type: "moduleGroup",
      position: { x: box.x, y: box.y },
      style: { width: box.width, height: box.height },
      data: { label: m },
      zIndex: -1,
    });
  }

  for (const p of placed) {
    const parentId = `module_${resolveModule(p.module)}`;
    const box = topLeft(p.id);
    const parentBox = topLeft(parentId);
    const isLoop = inLoopNodes.has(p.id);
    const cycleHit = cycleWarning.nodes.has(p.id);
    const isDimmed = focusNodes.size > 0 && !focusNodes.has(p.id);
    const data = p.data as TaskRow & DecisionRow & FactRef;

    rfNodes.push({
      id: p.id,
      type: p.entity,
      parentId,
      extent: "parent",
      position: { x: box.x - parentBox.x, y: box.y - parentBox.y },
      data: {
        ...p.data,
        loop: isLoop,
        dimmed: isDimmed,
        color:
          p.entity === "task"
            ? STATUS_META[(p.data as TaskRow).coordinationStatus as keyof typeof STATUS_META].color
            : undefined,
        label: data.title || data.text,
        sub: data.state || data.category,
        cycleWarning: cycleHit,
      },
    });
  }

  const rfEdges: Edge[] = [];
  for (const e of g.edges()) {
    const label = g.edge(e) as unknown as { raw: RelationEdge; edgeId: string };
    const rawEdge = label.raw;
    const isLoop = inLoopEdges.has(`${rawEdge.from}|${rawEdge.to}`);

    let fromId = parseEndpoint(rawEdge.from)!.id;
    let toId = parseEndpoint(rawEdge.to)!.id;
    if (rawEdge.from.startsWith("decision/")) fromId = rawEdge.from.split("/").slice(0, 2).join("/");
    if (rawEdge.to.startsWith("decision/")) toId = rawEdge.to.split("/").slice(0, 2).join("/");

    const lit = focusNodes.size > 0 && focusNodes.has(fromId) && focusNodes.has(toId);
    const cycleHit = cycleWarning.edges.has(`${fromId}|${toId}`);
    const dimmed = focusNodes.size > 0 && !lit;

    const color = cycleHit
      ? "var(--color-danger)"
      : isLoop
        ? "#f97316"
        : rawEdge.kind === "supports" || rawEdge.kind === "evidenced-by" || rawEdge.kind === "evidences"
          ? "var(--color-accent)"
          : rawEdge.provenance === "external-engine"
            ? "var(--color-stale)"
            : lit
              ? "var(--color-accent)"
              : "var(--color-border-strong)";

    rfEdges.push({
      id: label.edgeId,
      source: e.v,
      target: e.w,
      type: "interactive",
      data: { ...rawEdge, cycleWarning: cycleHit },
      animated: lit || cycleHit,
      style: {
        stroke: color,
        strokeWidth: cycleHit ? 3 : isLoop ? 3 : lit ? 2.5 : 1.5,
        opacity: dimmed ? 0.12 : 1,
        strokeDasharray:
          cycleHit
            ? "5 3"
            : rawEdge.kind === "relates"
              ? "4 3"
              : rawEdge.kind === "invalidated-by" || rawEdge.kind === "supersedes-fact"
                ? "3 2"
                : undefined,
      },
      markerEnd: {
        type: RFMarkerType.ArrowClosed,
        color: color,
      },
    });
  }

  return { nodes: rfNodes, edges: rfEdges, cycleWarning: { count: cycleWarning.cycles.length, cycles: cycleWarning.cycles } };
}
