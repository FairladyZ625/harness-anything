import {
  assertPostgresClaims,
  type PostgresScopeClaims,
} from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { PostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "./scope-schema.ts";

export type { PostgresScopeClaims } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";

export interface PostgresTransactionOptions<T = unknown> {
  /** Keep every statement in a read transaction on one committed snapshot. */
  readonly isolationLevel?: "repeatable read";
  /** A replay may have acquired a row lock; discard its lock WAL instead of synchronously committing it. */
  readonly rollbackOnly?: (result: T) => boolean;
  readonly onSyncRepInterrupted?: (notice: SyncRepNotice) => void;
}

interface SyncRepNotice {
  readonly code?: string;
  readonly routine?: string;
  readonly file?: string;
  readonly message?: string;
}

export function isSyncRepWaitInterruptedNotice(notice: SyncRepNotice): boolean {
  return (
    notice.routine === "SyncRepWaitForLSN" ||
    notice.file === "syncrep.c" ||
    ((notice.code === "01000" || notice.code === "57P01") && /synchronous replication/iu.test(notice.message ?? ""))
  );
}

class SyncRepWaitInterruptedError extends Error {
  readonly code = "sync_rep_wait_canceled";
  readonly notice: SyncRepNotice;
  constructor(notice: SyncRepNotice) {
    super("PostgreSQL synchronous replication wait was interrupted");
    this.notice = notice;
  }
}

const committedWork = new WeakMap<PoolClient, (() => Promise<void>)[] | undefined>();

/** Register connection-local work that must never run before a successful COMMIT. */
export function afterPostgresCommit(client: PoolClient, operation: () => Promise<void>): void {
  const pending = committedWork.get(client);
  if (!pending) throw new Error("PostgreSQL commit work requires an owned transaction");
  pending.push(operation);
}

export function createPostgresPool(connectionString: string, options: Omit<PoolConfig, "connectionString"> = {}): Pool {
  return new Pool({ ...options, connectionString });
}

/**
 * Run one async driver transaction. Scope claims are transaction-local, so commit/rollback clears them
 * before the checked-out connection returns to the pool.
 */
export async function withPostgresTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  claims?: PostgresScopeClaims,
  options?: PostgresTransactionOptions<T>,
): Promise<T> {
  const client = await pool.connect();
  let returned = false,
    commitStarted = false,
    interrupted: SyncRepNotice | undefined,
    connectionError: Error | undefined;
  // The pool removes its idle error listener while a client is checked out. A disconnect can
  // reject the query AND emit a client error before rollback/release has returned it to the pool.
  const onConnectionError = (error: Error) => {
    connectionError ??= error;
  };
  client.on("error", onConnectionError);
  const onNotice = (notice: SyncRepNotice) => {
    if (isSyncRepWaitInterruptedNotice(notice)) {
      interrupted = notice;
      options?.onSyncRepInterrupted?.(notice);
    }
  };
  client.on("notice", onNotice);
  const pending: (() => Promise<void>)[] = [];
  committedWork.set(client, pending);
  try {
    await client.query(
      options?.isolationLevel ? `BEGIN ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}` : "BEGIN",
    );
    if (claims) await setPostgresClaims(client, claims);
    const result = await operation(client);
    if (connectionError) throw connectionError;
    if (options?.rollbackOnly?.(result)) {
      await client.query("ROLLBACK");
      return result;
    }
    commitStarted = true;
    await client.query("COMMIT");
    if (interrupted) throw new SyncRepWaitInterruptedError(interrupted);
    if (connectionError) throw connectionError;
    for (const operation of pending) {
      await operation();
      if (interrupted) throw new SyncRepWaitInterruptedError(interrupted);
    }
    return result;
  } catch (error) {
    if (commitStarted) {
      client.release(error instanceof Error ? error : new Error(String(error)));
      returned = true;
      throw error;
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      returned = true;
      throw new AggregateError(
        [error, ...(connectionError && connectionError !== error ? [connectionError] : []), rollbackError],
        "PostgreSQL transaction and rollback both failed.",
      );
    }
    throw error;
  } finally {
    committedWork.set(client, undefined);
    if (!returned) client.release();
    client.removeListener("error", onConnectionError);
    client.removeListener("notice", onNotice);
  }
}

async function setPostgresClaims(client: PoolClient, claims: PostgresScopeClaims): Promise<void> {
  assertPostgresClaims(claims);
  const names = POSTGRES_SCOPE_SCHEMA_CONTRACT.claims;
  await client.query("SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)", [
    names.tenantId,
    claims.tenantId,
    names.projectId,
    claims.projectId,
    names.policyEpoch,
    String(claims.policyEpoch),
  ]);
}

export interface ConfirmedRepoCut {
  readonly history: string;
  readonly confirmedRevision: number;
  readonly confirmedSequence: number;
}

