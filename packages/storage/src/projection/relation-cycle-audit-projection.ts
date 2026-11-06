// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import {
  findRelationCycleWitnesses,
  type RelationCycleEdge,
} from "@harness-anything/kernel/internal/domain/relation-cycle.ts";
import { relationTypeDeclarations } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import type { RelationCycleAudit } from "@harness-anything/kernel";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const acyclicTypes = relationTypeDeclarations
  .filter((entry) => entry.acyclic)
  .map(({ type }) => `'${type}'`)
  .join(",");
const edgeColumns = "relation_id,source_ref,target_ref,relation_type,direction,state";
const edgeSelect = (
  id?: string,
) => `SELECT relation_id,source_ref,target_ref,relation_type,json_extract(row_json,'$.direction'),state
  FROM relation_edge ${id ? `WHERE relation_id=${id}` : "WHERE true"}
  UNION ALL SELECT ${edgeColumns} FROM task_relation WHERE ${id ? `relation_id=${id} AND ` : ""}
  NOT EXISTS (SELECT 1 FROM relation_edge e WHERE e.relation_id=task_relation.relation_id)`;
const upsert = ` ON CONFLICT(relation_id) DO UPDATE SET source_ref=excluded.source_ref,target_ref=excluded.target_ref,
  relation_type=excluded.relation_type,direction=excluded.direction,state=excluded.state`;

/** Expand the rebuildable cache atomically; previous binaries also maintain the normalized edges
 * and mark affected components dirty through triggers. Readers refuse an unfinished refresh. */
export function ensureRelationCycleAudit(db: DatabaseSync): void {
  if (queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='relation_cycle_edge'").length) {
    if (queryRows(db, "SELECT 1 FROM relation_cycle_dirty LIMIT 1").length)
      transaction(db, () => refreshRelationCycleAudit(db));
    return;
  }
  transaction(db, () => {
    runSql(
      db,
      `CREATE TABLE relation_cycle_edge (relation_id TEXT PRIMARY KEY,source_ref TEXT,target_ref TEXT,relation_type TEXT,direction TEXT,state TEXT)`,
    );
    for (const endpoint of ["source", "target"])
      runSql(
        db,
        `CREATE INDEX relation_cycle_${endpoint} ON relation_cycle_edge(relation_type,state,direction,${endpoint}_ref)`,
      );
    runSql(db, "CREATE TABLE relation_cycle_count (singleton INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
    runSql(db, "INSERT INTO relation_cycle_count VALUES (1,0)");
    runSql(
      db,
      "CREATE TABLE relation_cycle_dirty (relation_type TEXT,node_ref TEXT,PRIMARY KEY(relation_type,node_ref))",
    );
    runSql(
      db,
      "CREATE TABLE relation_cycle_component (component_id TEXT PRIMARY KEY,relation_type TEXT,priority TEXT,issue_json TEXT)",
    );
    runSql(db, "CREATE INDEX relation_cycle_component_type ON relation_cycle_component(relation_type)");
    runSql(
      db,
      "CREATE TABLE relation_cycle_member (relation_type TEXT,node_ref TEXT,component_id TEXT,PRIMARY KEY(relation_type,node_ref))",
    );
    runSql(db, "CREATE INDEX relation_cycle_member_component ON relation_cycle_member(component_id)");
    runSql(db, "CREATE TABLE relation_cycle_result (relation_type TEXT PRIMARY KEY,issue_json TEXT)");
    const dirty = (row: string) => `INSERT INTO relation_cycle_dirty
      SELECT ${row}.relation_type,${row}.source_ref WHERE ${row}.relation_type IN (${acyclicTypes}) ON CONFLICT(relation_type,node_ref) DO NOTHING;
      INSERT INTO relation_cycle_dirty SELECT ${row}.relation_type,${row}.target_ref WHERE ${row}.relation_type IN (${acyclicTypes}) ON CONFLICT(relation_type,node_ref) DO NOTHING;`;
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const before = operation !== "INSERT",
        after = operation !== "DELETE";
      runSql(
        db,
        `CREATE TRIGGER relation_cycle_changed_${operation} AFTER ${operation} ON relation_cycle_edge BEGIN
        ${before ? dirty("OLD") : ""}${after ? dirty("NEW") : ""}
        ${operation === "INSERT" ? "UPDATE relation_cycle_count SET count=count+1;" : operation === "DELETE" ? "UPDATE relation_cycle_count SET count=count-1;" : ""} END`,
      );
      for (const table of ["relation_edge", "task_relation"])
        runSql(
          db,
          `CREATE TRIGGER relation_cycle_mirror_${table}_${operation} AFTER ${operation} ON ${table} BEGIN
          ${before ? "DELETE FROM relation_cycle_edge WHERE relation_id=OLD.relation_id;" : ""}
          INSERT INTO relation_cycle_edge ${edgeSelect(after ? "NEW.relation_id" : "OLD.relation_id")}${upsert}; END`,
        );
    }
    runSql(db, `INSERT INTO relation_cycle_edge ${edgeSelect()}${upsert}`);
    refreshRelationCycleAudit(db);
  });
}

