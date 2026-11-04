// @write-boundary-exemption rebuildable-projection
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { isEntityEvent } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { reduceEntityDeclarationState } from "./entity-declaration-state.ts";
import type {
  EntityDeclarationState,
  EntityDeclarationReadQuery,
} from "@harness-anything/kernel/internal/ports/entity-declarations.ts";

type Query = (
  sql: string,
  values?: readonly (string | number | null)[],
) => Record<string, import("node:sqlite").SQLOutputValue>[];
export const SQLITE_DECLARATION_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS entity_declaration_head (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, state_json TEXT NOT NULL,
    live INTEGER NOT NULL, PRIMARY KEY(entity_kind,entity_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS entity_declaration_live ON entity_declaration_head(entity_kind,entity_id) WHERE live=1;
  CREATE TABLE IF NOT EXISTS entity_declaration_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0)
  ) STRICT;
  INSERT OR IGNORE INTO entity_declaration_meta VALUES (1,0);
`;

export function applySqliteDeclarationIndex(query: Query, event: CanonicalEventV1): void {
  const revision = Number(query("SELECT revision FROM entity_declaration_meta WHERE singleton=1")[0]!.revision);
  // A preceding old writer leaves a gap. Only the constructor's ordered catch-up can repair it.
  if (revision !== event.workspaceRevision - 1) return;
  if (isEntityEvent(event)) {
    const keys = [event.payload.entityKind, event.payload.entityId],
      before = query("SELECT state_json FROM entity_declaration_head WHERE entity_kind=? AND entity_id=?", keys)[0],
      state = reduceEntityDeclarationState(
        before ? (JSON.parse(String(before.state_json)) as EntityDeclarationState) : null,
        event,
      );
    query(
      "INSERT INTO entity_declaration_head(entity_kind,entity_id,state_json,live) VALUES (?,?,?,?) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET state_json=excluded.state_json,live=excluded.live",
      [...keys, JSON.stringify(state), state.declaration ? 1 : 0],
    );
  }
  query("UPDATE entity_declaration_meta SET revision=? WHERE singleton=1", [event.workspaceRevision]);
}

export function backfillSqliteDeclarationIndex(query: Query): void {
  let after = Number(query("SELECT revision FROM entity_declaration_meta WHERE singleton=1")[0]!.revision);
  for (;;) {
    const rows = query("SELECT revision,event_json FROM event WHERE revision>? ORDER BY revision LIMIT 64", [after]);
    if (rows.length === 0) return;
    for (const row of rows) applySqliteDeclarationIndex(query, JSON.parse(String(row.event_json)) as CanonicalEventV1);
    after = Number(rows.at(-1)!.revision);
  }
}

export function readSqliteEntityDeclarations(
  query: Query,
  input: EntityDeclarationReadQuery,
): readonly EntityDeclarationState[] {
  const ready = query(
    "SELECT d.revision=l.revision AS ready FROM entity_declaration_meta d JOIN ledger_meta l USING(singleton)",
  )[0];
  if (!ready || ready.ready !== 1)
    throw Object.assign(new Error("Current declaration index needs writer catch-up"), { code: "projection_pending" });
  const values: (string | number)[] = [input.kind],
    conditions = ["entity_kind=?", "live=1"];
  if (input.id !== undefined) {
    conditions.push("entity_id=?");
    values.push(input.id);
  }
  let limit = "";
  if (input.limit !== undefined) {
    values.push(input.limit);
    limit = " LIMIT ?";
  }
  return query(
    `SELECT state_json FROM entity_declaration_head WHERE ${conditions.join(" AND ")} ORDER BY entity_id${limit}`,
    values,
  ).map((row) => JSON.parse(String(row.state_json)) as EntityDeclarationState);
}
