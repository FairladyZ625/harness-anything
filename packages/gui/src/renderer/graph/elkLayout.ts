import ELK from 'elkjs/lib/elk.bundled.js';
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { parseEndpoint } from "./endpoint";
import { STATUS_META } from "../components/badges";
import { NODE_W, NODE_H } from "./constants";
import type { Node, Edge } from '@xyflow/react';
import { MarkerType as RFMarkerType } from '@xyflow/react';

const elk = new ELK();

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
  const rel = relations.find(r => {
    const cleanFrom = r.from.split("/").slice(0, 2).join("/");
    return cleanFrom === decId && r.kind === "derives";
  });
  if (rel) {
    const taskId = rel.to.startsWith("task/") ? rel.to.slice(5).split("/")[0] : rel.to;
    const t = tasks.find(x => x.taskId === taskId);
    return t?.module ?? "kernel";
  }
  return "kernel";
}

function getFactModule(factId: string, tasks: TaskRow[]) {
  const taskId = factId.split("/")[1];
  const t = tasks.find(x => x.taskId === taskId);
  return t?.module ?? "kernel";
}

export async function computeElkLayout(
  tasks: TaskRow[],
  relations: RelationEdge[],
  decisions: DecisionRow[],
  facts: FactRef[],
  focusNodes: Set<string>,
  inLoopNodes: Set<string>,
  inLoopEdges: Set<string>,
  filters?: { modules: Set<string>; types: Set<string> }
): Promise<{ nodes: Node[]; edges: Edge[]; cycleWarning: { count: number; cycles: string[][] } }> {
  
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const validEdges = relations.filter((e) => {
    return parseEndpoint(e.from, taskIds) && parseEndpoint(e.to, taskIds);
  });

  const modules = new Set(["kernel", "store", "cli", "gui", "adapters", "ci", "unknown"]);
  tasks.forEach(t => modules.add(t.module));

  // Build root ELK graph
  const elkGraph: any = {
    id: "root",
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT', // Place modules horizontally
      'elk.spacing.nodeNode': '60',
    },
    children: [],
    edges: []
  };

  const moduleMap = new Map<string, any>();
  for (const m of modules) {
    const modNode = {
      id: `module_${m}`,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN', // Inside module, flow downwards
        'elk.padding': '[top=50,left=20,bottom=20,right=20]',
        'elk.spacing.nodeNode': '20',
        'elk.layered.spacing.nodeNodeBetweenLayers': '40'
      },
      children: [],
    };
    elkGraph.children.push(modNode);
    moduleMap.set(m, modNode);
  }

  // Populate tasks
  for (const t of tasks) {
    if (filters && !filters.types.has('task')) continue;
    if (filters && !filters.modules.has(t.module)) continue;
    
    const mod = moduleMap.get(t.module) ?? moduleMap.get("unknown");
    mod.children.push({
      id: t.taskId,
      width: NODE_W,
      height: NODE_H,
      elkData: { entity: "task", data: t }
    });
  }

  // Populate decisions
  for (const d of decisions) {
    if (filters && !filters.types.has('decision')) continue;
    
    const id = `decision/${d.decisionId}`;
    const moduleName = getDecisionModule(id, validEdges, tasks);
    if (filters && !filters.modules.has(moduleName) && moduleName !== "unknown") continue;
    
    const mod = moduleMap.get(moduleName) ?? moduleMap.get("unknown");
    mod.children.push({
      id,
      width: 140,
      height: 52,
      elkData: { entity: "decision", data: d }
    });
  }

  // Populate facts
  for (const f of facts) {
    if (filters && !filters.types.has('fact')) continue;
    
    const anchor = f.anchor.split("/").pop() ?? f.anchor;
    const id = `fact/${f.taskId}/${anchor}`;
    const moduleName = getFactModule(id, tasks);
    if (filters && !filters.modules.has(moduleName) && moduleName !== "unknown") continue;
    
    const mod = moduleMap.get(moduleName) ?? moduleMap.get("unknown");
    mod.children.push({
      id,
      width: 140,
      height: 40,
      elkData: { entity: "fact", data: f }
    });
  }

  // Strip empty modules
  elkGraph.children = elkGraph.children.filter((c: any) => c.children.length > 0);

  // Collect all valid node IDs
  const allNodeIds = new Set<string>();
  for (const mod of elkGraph.children) {
    for (const n of mod.children) {
      allNodeIds.add(n.id);
    }
  }

  // Populate edges
  const normalizedEdges: { from: string; to: string; raw: RelationEdge }[] = [];

  validEdges.forEach((e, i) => {
    let from = parseEndpoint(e.from, taskIds)!.id;
    let to = parseEndpoint(e.to, taskIds)!.id;
    
    // claim anchors are mapped to base decision
    if (e.from.startsWith("decision/")) from = e.from.split("/").slice(0,2).join("/");
    if (e.to.startsWith("decision/")) to = e.to.split("/").slice(0,2).join("/");

    if (!allNodeIds.has(from) || !allNodeIds.has(to)) {
      return;
    }

    normalizedEdges.push({ from, to, raw: e });

    elkGraph.edges.push({
      id: `e_${i}`,
      source: from,
      target: to,
      elkData: { edge: e }
    });
  });

  const cycleWarning = findRelationCycles(normalizedEdges);

  // Run layout
  let layouted;
  try {
    layouted = await elk.layout(elkGraph);
  } catch (err) {
    console.error("ELK Layout Error:", err);
    throw err;
  }

  // Map to React Flow Nodes & Edges
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  for (const mod of layouted.children || []) {
    // Background module node
    const moduleName = mod.id.replace("module_", "");
    rfNodes.push({
      id: mod.id,
      type: 'moduleGroup',
      position: { x: mod.x, y: mod.y },
      style: { width: mod.width, height: mod.height },
      data: { label: moduleName },
      zIndex: -1,
    });

    for (const n of mod.children || []) {
      const isLoop = inLoopNodes.has(n.id);
      const cycleHit = cycleWarning.nodes.has(n.id);
      const isDimmed = focusNodes.size > 0 && !focusNodes.has(n.id);

      rfNodes.push({
        id: n.id,
        type: n.elkData.entity,
        position: { x: mod.x + n.x, y: mod.y + n.y },
        data: {
          ...n.elkData.data,
          loop: isLoop,
          dimmed: isDimmed,
          color: n.elkData.entity === "task" ? STATUS_META[n.elkData.data.coordinationStatus as keyof typeof STATUS_META].color : undefined,
          label: n.elkData.data.title || n.elkData.data.text,
          sub: n.elkData.data.state || n.elkData.data.category,
          cycleWarning: cycleHit,
        },
        parentId: mod.id, // React Flow supports parenting but it requires relative coords.
        // Wait, if we use parentId, position must be relative to parent.
        // Since we computed absolute coords above `mod.x + n.x`, let's NOT use parentId, just absolute flat coords.
      });
      // Fix: revert relative coords if we remove parentId. Or keep parentId and use relative coords.
      // Let's use relative coords with parentId for proper interactive grouping.
      const lastNode = rfNodes[rfNodes.length - 1];
      lastNode.parentId = mod.id;
      lastNode.position = { x: n.x, y: n.y };
      lastNode.extent = 'parent';
    }
  }

  for (const e of layouted.edges || []) {
    const rawEdge = e.elkData.edge;
    const isLoop = inLoopEdges.has(`${rawEdge.from}|${rawEdge.to}`);
    // Check if edge is focused (both ends in focusNodes)
    let fromId = parseEndpoint(rawEdge.from, taskIds)!.id;
    let toId = parseEndpoint(rawEdge.to, taskIds)!.id;
    if (rawEdge.from.startsWith("decision/")) fromId = rawEdge.from.split("/").slice(0,2).join("/");
    if (rawEdge.to.startsWith("decision/")) toId = rawEdge.to.split("/").slice(0,2).join("/");

    const lit = focusNodes.size > 0 && focusNodes.has(fromId) && focusNodes.has(toId);
    const cycleHit = cycleWarning.edges.has(`${fromId}|${toId}`);
    const dimmed = focusNodes.size > 0 && !lit;

    const color = cycleHit ? "var(--color-danger)" : isLoop ? '#f97316' : rawEdge.kind === "supports" ? "var(--color-accent)" : rawEdge.provenance === "external-engine" ? "var(--color-stale)" : lit ? "var(--color-accent)" : "var(--color-border-strong)";

    rfEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'interactive',
      data: { ...rawEdge, cycleWarning: cycleHit },
      animated: lit || cycleHit,
      style: {
        stroke: color,
        strokeWidth: cycleHit ? 3 : isLoop ? 3 : lit ? 2.5 : 1.5,
        opacity: dimmed ? 0.12 : 1,
        strokeDasharray: cycleHit ? "5 3" : rawEdge.kind === "references" ? "4 3" : rawEdge.kind === "invalidated_by" || rawEdge.kind === "supersedes_fact" ? "3 2" : undefined,
      },
      markerEnd: {
        type: RFMarkerType.ArrowClosed,
        color: color,
      }
    });
  }

  return { nodes: rfNodes, edges: rfEdges, cycleWarning: { count: cycleWarning.cycles.length, cycles: cycleWarning.cycles } };
}
