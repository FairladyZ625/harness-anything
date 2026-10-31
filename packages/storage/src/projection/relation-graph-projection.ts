import { DatabaseSync } from "node:sqlite";
import type { HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import type { EventBackedRelationTruth, RelationGraphProjection } from "@harness-anything/kernel";
export type {
  DecisionAnchorTruth,
  EventBackedRelationTruth,
  FactAnchorRow,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  RelationGraphProjection,
} from "@harness-anything/kernel";
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