/** Refresh only changed weak components. Disconnected historical edges never enter the work.
 * The domain algorithm still chooses every witness; its deterministic per-type winner is cached
 * when a cyclic component changes, including legacy imports, replacements and retirements. */
export function refreshRelationCycleAudit(db: DatabaseSync): void {
  const dirty = queryRows<{ relation_type: RelationCycleEdge["relationType"]; node_ref: string }>(
    db,
    "SELECT relation_type,node_ref FROM relation_cycle_dirty ORDER BY relation_type,node_ref",
  );
  for (const type of new Set(dirty.map((row) => row.relation_type))) {
    const seeds = new Set(dirty.filter((row) => row.relation_type === type).map((row) => row.node_ref));
    const oldComponents = queryRows<{ component_id: string }>(
      db,
      "SELECT DISTINCT component_id FROM relation_cycle_member WHERE relation_type=? AND node_ref IN (SELECT value FROM json_each(?))",
      type,
      JSON.stringify([...seeds]),
    );
    const oldIds = JSON.stringify(oldComponents.map((row) => row.component_id));
    for (const row of queryRows<{ node_ref: string }>(
      db,
      "SELECT node_ref FROM relation_cycle_member WHERE component_id IN (SELECT value FROM json_each(?))",
      oldIds,
    ))
      seeds.add(row.node_ref);
    runSql(db, "DELETE FROM relation_cycle_member WHERE component_id IN (SELECT value FROM json_each(?))", oldIds);
    runSql(db, "DELETE FROM relation_cycle_component WHERE component_id IN (SELECT value FROM json_each(?))", oldIds);
    const visited = new Set<string>();
    let changedCycles = oldComponents.length > 0;
    for (const seed of seeds) {
      if (visited.has(seed)) continue;
      const nodes = new Set([seed]),
        edges = new Map<string, RelationCycleEdge>();
      for (const node of nodes) {
        visited.add(node);
        const rows = queryRows<{
          relation_id: string;
          source_ref: string;
          target_ref: string;
          relation_type: RelationCycleEdge["relationType"];
          direction: RelationCycleEdge["direction"];
          state: RelationCycleEdge["state"];
        }>(
          db,
          `SELECT * FROM relation_cycle_edge WHERE relation_type=? AND state='active' AND direction='directed' AND source_ref=?
           UNION SELECT * FROM relation_cycle_edge WHERE relation_type=? AND state='active' AND direction='directed' AND target_ref=?`,
          type,
          node,
          type,
          node,
        );
        for (const row of rows) {
          edges.set(row.relation_id, {
            relationId: row.relation_id,
            sourceRef: row.source_ref,
            targetRef: row.target_ref,
            relationType: row.relation_type,
            direction: row.direction,
            state: row.state,
          });
          nodes.add(row.source_ref);
          nodes.add(row.target_ref);
        }
      }
      const witness = findRelationCycleWitnesses([...edges.values()])[0];
      if (!witness) continue;
      changedCycles = true;
      const reverse = new Map<string, string[]>();
      for (const edge of edges.values())
        reverse.set(edge.targetRef, [...(reverse.get(edge.targetRef) ?? []), edge.sourceRef]);
      const reaching = new Set(witness.nodeRefs);
      for (const node of reaching) for (const previous of reverse.get(node) ?? []) reaching.add(previous);
      const priority = [...reaching].sort((a, b) => a.localeCompare(b))[0]!;
      const component = JSON.stringify([type, [...nodes].sort()[0]]);
      runSql(
        db,
        "INSERT INTO relation_cycle_component VALUES (?,?,?,?)",
        component,
        type,
        priority,
        JSON.stringify({ code: "relation_cycle_detected", ...witness }),
      );
      for (const node of nodes) runSql(db, "INSERT INTO relation_cycle_member VALUES (?,?,?)", type, node, component);
    }
    if (changedCycles) {
      const candidates = [
        ...queryRows<{ priority: string; issue_json: string }>(
          db,
          "SELECT priority,issue_json FROM relation_cycle_component WHERE relation_type=?",
          type,
        ),
      ];
      candidates.sort((a, b) => a.priority.localeCompare(b.priority));
      runSql(db, "DELETE FROM relation_cycle_result WHERE relation_type=?", type);
      if (candidates[0]) runSql(db, "INSERT INTO relation_cycle_result VALUES (?,?)", type, candidates[0].issue_json);
    }
  }
  runSql(db, "DELETE FROM relation_cycle_dirty");
}

export function readRelationCycleAudit(db: DatabaseSync): RelationCycleAudit {
  if (queryRows(db, "SELECT 1 FROM relation_cycle_dirty LIMIT 1").length)
    throw Object.assign(new Error("Relation cycle projection refresh is pending"), { code: "projection_pending" });
  return {
    scannedEdges: Number(queryRows(db, "SELECT count FROM relation_cycle_count WHERE singleton=1")[0]!.count),
    issues: queryRows<{ issue_json: string }>(
      db,
      "SELECT issue_json FROM relation_cycle_result ORDER BY relation_type",
    ).map((row) => JSON.parse(row.issue_json) as RelationCycleAudit["issues"][number]),
  };
}
