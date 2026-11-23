import type { Pool, PoolClient } from "pg";
import {
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
  type AgentDeclarationV1,
  type SquadDeclarationV1,
} from "@harness-anything/kernel/internal/domain/agent-squad-schema.ts";
import {
  compileEntityUpsert,
  type EntityUpsertBundle,
} from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import type { StoredEntity } from "../store/entity-store.ts";
import type { PostgresScopeClaims } from "../postgres/transaction.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { dialectUpsertValuesSql, getClientDialectCapabilities } from "../postgres/dialect.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

export interface PgEntityStoreOptions {
  readonly pool: Pool;
  readonly scope: PgProjectionScope;
  readonly ownsPool?: boolean;
}

export interface PgEntityDeclarationWrite {
  readonly kind: "agent" | "squad";
  readonly id: string;
  readonly value: AgentDeclarationV1 | SquadDeclarationV1;
  readonly workspaceRevision: number;
  readonly documentPath?: string | null;
  readonly documentSha256?: string | null;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

export interface PgEntityDeclarationStore {
  /** Compile the canonical entity event; A2 persists the returned bundle in its event transaction. */
  readonly upsert: (input: Parameters<typeof compileEntityUpsert>[0]) => EntityUpsertBundle;
  /** Persist an already validated declaration in the same transaction as its canonical event. */
  readonly persist: (write: PgEntityDeclarationWrite) => Promise<void>;
  readonly get: <T = unknown>(kind: "agent" | "squad", id: string) => Promise<StoredEntity<T> | null>;
  readonly list: <T = unknown>(kind: "agent" | "squad") => Promise<readonly StoredEntity<T>[]>;
  readonly close: () => Promise<void>;
}

/** PostgreSQL declaration read/write adapter. RLS remains the visibility boundary; readers narrow a query further. */
export function createPgEntityStore(options: PgEntityStoreOptions): PgEntityDeclarationStore {
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])];
  const tableFor = (kind: "agent" | "squad") => (kind === "agent" ? "ha_agents" : "ha_squads"),
    idColumnFor = (kind: "agent" | "squad") => (kind === "agent" ? "agent_id" : "squad_id");
  const get = <T>(kind: "agent" | "squad", id: string) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const table = tableFor(kind),
          idColumn = idColumnFor(kind),
          result = await client.query<{
            id: string;
            declaration_revision: string;
            declaration: AgentDeclarationV1 | SquadDeclarationV1;
            document_path: string | null;
            document_sha256: string | null;
            extension_metadata: Readonly<Record<string, unknown>>;
          }>(
            `SELECT ${idColumn} AS id, declaration_revision::text, declaration, document_path, document_sha256, extension_metadata
             FROM ${table} WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND ${idColumn} = $4
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, id, readers],
          );
        const row = result.rows[0];
        return row
          ? ({
              kind,
              id: row.id,
              value: row.declaration,
              documentPath: row.document_path,
              documentSha256: row.document_sha256,
              extensionMetadata: row.extension_metadata,
              workspaceRevision: Number(row.declaration_revision),
            } as StoredEntity<T>)
          : null;
      },
      claims,
    );
  const list = <T>(kind: "agent" | "squad") =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const table = tableFor(kind),
          idColumn = idColumnFor(kind),
          result = await client.query<{
            id: string;
            declaration_revision: string;
            declaration: AgentDeclarationV1 | SquadDeclarationV1;
            document_path: string | null;
            document_sha256: string | null;
            extension_metadata: Readonly<Record<string, unknown>>;
          }>(
            `SELECT ${idColumn} AS id, declaration_revision::text, declaration, document_path, document_sha256, extension_metadata
             FROM ${table} WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3
               AND (cardinality($4::text[]) = 0 OR readers && $4::text[]) ORDER BY ${idColumn}`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          );
        return result.rows.map(
          (row) =>
            ({
              kind,
              id: row.id,
              value: row.declaration,
              documentPath: row.document_path,
              documentSha256: row.document_sha256,
              extensionMetadata: row.extension_metadata,
              workspaceRevision: Number(row.declaration_revision),
            }) as StoredEntity<T>,
        );
      },
      claims,
    );
  return {
    upsert: compileEntityUpsert,
    persist: (write) => persistDeclaration(options, write),
    get,
    list,
    close: async () => {
      if (options.ownsPool === true) await options.pool.end();
    },
  };
}

export async function persistPgEntityDeclaration(
  options: PgEntityStoreOptions,
  write: PgEntityDeclarationWrite,
): Promise<void> {
  await persistDeclaration(options, write);
}

/** A2's append transaction can call this variant without opening a nested transaction. */
export async function persistPgEntityDeclarationInTransaction(
  client: PoolClient,
  scope: PgProjectionScope,
  write: PgEntityDeclarationWrite,
): Promise<void> {
  await persistDeclarationWithClient(client, scope, write);
}

async function persistDeclaration(options: PgEntityStoreOptions, write: PgEntityDeclarationWrite): Promise<void> {
  await withPostgresTransaction(
    options.pool,
    (client) => persistDeclarationWithClient(client, options.scope, write),
    options.scope,
  );
}

async function persistDeclarationWithClient(
  client: PoolClient,
  scope: PgProjectionScope,
  write: PgEntityDeclarationWrite,
): Promise<void> {
  const claims: PostgresScopeClaims = scope,
    readers = [...(scope.readers ?? [])],
    parsed = write.kind === "agent" ? parseAgentDeclarationV1(write.value) : parseSquadDeclarationV1(write.value),
    table = write.kind === "agent" ? "ha_agents" : "ha_squads",
    idColumn = write.kind === "agent" ? "agent_id" : "squad_id",
    extensionMetadata = write.extensionMetadata ?? {};
  if (parsed.id !== write.id) throw new Error(`${write.kind} declaration identity does not match its storage id`);
  await client.query(
    dialectUpsertValuesSql(getClientDialectCapabilities(client), {
      table,
      columns: [
        { name: "tenant_id", valueSql: "$1::text" },
        { name: "project_id", valueSql: "$2::text" },
        { name: "policy_epoch", valueSql: "$3::bigint" },
        { name: "readers", valueSql: "$4::text[]" },
        { name: idColumn, valueSql: "$5::text" },
        { name: "workspace_revision", valueSql: "$6::bigint" },
        { name: "declaration_revision", valueSql: "$6::bigint" },
        { name: "declaration", valueSql: "$7::jsonb" },
        { name: "document_path", valueSql: "$8::text" },
        { name: "document_sha256", valueSql: "$9::text" },
        { name: "extension_metadata", valueSql: "$10::jsonb" },
        { name: "updated_at", valueSql: "clock_timestamp()" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", idColumn],
      updates: [
        { column: "policy_epoch", valueSql: "excluded.policy_epoch" },
        { column: "readers", valueSql: "excluded.readers" },
        { column: "workspace_revision", valueSql: "excluded.workspace_revision" },
        { column: "declaration_revision", valueSql: "excluded.declaration_revision" },
        { column: "declaration", valueSql: "excluded.declaration" },
        { column: "document_path", valueSql: "excluded.document_path" },
        { column: "document_sha256", valueSql: "excluded.document_sha256" },
        { column: "extension_metadata", valueSql: "excluded.extension_metadata" },
        { column: "updated_at", valueSql: "excluded.updated_at" },
      ],
      whereSql: `${table}.workspace_revision < excluded.workspace_revision`,
    }),
    [
      claims.tenantId,
      claims.projectId,
      claims.policyEpoch,
      readers,
      write.id,
      write.workspaceRevision,
      JSON.stringify(parsed),
      write.documentPath ?? null,
      write.documentSha256 ?? null,
      JSON.stringify(extensionMetadata),
    ],
  );
}
