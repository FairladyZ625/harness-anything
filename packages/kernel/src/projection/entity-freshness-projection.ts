import type { DatabaseSync } from "node:sqlite";
import { parseEntityRef } from "../domain/entity-ref.ts";
import { PEOPLE_ROSTER_PATH, parsePeopleRosterDocument } from "../domain/people-roster.ts";
import type { EntityFreshness, EntityVersionWitness } from "../domain/entity-freshness.ts";
import { prepareQuery, projectionTables } from "./rebuildable-task-projection-sql.ts";

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
  const tables = projectionTables(db);
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
        ? [
            "LEFT JOIN entity_projection projected ON projected.entity_kind=requested.kind",
            "AND projected.entity_id=requested.id AND requested.ref=requested.kind || '/' || requested.id",
          ].join(" ")
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
    // A decision's lifecycle state word rides the same join its version already used, so
    // source-anchored relation freshness can read "still in force" without a second scan.
    decisionState = tables.has("decision")
      ? "CASE WHEN requested.kind='decision' THEN decision_version.state ELSE NULL END"
      : "NULL",
    rows = prepareQuery(
      db,
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
          CASE WHEN ${projectedPresent} THEN ${projectedVersion} ELSE ${coreVersion} END AS current_version,
          ${decisionState} AS state
        FROM requested ${joins.join(" ")} ORDER BY requested.position`,
    ).all(JSON.stringify(requests)) as unknown as readonly {
      readonly ref: string;
      readonly freshness: EntityFreshness;
      readonly current_version: string | number | null;
      readonly state: string | null;
    }[];
  const roster = requests.some(({ kind }) => kind === "person") ? readPeopleRoster(db, tables) : null;
  for (const row of rows) {
    const personId = roster && row.freshness === "unknown" ? /^person\/(.+)$/u.exec(row.ref)?.[1] : undefined;
    witnesses.set(
      row.ref,
      personId !== undefined && roster!.personIds.has(personId)
        ? { entityRef: row.ref, freshness: "current", currentVersion: roster!.revision }
        : {
            entityRef: row.ref,
            freshness: row.freshness,
            currentVersion: row.current_version,
            ...(row.state === null ? {} : { state: row.state }),
          },
    );
  }
  return witnesses;
}

/** A Person lives in the people.yaml roster document, not in entity_projection; its version is the roster's. */
function readPeopleRoster(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
): { readonly personIds: ReadonlySet<string>; readonly revision: number } | null {
  if (!tables.has("document")) return null;
  const row = prepareQuery(db, "SELECT workspace_revision, value_json FROM document WHERE path=?").get(
    PEOPLE_ROSTER_PATH,
  ) as { readonly workspace_revision: number; readonly value_json: string } | undefined;
  if (row === undefined) return null;
  const { body } = JSON.parse(row.value_json) as { readonly body: string };
  return {
    personIds: new Set(parsePeopleRosterDocument(body).people.map(({ personId }) => personId)),
    revision: row.workspace_revision,
  };
}

const coreVersionLookups = [
  { kind: "task", table: "task_snapshot", idColumn: "task_id" },
  { kind: "decision", table: "decision", idColumn: "decision_id" },
  { kind: "fact", table: "fact", idColumn: "fact_id" },
  { kind: "relation", table: "relation_edge", idColumn: "relation_id" },
] as const;
