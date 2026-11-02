import type { PoolClient } from "pg";
import type { PostgresEventStoreScope } from "./pg-event-store.ts";
import type { ReplicationPosition } from "../store/replication-log.ts";
import {
  assertReplicationAcknowledgement,
  type ReplicationSlotLease,
  type ReplicationAcknowledgement,
} from "../replication-slot-contract.ts";

export async function pgSlotOperation(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  input: { method: string; args: readonly unknown[] },
): Promise<unknown> {
  const keys = [scope.tenantId, scope.projectId, repoId],
    where = "tenant_id=$1 AND project_id=$2 AND repo_id=$3",
    row = async (nodeId: string, lock = false) =>
      (
        await client.query<{ fence: string; history: string; ack: string | null; acked_at: string | null }>(
          `SELECT fence,history,ack,acked_at FROM ha_replication_slots WHERE ${where} AND node_id=$4${lock ? " FOR UPDATE" : ""}`,
          [...keys, nodeId],
        )
      ).rows[0];
  switch (input.method) {
    case "claim": {
      const [key, history] = input.args as [{ nodeId: string }, string],
        result = (
          await client.query<{ fence: string }>(
            `INSERT INTO ha_replication_slots(tenant_id,project_id,repo_id,node_id,fence,history,readers,policy_epoch) VALUES($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT(tenant_id,project_id,repo_id,node_id) DO UPDATE SET fence=ha_replication_slots.fence+1,history=EXCLUDED.history,ack=CASE WHEN ha_replication_slots.history=EXCLUDED.history THEN ha_replication_slots.ack ELSE NULL END,acked_at=CASE WHEN ha_replication_slots.history=EXCLUDED.history THEN ha_replication_slots.acked_at ELSE NULL END RETURNING fence`,
            [...keys, key.nodeId, history, scope.readers, scope.policyEpoch],
          )
        ).rows[0]!;
      return { repoId, nodeId: key.nodeId, history, fence: Number(result.fence) };
    }
    case "current": {
      const [lease] = input.args as [ReplicationSlotLease],
        found = await row(lease.nodeId);
      return found !== undefined && Number(found.fence) === lease.fence && found.history === lease.history;
    }
    case "cursor": {
      const [key] = input.args as [{ nodeId: string }],
        found = await row(key.nodeId);
      return found?.ack == null ? null : JSON.parse(found.ack);
    }
    case "acknowledge": {
      const [lease, ack, sent] = input.args as [ReplicationSlotLease, ReplicationAcknowledgement, ReplicationPosition],
        found = await row(lease.nodeId, true);
      assertReplicationAcknowledgement(
        lease,
        ack,
        sent,
        found !== undefined && Number(found.fence) === lease.fence && found.history === lease.history,
        found?.ack == null ? null : (JSON.parse(found.ack) as ReplicationAcknowledgement),
      );
      await client.query(`UPDATE ha_replication_slots SET ack=$5,acked_at=$6 WHERE ${where} AND node_id=$4`, [
        ...keys,
        lease.nodeId,
        JSON.stringify(ack),
        new Date().toISOString(),
      ]);
      return null;
    }
    case "minimumAck": {
      const value = (
        await client.query<{ floor: string | null }>(
          `SELECT MIN((ack::jsonb#>>'{durable,sequence}')::bigint) AS floor FROM ha_replication_slots WHERE ${where} AND history=$4 AND ack IS NOT NULL`,
          [...keys, input.args[1]],
        )
      ).rows[0]!.floor;
      return value === null ? null : Number(value);
    }
    case "removeNode":
      await client.query(`DELETE FROM ha_replication_slots WHERE ${where} AND node_id=$4`, [...keys, input.args[0]]);
      return null;
    case "invalidateOffline":
      await client.query(`UPDATE ha_replication_slots SET fence=fence+1,ack=NULL,acked_at=NULL WHERE ${where}`, keys);
      return null;
    case "list":
      return (
        await client.query<{ node_id: string; history: string; ack: string | null; acked_at: string | null }>(
          `SELECT node_id,history,ack,acked_at FROM ha_replication_slots WHERE ${where} ORDER BY node_id`,
          keys,
        )
      ).rows.map((value) => ({
        repoId,
        nodeId: value.node_id,
        history: value.history,
        ack: value.ack === null ? null : JSON.parse(value.ack),
        ackedAt: value.acked_at,
      }));
    default:
      throw new Error(`Unknown replication slot operation: ${input.method}`);
  }
}
