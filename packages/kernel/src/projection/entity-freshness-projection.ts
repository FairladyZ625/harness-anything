import type { DatabaseSync } from "node:sqlite";
import { parseEntityRef } from "../domain/entity-ref.ts";
import type { EntityFreshness, EntityVersionWitness } from "../domain/entity-freshness.ts";

export function readEntityVersionWitness(db: DatabaseSync, entityRef: string): EntityVersionWitness {
  return readEntityVersionWitnesses(db, [entityRef]).get(entityRef)!;
}

export function readEntityVersionWitnesses(
  db: DatabaseSync,
  entityRefs: readonly string[],
): ReadonlyMap<string, EntityVersionWitness> {
  const uniqueRefs = [...new Set(entityRefs)],
    witnesses = new Map<string, EntityVersionWitness>();
  if (uniqueRefs.length === 0) return witnesses;
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String((row as { readonly name: unknown }).name)),
  );
  const requests = uniqueRefs.map((entityRef) => {
      const parsed = parseEntityRef(entityRef);
      return {
        ref: entityRef,
        kind: parsed && !parsed.externalHarness ? parsed.kind : null,
        id: parsed && !parsed.externalHarness ? parsed.id : null,
      };
    }),
    joins = [
      tables.has("entity_projection")
        ? "LEFT JOIN entity_projection projected ON projected.entity_kind || '/' || projected.entity_id=requested.ref"
        : "",
      ...coreVersionLookups
        .filter(({ table }) => tables.has(table))
        .map(({ kind, table, idColumn }) =>
          [
            `LEFT JOIN ${table} ${kind}_version ON`,
            `requested.kind='${kind}'`,
            `AND ${kind}_version.${idColumn}=requested.id`,
          ].join(" "),
        ),
    ].filter(Boolean),
    projectedPresent = tables.has("entity_projection") ? "projected.entity_id IS NOT NULL" : "0",
    projectedFreshness = tables.has("entity_projection") ? "projected.freshness" : "NULL",
    projectedVersion = tables.has("entity_projection") ? "projected.current_version" : "NULL",
    coreVersions = coreVersionLookups
      .filter(({ table }) => tables.has(table))
      .map(({ kind }) => `${kind}_version.workspace_revision`),
    coreVersion = coreVersions.length > 1 ? `COALESCE(${coreVersions.join(", ")})` : (coreVersions[0] ?? "NULL"),
    rows = db
      .prepare(
        `WITH requested AS (
          SELECT CAST(key AS INTEGER) AS position,
            json_extract(value, '$.ref') AS ref,
            json_extract(value, '$.kind') AS kind,
            json_extract(value, '$.id') AS id
          FROM json_each(?)
        )
        SELECT requested.ref,
          CASE WHEN ${projectedPresent} THEN ${projectedFreshness}
               WHEN ${coreVersion} IS NOT NULL THEN 'current' ELSE 'unknown' END AS freshness,
          CASE WHEN ${projectedPresent} THEN ${projectedVersion} ELSE ${coreVersion} END AS current_version
        FROM requested ${joins.join(" ")} ORDER BY requested.position`,
      )
      .all(JSON.stringify(requests)) as unknown as readonly {
      readonly ref: string;
      readonly freshness: EntityFreshness;
      readonly current_version: string | number | null;
    }[];
  for (const row of rows)
    witnesses.set(row.ref, {
      entityRef: row.ref,
      freshness: row.freshness,
      currentVersion: row.current_version,
    });
  return witnesses;
}

const coreVersionLookups = [
  { kind: "task", table: "task_snapshot", idColumn: "task_id" },
  { kind: "decision", table: "decision", idColumn: "decision_id" },
  { kind: "fact", table: "fact", idColumn: "fact_id" },
  { kind: "relation", table: "relation_edge", idColumn: "relation_id" },
] as const;
