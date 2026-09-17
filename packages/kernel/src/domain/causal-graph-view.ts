import { parseEntityRef } from "./entity-ref.ts";

/**
 * Read-only causal tree view over one root entity ref. The daemon gathers the
 * edge set (one indexed relation neighborhood read), the task parent/child
 * structure, and per-node labels; this module only walks and annotates. It is
 * deliberately transport-free so any real caller can render the same model.
 *
 * Direction semantics: every rendered edge keeps its original sourceRef /
 * targetRef / direction. `traversal` only says which way the *tree* walked the
 * edge — it never rewrites the relation's own direction. Task parent/child
 * links are structural edges ("child"), never relabeled as derives.
 */

export interface CausalGraphEdgeInput {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly direction: string;
  readonly state: string;
  readonly freshness: string;
}

/** Display-side hydration for one ref; absent fields render as unknown. */
export interface CausalGraphNodeInfo {
  readonly label: string | null;
  readonly state: string | null;
  readonly detail: string | null;
}

export interface CausalGraphViaEdge {
  readonly relationId: string | null;
  readonly relationType: string;
  readonly direction: string | null;
  readonly sourceRef: string | null;
  readonly targetRef: string | null;
  readonly state: string | null;
  readonly freshness: string | null;
  readonly traversal: "downstream" | "upstream" | "structural";
}

export interface CausalGraphViewNode {
  readonly ref: string;
  readonly kind: string;
  readonly id: string;
  readonly label: string | null;
  readonly state: string | null;
  readonly detail: string | null;
  readonly depth: number;
  readonly viaEdge: CausalGraphViaEdge | null;
  /** Ref already occurs on the path from the root — the graph is not a DAG. */
  readonly cycle: boolean;
  /** Ref was already expanded at an earlier occurrence in this view. */
  readonly repeated: boolean;
  /** Unexpanded edges/children exist beyond this node (depth or budget bound). */
  readonly truncated: boolean;
  readonly children: readonly CausalGraphViewNode[];
}

export interface CausalGraphBuildInput {
  readonly rootRef: string;
  readonly depth: number;
  readonly edges: readonly CausalGraphEdgeInput[];
  /** Structural containment edges pointing down: task -> child tasks, decision -> anchors. */
  readonly structuralChildren: Readonly<Record<string, readonly { readonly ref: string; readonly type: string }[]>>;
  /** Structural containment edges pointing up: child task -> parent task, anchor -> decision. */
  readonly structuralParents: Readonly<Record<string, { readonly ref: string; readonly type: string }>>;
  readonly nodes: Readonly<Record<string, CausalGraphNodeInfo>>;
  /** True when the serving projection reported edges beyond the returned window. */
  readonly frontierTruncated: boolean;
  readonly maxOccurrences?: number;
}

export interface CausalGraphView {
  readonly schema: "causal-graph/v1";
  readonly root: CausalGraphViewNode;
  readonly stats: {
    readonly nodes: number;
    readonly edges: number;
    readonly cycles: number;
    readonly repeats: number;
    readonly truncated: number;
  };
}

const DEFAULT_MAX_OCCURRENCES = 2_000;

interface AdjacentChild {
  readonly ref: string;
  readonly viaEdge: CausalGraphViaEdge;
}

function nodeIdentity(ref: string): { readonly kind: string; readonly id: string } {
  const parsed = parseEntityRef(ref);
  if (parsed === null) return { kind: "entity", id: ref };
  return { kind: parsed.kind, id: parsed.anchor === undefined ? parsed.id : `${parsed.id}/${parsed.anchor}` };
}

function adjacency(edges: readonly CausalGraphEdgeInput[]): Map<string, readonly CausalGraphEdgeInput[]> {
  const byNode = new Map<string, CausalGraphEdgeInput[]>();
  for (const edge of edges) {
    for (const ref of [edge.sourceRef, edge.targetRef]) {
      const list = byNode.get(ref) ?? [];
      if (!byNode.has(ref)) byNode.set(ref, list);
      list.push(edge);
    }
  }
  return byNode;
}

