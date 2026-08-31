import type { DatabaseSync } from "node:sqlite";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";

export interface RelationGraphEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}
export interface RelationCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: "covered" | "uncovered";
  readonly fulfillment: "evidenced" | "delivered" | "standing-policy" | null;
  readonly coveringFactRef?: string;
  readonly refutingFactRefs?: readonly string[];
  readonly relationPath: readonly string[];
  readonly basisRevision?: number;
}
export interface FactAnchorRow {
  readonly factRef: string;
  readonly taskId?: string;
  readonly factId: string;
  readonly sourcePath: string;
}
export interface RelationFactRow {
  readonly schema: "task-fact-row/v1";
  readonly ref: string;
  readonly taskId?: string;
  readonly factId: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: "low" | "medium" | "high";
  readonly memoryClass: "semantic" | "episodic" | "procedural";
  readonly memoryTags: readonly string[];
  readonly provenance: readonly { readonly runtime: string; readonly sessionId: string; readonly boundAt: string }[];
  readonly liveness: "standing" | "superseded_fact";
}
export interface DecisionAnchorTruth {
  readonly decisionRef: string;
  readonly decisionId: string;
  readonly anchorRefs: readonly string[];
  readonly sourcePath: string;
}
export interface EventBackedRelationTruth {
  readonly factAnchors: readonly FactAnchorRow[];
  readonly decisionAnchors: readonly DecisionAnchorTruth[];
  readonly edges: readonly RelationGraphEdgeRow[];
  readonly coverageRows: readonly RelationCoverageRow[];
}
export interface RelationGraphProjection {
  readonly edges: readonly RelationGraphEdgeRow[];
  readonly coverageRows: readonly RelationCoverageRow[];
  readonly factAnchors: readonly FactAnchorRow[];
}
export function createRelationGraphProjectionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relation_edge (relation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL,
      state TEXT NOT NULL, owner_ref TEXT NOT NULL, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relation_edge_source ON relation_edge(source_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_target ON relation_edge(target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_type_target ON relation_edge(relation_type, target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_state_page ON relation_edge(state, relation_id);
  `);
}

const emptyTruth: EventBackedRelationTruth = { factAnchors: [], decisionAnchors: [], edges: [], coverageRows: [] };
export function buildRelationGraphProjection(
  _rootInput: HarnessLayoutInput,
  truth: EventBackedRelationTruth = emptyTruth,
): RelationGraphProjection {
  return {
    edges: [...truth.edges].sort((a, b) => a.relationId.localeCompare(b.relationId)),
    coverageRows: truth.coverageRows,
    factAnchors: [...truth.factAnchors].sort((a, b) => a.factRef.localeCompare(b.factRef)),
  };
}
export function detectRelationGraphCycles(edges: readonly RelationGraphEdgeRow[]): readonly (readonly string[])[] {
  const graph = new Map<string, string[]>();
  for (const edge of edges)
    if (edge.state === "active") {
      graph.set(edge.sourceRef, [...(graph.get(edge.sourceRef) ?? []), edge.targetRef]);
      if (!graph.has(edge.targetRef)) graph.set(edge.targetRef, []);
    }
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    stack: string[] = [],
    cycles: string[][] = [];
  const visit = (ref: string): void => {
    if (visiting.has(ref)) {
      cycles.push(stack.slice(stack.indexOf(ref)).concat(ref));
      return;
    }
    if (visited.has(ref) || cycles.length) return;
    visiting.add(ref);
    stack.push(ref);
    for (const target of graph.get(ref) ?? []) visit(target);
    stack.pop();
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const ref of graph.keys()) visit(ref);
  return cycles;
}
