import { validateStorageReadWindow } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { PoolClient } from "pg";
import {
  replicationCommitBytes,
  REPLICATION_PAGE_BYTES,
  type ReplicationPosition,
  type ReplicationCommit,
} from "../store/replication-log.ts";
import type { SqliteCommandOutcome, SqliteEventRow } from "../store/sqlite-event-store-types.ts";
import type { PostgresEventStoreScope } from "./pg-event-store.ts";
import { resolveConfirmedRepoCut } from "./transaction.ts";
import { TaskEventStoreError } from "@harness-anything/kernel";

export async function pgReplicationHead(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
): Promise<ReplicationPosition> {
  const cut = await resolveConfirmedRepoCut(client, scope, repoId);
  if (!cut) throw new TaskEventStoreError("invalid_store", "repository has no canonical PG head");
  return { history: cut.history, sequence: cut.confirmedSequence, revision: cut.confirmedRevision };
}

export async function pgEventRows(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  after = 0,
  through?: number,
): Promise<readonly SqliteEventRow[]> {
  through ??= (await resolveConfirmedRepoCut(client, scope, repoId))?.confirmedRevision ?? 0;
  const result = await client.query<{
    revision: string;
    op_id: string;
    event_json: string;
    occurred_at: string;
    recorded_at: string;
    event_digest: `sha256:${string}`;
  }>(
    `SELECT revision,op_id,event_json,occurred_at,event_digest,COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS recorded_at FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 AND revision<=$5 ORDER BY revision`,
    [scope.tenantId, scope.projectId, repoId, after, through],
  );
  return result.rows.map((row) => ({
    revision: Number(row.revision),
    opId: row.op_id,
    eventJson: row.event_json,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    digest: row.event_digest,
  }));
}

export async function pgOutcomes(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  opId?: string,
  through?: number,
): Promise<readonly SqliteCommandOutcome[]> {
  through ??= (await resolveConfirmedRepoCut(client, scope, repoId))?.confirmedSequence ?? 0;
  const result = await client.query<{
    op_id: string;
    status: "accepted_durable" | "rejected";
    first_revision: string | null;
    last_revision: string | null;
    intent_digest: `sha256:${string}`;
    intent_summary: string;
    rejection_code: string | null;
    recorded_at: string;
    member_op_ids: string[];
  }>(
    `SELECT op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,member_op_ids,COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS recorded_at FROM ha_command_outcomes WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND replication_sequence IS NOT NULL AND replication_sequence<=$4${opId === undefined ? "" : " AND op_id=$5"} ORDER BY first_revision NULLS LAST,op_id`,
    [scope.tenantId, scope.projectId, repoId, through, ...(opId === undefined ? [] : [opId])],
  );
  return result.rows.map((row) => ({
    opId: row.op_id,
    status: row.status,
    firstRevision: row.first_revision === null ? null : Number(row.first_revision),
    lastRevision: row.last_revision === null ? null : Number(row.last_revision),
    intentDigest: row.intent_digest,
    summary: row.intent_summary,
    rejectionCode: row.rejection_code,
    recordedAt: row.recorded_at,
    memberOpIds: row.member_op_ids,
  }));
}

export async function pgReplicationPage(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  after: ReplicationPosition,
  limit: number,
) {
  const head = await pgReplicationHead(client, scope, repoId),
    keys = [scope.tenantId, scope.projectId, repoId],
    anchor = (
      await client.query<{ revision: string }>(
        "SELECT revision FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND sequence=$4",
        [...keys, after.sequence],
      )
    ).rows[0];
  if (
    !validateStorageReadWindow(limit) ||
    after.history !== head.history ||
    !anchor ||
    Number(anchor.revision) !== after.revision ||
    after.sequence > head.sequence
  )
    throw new TaskEventStoreError("revision_conflict", "replication_snapshot_required");
  const rows = (
      await client.query<{
        sequence: string;
        revision: string;
        last_op_id: string | null;
        writer_holder_id: string;
        writer_epoch: string;
      }>(
        "SELECT sequence,revision,last_op_id,writer_holder_id,writer_epoch FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND sequence>$4 AND sequence<=$6 ORDER BY sequence LIMIT $5",
        [...keys, after.sequence, limit, head.sequence],
      )
    ).rows,
    commits: ReplicationCommit[] = [];
  let bytes = 0;
  for (const row of rows) {
    const outcome = row.last_op_id
      ? ((await pgOutcomes(client, scope, repoId, row.last_op_id, head.sequence))[0] ?? null)
      : null;
    const commit: ReplicationCommit = {
      position: { history: head.history, sequence: Number(row.sequence), revision: Number(row.revision) },
      outcome,
      events:
        outcome?.firstRevision == null
          ? []
          : await pgEventRows(client, scope, repoId, outcome.firstRevision - 1, outcome.lastRevision!),
      writer: { repoId, holder: row.writer_holder_id, epoch: Number(row.writer_epoch) },
    };
    const size = replicationCommitBytes(commit);
    if (commits.length && bytes + size > REPLICATION_PAGE_BYTES) break;
    commits.push(commit);
    bytes += size;
    if (bytes >= REPLICATION_PAGE_BYTES) break;
  }
  return { commits, head, done: (commits.at(-1)?.position.sequence ?? after.sequence) === head.sequence };
}