function childrenOf(
  ref: string,
  byNode: ReadonlyMap<string, readonly CausalGraphEdgeInput[]>,
  structuralChildren: CausalGraphBuildInput["structuralChildren"],
  structuralParents: CausalGraphBuildInput["structuralParents"],
): readonly AdjacentChild[] {
  const relationChildren = (byNode.get(ref) ?? []).flatMap((edge): readonly AdjacentChild[] => {
    const other = edge.sourceRef === ref ? edge.targetRef : edge.sourceRef;
    return [
      {
        ref: other,
        viaEdge: {
          relationId: edge.relationId,
          relationType: edge.relationType,
          direction: edge.direction,
          sourceRef: edge.sourceRef,
          targetRef: edge.targetRef,
          state: edge.state,
          freshness: edge.freshness,
          traversal: edge.sourceRef === ref ? "downstream" : "upstream",
        },
      },
    ];
  });
  relationChildren.sort(
    (a, b) => a.viaEdge.relationType.localeCompare(b.viaEdge.relationType) || a.ref.localeCompare(b.ref),
  );
  const structural: AdjacentChild[] = (structuralChildren[ref] ?? []).map((child) => ({
    ref: child.ref,
    viaEdge: {
      relationId: null,
      relationType: child.type,
      direction: "directed",
      sourceRef: ref,
      targetRef: child.ref,
      state: null,
      freshness: null,
      traversal: "structural",
    },
  }));
  const parent = structuralParents[ref];
  if (parent !== undefined)
    structural.push({
      ref: parent.ref,
      viaEdge: {
        relationId: null,
        relationType: parent.type,
        direction: "directed",
        sourceRef: parent.ref,
        targetRef: ref,
        state: null,
        freshness: null,
        traversal: "upstream",
      },
    });
  return [...relationChildren, ...structural];
}

function makeNode(
  ref: string,
  depth: number,
  viaEdge: CausalGraphViaEdge | null,
  nodes: Readonly<Record<string, CausalGraphNodeInfo>>,
  marks: { readonly cycle: boolean; readonly repeated: boolean; readonly truncated: boolean },
): CausalGraphViewNode {
  const identity = nodeIdentity(ref),
    info = nodes[ref];
  return {
    ref,
    kind: identity.kind,
    id: identity.id,
    label: info?.label ?? null,
    state: info?.state ?? null,
    detail: info?.detail ?? null,
    depth,
    viaEdge,
    cycle: marks.cycle,
    repeated: marks.repeated,
    truncated: marks.truncated,
    children: [],
  };
}

export function buildCausalGraphView(input: CausalGraphBuildInput): CausalGraphView {
  const byNode = adjacency(input.edges),
    maxOccurrences = input.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES,
    expanded = new Set<string>(),
    stats = { nodes: 0, cycles: 0, repeats: 0, truncated: 0 };
  const budgetExhausted = () => stats.nodes >= maxOccurrences;
  const expand = (node: CausalGraphViewNode, path: ReadonlySet<string>): void => {
    expanded.add(node.ref);
    const adjacent = childrenOf(node.ref, byNode, input.structuralChildren, input.structuralParents),
      atDepthLimit = node.depth >= input.depth,
      children: CausalGraphViewNode[] = [];
    if (!atDepthLimit)
      for (const child of adjacent) {
        if (budgetExhausted()) break;
        const cycle = path.has(child.ref),
          repeated = !cycle && expanded.has(child.ref),
          childNode = makeNode(child.ref, node.depth + 1, child.viaEdge, input.nodes, {
            cycle,
            repeated,
            truncated: false,
          });
        stats.nodes += 1;
        if (cycle) stats.cycles += 1;
        if (repeated) stats.repeats += 1;
        children.push(childNode);
        if (cycle || repeated) continue;
        expand(childNode, new Set([...path, child.ref]));
      }
    const hidden = adjacent.length - children.length;
    if (hidden > 0 || (atDepthLimit && input.frontierTruncated)) {
      (node as { truncated: boolean }).truncated = true;
      stats.truncated += 1;
    }
    (node as { children: readonly CausalGraphViewNode[] }).children = children;
  };
  const root = makeNode(input.rootRef, 0, null, input.nodes, {
    cycle: false,
    repeated: false,
    truncated: false,
  });
  stats.nodes = 1;
  expand(root, new Set([input.rootRef]));
  return {
    schema: "causal-graph/v1",
    root,
    stats: {
      nodes: stats.nodes,
      edges: input.edges.length,
      cycles: stats.cycles,
      repeats: stats.repeats,
      truncated: stats.truncated,
    },
  };
}
