// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { relationTypes } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { relationFreshnessAnchorForType } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import type { EntityVersion } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import { readEntityVersionWitnesses } from "./entity-freshness-projection.ts";
import { relationFreshnessColumns } from "./relation-freshness-columns.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

/**
 * dec_E34C4284B48AFAF152D7BF1980: a relation's freshness is one global value, computed when the
 * relation or an anchor endpoint changes and stored on relation_edge. Endpoint tables record the
 * changed ref through triggers; the event application drains that set in the same transaction,
 * so every committed cut carries freshness computed at that cut.
 */
const maintenanceKey = "relation-freshness/v1",
  backfillBatchSize = 512,
  sourceAnchoredTypes = relationTypes.filter((type) => relationFreshnessAnchorForType(type) === "source");

/** Endpoint tables whose rows supply an entity version witness, with the columns the witness reads. */
const endpointTriggers = [
  { table: "task_snapshot", ref: "'task/' || {row}.task_id", columns: ["workspace_revision"] },
  { table: "decision", ref: "'decision/' || {row}.decision_id", columns: ["workspace_revision", "state"] },
  { table: "fact", ref: "'fact/' || {row}.fact_id", columns: ["workspace_revision"] },
  { table: "relation_edge", ref: "'relation/' || {row}.relation_id", columns: ["workspace_revision"] },
  {
    table: "entity_projection",
    ref: "{row}.entity_kind || '/' || {row}.entity_id",
    columns: ["workspace_revision", "freshness", "current_version"],
  },
] as const;

export function createRelationFreshnessMaintenance(db: DatabaseSync): void {
  const columns = new Set(
    queryRows<{ readonly name: string }>(db, "PRAGMA table_info(relation_edge)").map(({ name }) => name),
  );
  if (!columns.has("freshness")) runSql(db, "ALTER TABLE relation_edge ADD COLUMN freshness TEXT");
  if (!columns.has("current_target_version")) runSql(db, "ALTER TABLE relation_edge ADD COLUMN current_target_version");
  runSql(db, "CREATE INDEX IF NOT EXISTS relation_edge_freshness_page ON relation_edge(freshness, relation_id)");
  runSql(db, "CREATE TABLE IF NOT EXISTS relation_freshness_dirty (ref TEXT PRIMARY KEY)");
  for (const { table, ref, columns: watched } of endpointTriggers) {
    const newRef = ref.replaceAll("{row}", "NEW"),
      oldRef = ref.replaceAll("{row}", "OLD"),
      changed = watched.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
    runSql(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_relation_freshness_insert AFTER INSERT ON ${table}
        BEGIN INSERT OR IGNORE INTO relation_freshness_dirty(ref) VALUES (${newRef}); END`,
    );
    runSql(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_relation_freshness_update AFTER UPDATE OF ${watched.join(", ")} ON ${table}
        WHEN ${changed}
        BEGIN INSERT OR IGNORE INTO relation_freshness_dirty(ref) VALUES (${newRef}); END`,
    );
    runSql(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_relation_freshness_delete AFTER DELETE ON ${table}
        BEGIN INSERT OR IGNORE INTO relation_freshness_dirty(ref) VALUES (${oldRef}); END`,
    );
  }
  backfillRelationFreshness(db);
}

/** Existing projections predate the column; fill it once in bounded transactions before serving reads. */
function backfillRelationFreshness(db: DatabaseSync): void {
  if (queryRows(db, "SELECT 1 FROM projection_maintenance WHERE key = ?", maintenanceKey).length > 0) return;
  let cursor = "";
  for (;;) {
    const rows = queryRows<RelationFreshnessInput>(
      db,
      `SELECT ${relationInputColumns} FROM relation_edge WHERE relation_id > ? ORDER BY relation_id LIMIT ?`,
      cursor,
      backfillBatchSize,
    );
    if (rows.length === 0) break;
    transaction(db, () => storeRelationFreshness(db, rows));
    cursor = rows.at(-1)!.relation_id;
  }
  runSql(db, "DELETE FROM relation_freshness_dirty");
  runSql(
    db,
    "INSERT INTO projection_maintenance(key, completed_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    maintenanceKey,
  );
}

/**
 * Recompute every relation whose freshness can follow a ref changed since the last drain: edges
 * targeting the ref or one of its anchors, source-anchored edges leaving it, and a changed relation
 * itself. Each lookup is an endpoint index range, so the work is proportional to the changed
 * endpoints' incident relations. Returns how many relations were recomputed.
 */
export function refreshDirtyRelationFreshness(db: DatabaseSync): number {
  const refs = queryRows<{ readonly ref: string }>(db, "SELECT ref FROM relation_freshness_dirty ORDER BY ref").map(
    ({ ref }) => ref,
  );
  if (refs.length === 0) return 0;
  runSql(db, "DELETE FROM relation_freshness_dirty");
  const affected = new Map<string, RelationFreshnessInput>();
  for (const ref of refs) {
    const relationId = ref.match(/^relation\/([^/]+)$/u)?.[1] ?? null;
    for (const row of queryRows<RelationFreshnessInput>(
      db,
      [
        // [ref, ref0) covers the ref and every `<ref>/<anchor>` form through one index range.
        `SELECT ${relationInputColumns} FROM relation_edge WHERE target_ref >= ? AND target_ref < ?`,
        "UNION",
        `SELECT ${relationInputColumns} FROM relation_edge`,
        "WHERE relation_type IN (SELECT value FROM json_each(?)) AND source_ref >= ? AND source_ref < ?",
        ...(relationId === null
          ? []
          : ["UNION", `SELECT ${relationInputColumns} FROM relation_edge WHERE relation_id = ?`]),
      ].join(" "),
      ref,
      `${ref}0`,
      JSON.stringify(sourceAnchoredTypes),
      ref,
      `${ref}0`,
      ...(relationId === null ? [] : [relationId]),
    ))
      affected.set(row.relation_id, row);
  }
  storeRelationFreshness(db, [...affected.values()]);
  return affected.size;
}

type RelationFreshnessInput = {
  readonly relation_id: string;
  readonly source_ref: string;
  readonly target_ref: string;
  readonly relation_type: string;
  readonly target_observed_version: EntityVersion | null;
  readonly freshness: string | null;
  readonly current_target_version: EntityVersion | null;
};

const relationInputColumns =
  "relation_id, source_ref, target_ref, relation_type, target_observed_version, freshness, current_target_version";

function storeRelationFreshness(db: DatabaseSync, rows: readonly RelationFreshnessInput[]): void {
  if (rows.length === 0) return;
  const witnesses = readEntityVersionWitnesses(
    db,
    rows.flatMap((row) =>
      relationFreshnessAnchorForType(row.relation_type as RelationType) === "source"
        ? [row.target_ref, row.source_ref]
        : [row.target_ref],
    ),
  );
  for (const row of rows) {
    const next = relationFreshnessColumns(
      {
        type: row.relation_type as RelationType,
        target: row.target_ref,
        targetObservedVersion: row.target_observed_version,
      },
      witnesses.get(row.target_ref)!,
      witnesses.get(row.source_ref),
    );
    if (next.freshness === row.freshness && next.currentTargetVersion === row.current_target_version) continue;
    runSql(
      db,
      "UPDATE relation_edge SET freshness = ?, current_target_version = ? WHERE relation_id = ?",
      next.freshness,
      next.currentTargetVersion,
      row.relation_id,
    );
  }
}
