import { DatabaseSync } from "node:sqlite";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { EntityVersion, RelationFreshness } from "../domain/entity-freshness.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";

export interface RelationGraphEdgeRow {
  readonly relationId: string;
  /** The Relation aggregate's own revision, the fence `relation unrelate|reconfirm --expected-version` checks; null for a task-snapshot row that has no aggregate. */
  readonly workspaceRevision: number | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly targetObservedVersion: EntityVersion | null;
  readonly currentTargetVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}
export interface RelationCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: "covered" | "uncovered";
  readonly covered: boolean;
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
  /** Derived from `liveness` by `factInvalidated`; consumers read this instead of comparing the word. */
  readonly invalidated: boolean;
  /** Orthogonal to liveness: `fact_archived` retired the managed document but the row stays canonical. */
  readonly archived: boolean;
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
      state TEXT NOT NULL, target_observed_version, owner_ref TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL, updated_at TEXT NOT NULL, row_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relation_edge_source ON relation_edge(source_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_target ON relation_edge(target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_type_target ON relation_edge(relation_type, target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_state_page ON relation_edge(state, relation_id);
    CREATE INDEX IF NOT EXISTS relation_edge_target_observation
      ON relation_edge(target_ref, target_observed_version, relation_id);
    CREATE INDEX IF NOT EXISTS relation_edge_owner ON relation_edge(owner_ref, relation_id);
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
