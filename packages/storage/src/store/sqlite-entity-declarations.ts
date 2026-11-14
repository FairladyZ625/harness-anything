import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { canonicalOwnedDirectories } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
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
export const SQLITE_DECLARATION_INDEX_DDL = /* @gate-identity state-store/legacy.66be51206faac3d7 */ /* @gate-identity state-store/task.source.storage.src.store.sqlite-entity-declarations.sqlite-database */ `
  CREATE TABLE IF NOT EXISTS entity_declaration_head (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, state_json TEXT NOT NULL,
    live INTEGER NOT NULL, directory_json TEXT, PRIMARY KEY(entity_kind,entity_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS entity_declaration_live ON entity_declaration_head(entity_kind,entity_id) WHERE live=1;
  CREATE TABLE IF NOT EXISTS entity_declaration_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0)
  ) STRICT;
  INSERT OR IGNORE INTO entity_declaration_meta(singleton,revision) VALUES (1,0);
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
  applyDirectoryIndex(query, event);
  query("UPDATE entity_declaration_meta SET revision=? WHERE singleton=1", [event.workspaceRevision]);
  query(
    "UPDATE attach_migration_scan_meta SET revision=? WHERE migration='entity-directory-working-set/v1' AND revision=?",
    [event.workspaceRevision, event.workspaceRevision - 1],
  );
}

export function backfillSqliteDeclarationIndex(query: Query, transaction: <A>(run: () => A) => A): void {
  transaction(() => {
    if (!query("PRAGMA table_info(entity_declaration_head)").some((row) => row.name === "directory_json"))
      query("ALTER TABLE entity_declaration_head ADD COLUMN directory_json TEXT");
    query(
      "INSERT OR IGNORE INTO attach_migration_scan_meta(migration,revision) VALUES ('entity-directory-working-set/v1',0)",
    );
    query(
      "CREATE INDEX IF NOT EXISTS entity_directory_heads ON entity_declaration_head(entity_kind,entity_id) WHERE directory_json IS NOT NULL",
    );
  });
  for (const directories of [false, true]) {
    for (;;) {
      const processed = transaction(() => {
        const after = Number(
            query(
              directories
                ? "SELECT revision FROM attach_migration_scan_meta WHERE migration='entity-directory-working-set/v1'"
                : "SELECT revision FROM entity_declaration_meta WHERE singleton=1",
            )[0]!.revision,
          ),
          rows = query("SELECT revision,event_json FROM event WHERE revision>? ORDER BY revision LIMIT 64", [after]);
        for (const row of rows) {
          const event = JSON.parse(String(row.event_json)) as CanonicalEventV1;
          if (!directories) applySqliteDeclarationIndex(query, event);
          else applyDirectoryIndex(query, event);
        }
        if (directories && rows.length)
          query("UPDATE attach_migration_scan_meta SET revision=? WHERE migration='entity-directory-working-set/v1'", [
            Number(rows.at(-1)!.revision),
          ]);
        return rows.length;
      });
      if (processed < 64) break;
    }
  }
}

function applyDirectoryIndex(query: Query, event: CanonicalEventV1): void {
  const owned = canonicalOwnedDirectories(event);
  if (owned && isEntityEvent(event))
    query("UPDATE entity_declaration_head SET directory_json=? WHERE entity_kind=? AND entity_id=?", [
      owned.directories.length || owned.retirements.length ? JSON.stringify(owned) : null,
      event.payload.entityKind,
      event.payload.entityId,
    ]);
}

/** Latest declared directory sets, including unclaimed retirement candidates; never replay event history here. */
export function readSqliteDirectoryClaims(
  query: Query,
): readonly NonNullable<ReturnType<typeof canonicalOwnedDirectories>>[] {
  return query(
    "SELECT directory_json FROM entity_declaration_head INDEXED BY entity_directory_heads WHERE directory_json IS NOT NULL ORDER BY entity_kind,entity_id",
  ).map((row) => JSON.parse(String(row.directory_json)) as NonNullable<ReturnType<typeof canonicalOwnedDirectories>>);
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
  let pageSql = "";
  if (input.limit !== undefined) {
    values.push(input.limit);
    pageSql = " LIMIT ?";
  }
  return query(
    `SELECT state_json FROM entity_declaration_head WHERE ${conditions.join(" AND ")} ORDER BY entity_id${pageSql}`,
    values,
  ).map((row) => JSON.parse(String(row.state_json)) as EntityDeclarationState);
}
