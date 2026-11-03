import type { Pool, PoolClient } from "pg";
import { migrationWritable } from "../migration/types.ts";
import { WriterEpochError, type WriterEpochLease } from "../writer-epoch-contract.ts";

export type PgEpochOperation = "acquire" | "current" | "floor" | "retire" | "begin" | "end";
export interface PgEpochRequest {
  readonly operation: PgEpochOperation;
  readonly repoId: string;
  readonly holderId: string;
  readonly now: string;
  readonly floor?: number;
  readonly epoch?: number;
}

export function pgEpochTransactions(pool: Pool) {
  let held: PoolClient | null = null;
  return {
    async execute(request: PgEpochRequest): Promise<WriterEpochLease | number | null> {
      if (request.operation === "end") {
        if (!held) throw new WriterEpochError("writer_epoch_invalid", "No PG append fence is held");
        const client = held;
        held = null;
        try {
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        return null;
      }
      if (held) throw new WriterEpochError("writer_epoch_invalid", "A PG append fence is already held");
      const client = await pool.connect();
      let retained = false;
      try {
        await client.query("BEGIN");
        if (request.operation === "acquire")
          await client.query("INSERT INTO ha_repo_writer_epochs(repo_id) VALUES($1) ON CONFLICT DO NOTHING", [
            request.repoId,
          ]);
        const row = (
          await client.query<{
            writer_epoch: string;
            writer_holder_id: string | null;
            writer_issued_at: string | null;
            migration_control: Parameters<typeof migrationWritable>[0];
          }>(
            `SELECT writer_epoch,writer_holder_id,writer_issued_at,migration_control FROM ha_repo_writer_epochs WHERE repo_id=$1${request.operation === "acquire" || request.operation === "retire" ? " FOR UPDATE" : " FOR SHARE"}`,
            [request.repoId],
          )
        ).rows[0];
        let epoch = Number(row?.writer_epoch ?? 0),
          holder = row?.writer_holder_id,
          issuedAt = row?.writer_issued_at;
        if (request.operation === "acquire") {
          if (!migrationWritable(row?.migration_control ?? null))
            throw new WriterEpochError("writer_epoch_stale", "Repository is sealed for storage migration");
          const floor = (
            await client.query<{ floor: string | null }>(
              "SELECT MAX(writer_epoch) AS floor FROM ha_repo_heads WHERE repo_id=$1",
              [request.repoId],
            )
          ).rows[0]!.floor;
          epoch = Math.max(epoch, Number(floor ?? 0), request.floor ?? 0) + 1;
          if (!Number.isSafeInteger(epoch))
            throw new WriterEpochError("writer_epoch_invalid", "PG writer epoch exceeds the safe integer range");
          await client.query(
            "UPDATE ha_repo_writer_epochs SET writer_epoch=$2,writer_holder_id=$3,writer_issued_at=$4 WHERE repo_id=$1",
            [request.repoId, epoch, request.holderId, request.now],
          );
          holder = request.holderId;
          issuedAt = request.now;
        }
        if (request.operation === "begin") {
          if (
            !row ||
            epoch !== request.epoch ||
            holder !== request.holderId ||
            !migrationWritable(row.migration_control)
          )
            throw new WriterEpochError(
              "writer_epoch_stale",
              `writer epoch ${request.epoch} for ${request.repoId} is stale`,
            );
          held = client;
          retained = true;
          return null;
        }
        if (request.operation === "retire") {
          await client.query(
            "UPDATE ha_repo_writer_epochs SET writer_holder_id=NULL,writer_issued_at=NULL WHERE repo_id=$1 AND writer_holder_id=$2",
            [request.repoId, request.holderId],
          );
        }
        await client.query("COMMIT");
        if (request.operation === "floor") return epoch;
        return holder && issuedAt
          ? { repoId: request.repoId, holderId: holder, epoch, version: epoch, issuedAt }
          : null;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError([error, rollback], "PG writer epoch operation and rollback failed");
        }
        throw error;
      } finally {
        if (!retained) client.release();
      }
    },
    async close() {
      if (!held) return;
      const client = held;
      held = null;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}