/** One memory-only statement, after the WAL-bearing transaction has been synchronously committed. */
export async function advanceConfirmedRepoCut(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  cut: ConfirmedRepoCut,
): Promise<void> {
  await client.query(
    `WITH claims AS MATERIALIZED (
       SELECT set_config('ha.tenant_id',$1,true), set_config('ha.project_id',$2,true),
              set_config('ha.policy_epoch',$3,true)
     ) INSERT INTO ha_repo_sync_watermarks
       (tenant_id,project_id,repo_id,replication_history,confirmed_revision,confirmed_sequence,readers,policy_epoch)
     SELECT $1,$2,$4,$5,$6,$7,$8::text[],$3::bigint FROM claims
     ON CONFLICT (tenant_id,project_id,repo_id) DO UPDATE SET
       replication_history=EXCLUDED.replication_history,
       confirmed_revision=CASE WHEN ha_repo_sync_watermarks.replication_history=EXCLUDED.replication_history
         THEN GREATEST(ha_repo_sync_watermarks.confirmed_revision,EXCLUDED.confirmed_revision)
         ELSE EXCLUDED.confirmed_revision END,
       confirmed_sequence=CASE WHEN ha_repo_sync_watermarks.replication_history=EXCLUDED.replication_history
         THEN GREATEST(ha_repo_sync_watermarks.confirmed_sequence,EXCLUDED.confirmed_sequence)
         ELSE EXCLUDED.confirmed_sequence END,
       readers=EXCLUDED.readers,policy_epoch=EXCLUDED.policy_epoch,updated_at=clock_timestamp()`,
    [
      scope.tenantId,
      scope.projectId,
      String(scope.policyEpoch),
      repoId,
      cut.history,
      cut.confirmedRevision,
      cut.confirmedSequence,
      scope.readers,
    ],
  );
}

/** Expansion-window maintenance on an owned, scoped repeatable-read transaction. */
export async function backfillConfirmedLegacyOutcomes(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
): Promise<void> {
  const keys = [scope.tenantId, scope.projectId, repoId];
  await client.query("SET LOCAL synchronous_commit = on");
  await client.query(
    `UPDATE ha_command_outcomes o SET replication_sequence=p.sequence FROM ha_replication_positions p
     WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.repo_id=$3 AND o.replication_sequence IS NULL
       AND p.tenant_id=o.tenant_id AND p.project_id=o.project_id AND p.repo_id=o.repo_id AND p.last_op_id=o.op_id`,
    keys,
  );
  await client.query(
    `WITH proof AS MATERIALIZED (SELECT ha_is_lsn_sync_confirmed(pg_current_wal_flush_lsn()) AS confirmed)
     UPDATE ha_command_outcomes SET replication_sequence=0
     WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND replication_sequence IS NULL
       AND (SELECT confirmed FROM proof)`,
    keys,
  );
}

/** A snapshot's visible prefix; NULL outcomes never stand in for sequence zero. */
export async function resolveConfirmedRepoCut(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
): Promise<ConfirmedRepoCut | null> {
  const row = (
    await client.query<{
      revision: string;
      replication_history: string;
      max_seq: string;
      readers: string[];
      policy_epoch: string;
      has_null_outcomes: boolean;
      wm_history: string | null;
      wm_rev: string | null;
      wm_seq: string | null;
      can_write: boolean;
    }>(
      `WITH snap AS MATERIALIZED (
       SELECT h.revision,h.replication_history,h.readers,h.policy_epoch,
         COALESCE((SELECT MAX(p.sequence) FROM ha_replication_positions p
           WHERE p.tenant_id=h.tenant_id AND p.project_id=h.project_id AND p.repo_id=h.repo_id),0) AS max_seq,
         EXISTS(SELECT 1 FROM ha_command_outcomes o WHERE o.tenant_id=h.tenant_id
           AND o.project_id=h.project_id AND o.repo_id=h.repo_id AND o.replication_sequence IS NULL) AS has_null_outcomes,
         w.replication_history AS wm_history,w.confirmed_revision AS wm_rev,w.confirmed_sequence AS wm_seq
       FROM ha_repo_heads h LEFT JOIN ha_repo_sync_watermarks w USING(tenant_id,project_id,repo_id)
       WHERE h.tenant_id=$1 AND h.project_id=$2 AND h.repo_id=$3
     ) SELECT *, has_table_privilege(current_user,'ha_repo_sync_watermarks','INSERT')
         AND has_table_privilege(current_user,'ha_repo_sync_watermarks','UPDATE') AS can_write FROM snap`,
      [scope.tenantId, scope.projectId, repoId],
    )
  ).rows[0];
  if (!row) return null;
  const hot =
    row.wm_history === row.replication_history &&
    Number(row.wm_rev) >= Number(row.revision) &&
    Number(row.wm_seq) >= Number(row.max_seq) &&
    !row.has_null_outcomes;
  // PostgreSQL checks function EXECUTE even for an unselected CASE branch. An absent head
  // or an already proven watermark must not require the cold-recovery privilege at all.
  const confirmed =
    hot ||
    (
      await client.query<{ confirmed: boolean }>(
        "SELECT ha_is_lsn_sync_confirmed(pg_current_wal_flush_lsn()) AS confirmed",
      )
    ).rows[0]!.confirmed;
  if (confirmed) {
    const cut = {
      history: row.replication_history,
      confirmedRevision: Number(row.revision),
      confirmedSequence: Number(row.max_seq),
    };
    if (!hot && row.can_write) {
      const ownerScope = { ...scope, readers: row.readers, policyEpoch: Number(row.policy_epoch) };
      if (row.has_null_outcomes)
        afterPostgresCommit(client, async () => {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await setPostgresClaims(client, ownerScope);
          await backfillConfirmedLegacyOutcomes(client, ownerScope, repoId);
          await client.query("COMMIT");
        });
      afterPostgresCommit(client, () => advanceConfirmedRepoCut(client, ownerScope, repoId, cut));
    }
    return cut;
  }
  if (row.wm_history === row.replication_history)
    return {
      history: row.replication_history,
      confirmedRevision: Number(row.wm_rev),
      confirmedSequence: Number(row.wm_seq),
    };
  throw new TaskEventStoreError("publication_indeterminate", "sync_replication_unconfirmed");
}
