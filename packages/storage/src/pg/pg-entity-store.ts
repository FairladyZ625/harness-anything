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
    `INSERT INTO ${table}
             (tenant_id, project_id, policy_epoch, readers, ${idColumn}, workspace_revision, declaration_revision, declaration,
              document_path, document_sha256, extension_metadata, updated_at)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $6, $7::jsonb, $8, $9, $10::jsonb, clock_timestamp())
           ON CONFLICT (tenant_id, project_id, policy_epoch, ${idColumn}) DO UPDATE SET
             policy_epoch = excluded.policy_epoch, readers = excluded.readers,
             workspace_revision = excluded.workspace_revision, declaration_revision = excluded.declaration_revision, declaration = excluded.declaration,
             document_path = excluded.document_path, document_sha256 = excluded.document_sha256,
             extension_metadata = excluded.extension_metadata, updated_at = excluded.updated_at
           WHERE ${table}.workspace_revision < excluded.workspace_revision`,
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
