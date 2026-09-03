import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { EntityVersion, RelationFreshness } from "../domain/entity-freshness.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { createHarnessRuntimeContext, resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import {
  decodeRebuildableRelationRecords,
  rebuildableRelationRequiredColumns,
  type CoverageRecord,
  type EdgeRecord,
  type FactAnchorRecord,
  type FactRecord,
  type RebuildableRelationRead,
  type RebuildableRelationUnavailable,
  type TaskRecord,
} from "./rebuildable-relation-read.ts";
import type { ProjectionReadResult, ProjectionWarning, TaskProjectionOptions } from "./types.ts";

export interface RelationGraphEdgeRow {
  readonly relationId: string;
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
      workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relation_edge_source ON relation_edge(source_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_target ON relation_edge(target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_type_target ON relation_edge(relation_type, target_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_state_page ON relation_edge(state, relation_id);
    CREATE INDEX IF NOT EXISTS relation_edge_target_observation
      ON relation_edge(target_ref, target_observed_version, relation_id);
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

export function readRelationGraphProjection(options: TaskProjectionOptions): {
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReadonlyArray<RelationFactRow>;
  readonly taskRows: ProjectionReadResult["rows"];
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readRebuildableRelationProjection(projectionPath);
  if (!projection.ok)
    return {
      edges: [],
      coverageRows: [],
      factAnchors: [],
      facts: [],
      taskRows: [],
      warnings: [relationTruthUnavailable(projection.reason)],
    };
  return {
    edges: projection.edges,
    coverageRows: projection.coverageRows,
    factAnchors: projection.factAnchors,
    facts: projection.facts,
    taskRows: projection.taskRows,
    warnings: [],
  };
}

function relationTruthUnavailable(message: string): ProjectionWarning {
  return {
    code: "relation_truth_unavailable",
    source: "generated-cache",
    severity: "hard-fail",
    message,
    repairHint:
      "Materialize the rebuild relation projection before serving graph reads; " +
      "never rebuild the canonical cache from a read request.",
  };
}

function readRebuildableRelationProjection(
  projectionPath: string,
): RebuildableRelationRead | RebuildableRelationUnavailable {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(projectionPath, { readOnly: true });
    const marker = database.prepare("SELECT value FROM projection_meta WHERE key = 'relationTruthSource'").get() as
      | { readonly value?: string }
      | undefined;
    if (marker?.value !== "authored-l1/v1") {
      throw new Error("Relation truth source is unavailable or incomplete");
    }
    for (const [table, columns] of Object.entries(rebuildableRelationRequiredColumns)) {
      const actual = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>).map(
          ({ name }) => name,
        ),
      );
      const missing = columns.filter((column) => !actual.has(column));
      if (missing.length) {
        throw new Error(`Relation truth table ${table} is unavailable or missing columns: ${missing.join(", ")}`);
      }
    }
    return decodeRebuildableRelationRecords({
      edges: database.prepare("SELECT * FROM relation_edges ORDER BY relation_id").all() as unknown as EdgeRecord[],
      coverageRows: database
        .prepare("SELECT * FROM relation_coverage ORDER BY claim_ref")
        .all() as unknown as CoverageRecord[],
      factAnchors: database
        .prepare("SELECT * FROM task_fact_anchors ORDER BY fact_ref")
        .all() as unknown as FactAnchorRecord[],
      facts: database.prepare("SELECT * FROM task_fact_projection ORDER BY fact_ref").all() as unknown as FactRecord[],
      taskRows: database.prepare("SELECT * FROM task_projection ORDER BY task_id").all() as unknown as TaskRecord[],
    });
  } catch (error) {
    consumeKnownError(error);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
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
