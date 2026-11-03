import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReplicationPosition } from "./store/replication-log.ts";

export { replicationSlotKey } from "./replication-slot-contract.ts";
export type {
  ReplicationSlotKey,
  ReplicaDeliveryKey,
  ReplicationSlotLease,
  ReplicationAcknowledgement,
} from "./replication-slot-contract.ts";
import type {
  ReplicationSlotKey,
  ReplicationSlotLease,
  ReplicationAcknowledgement,
} from "./replication-slot-contract.ts";
import { assertReplicationAcknowledgement } from "./replication-slot-contract.ts";
import { openPgReplicationSlots } from "./postgres/pg-slot-client.ts";
import type { StorageBackendConfig } from "./storage-backend.ts";
import { existsSync } from "node:fs";
/** Transport state only. A new authenticated session fences the previous node/repo sender. */
function openSqliteReplicationSlots(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS replication_slot (
      repo TEXT NOT NULL, node TEXT NOT NULL, fence INTEGER NOT NULL,
      history TEXT NOT NULL, ack TEXT, acked_at TEXT, PRIMARY KEY(repo,node)
    ) STRICT`);
  const row = (key: ReplicationSlotKey) =>
    db.prepare("SELECT * FROM replication_slot WHERE repo=? AND node=?").get(key.repoId, key.nodeId);
  const current = (lease: ReplicationSlotLease): boolean => {
    const value = row(lease);
    return value?.fence === lease.fence && value.history === lease.history;
  };
  return {
    claim(key: ReplicationSlotKey, history: string): ReplicationSlotLease {
      const value = db
        .prepare(
          `INSERT INTO replication_slot VALUES(?,?,1,?,NULL,NULL)
        ON CONFLICT(repo,node) DO UPDATE SET fence=fence+1, history=excluded.history,
        ack=CASE WHEN history=excluded.history THEN ack ELSE NULL END,
        acked_at=CASE WHEN history=excluded.history THEN acked_at ELSE NULL END RETURNING fence`,
        )
        .get(key.repoId, key.nodeId, history)!;
      return { ...key, history, fence: Number(value.fence) };
    },
    current,
    cursor(key: ReplicationSlotKey): ReplicationAcknowledgement | null {
      const value = row(key);
      return value?.ack == null ? null : (JSON.parse(String(value.ack)) as ReplicationAcknowledgement);
    },
    acknowledge(lease: ReplicationSlotLease, ack: ReplicationAcknowledgement, sent: ReplicationPosition): void {
      const previous = row(lease),
        prior = previous?.ack == null ? null : (JSON.parse(String(previous.ack)) as ReplicationAcknowledgement);
      assertReplicationAcknowledgement(
        lease,
        ack,
        sent,
        previous?.fence === lease.fence && previous.history === lease.history,
        prior,
      );
      const result = db
        .prepare("UPDATE replication_slot SET ack=?, acked_at=? WHERE repo=? AND node=? AND fence=? AND history=?")
        .run(
          JSON.stringify({ durable: ack.durable, applied: ack.applied }),
          new Date().toISOString(),
          lease.repoId,
          lease.nodeId,
          lease.fence,
          lease.history,
        );
      if (result.changes !== 1) throw new Error("replication session fenced");
    },
    /** The slowest durable ACK on this history: the log must keep every commit after it. */
    minimumAck(repoId: string, history: string): number | null {
      const value = db
        .prepare(
          "SELECT MIN(json_extract(ack, '$.durable.sequence')) AS floor FROM replication_slot WHERE repo=? AND history=? AND ack IS NOT NULL",
        )
        .get(repoId, history);
      return value?.floor == null ? null : Number(value.floor);
    },
    /** Node retirement removes every repository slot and fences all outstanding slot leases. */
    removeNode(nodeId: string): void {
      db.prepare("DELETE FROM replication_slot WHERE node=?").run(nodeId);
    },
    invalidateOffline(repoId: string): void {
      db.prepare("UPDATE replication_slot SET fence=fence+1, ack=NULL, acked_at=NULL WHERE repo=?").run(repoId);
    },
    /** Every slot's last durable ACK, for the center's replica status. */
    list(): readonly (ReplicationSlotKey & {
      readonly history: string;
      readonly ack: ReplicationAcknowledgement | null;
      readonly ackedAt: string | null;
    })[] {
      return db
        .prepare("SELECT repo, node, history, ack, acked_at FROM replication_slot ORDER BY repo, node")
        .all()
        .map((value) => ({
          repoId: String(value.repo),
          nodeId: String(value.node),
          history: String(value.history),
          ack: value.ack == null ? null : (JSON.parse(String(value.ack)) as ReplicationAcknowledgement),
          ackedAt: value.acked_at == null ? null : String(value.acked_at),
        }));
    },
    close: () => db.close(),
  };
}

export type ReplicationSlots = ReturnType<typeof openSqliteReplicationSlots>;

export function openReplicationSlots(
  file: string,
  storageByRepo?: Readonly<Record<string, StorageBackendConfig>>,
): ReplicationSlots {
  if (!storageByRepo || !Object.values(storageByRepo).some((storage) => storage.backend === "postgres"))
    return openSqliteReplicationSlots(file);
  let local: ReplicationSlots | undefined;
  const stores = new Map<string, ReplicationSlots>(),
    forRepo = (repoId: string): ReplicationSlots => {
      const storage = storageByRepo[repoId];
      if (storage?.backend !== "postgres") return (local ??= openSqliteReplicationSlots(file));
      let slots = stores.get(repoId);
      if (!slots) {
        slots = openPgReplicationSlots(repoId, storage);
        stores.set(repoId, slots);
      }
      return slots;
    },
    all = () => {
      for (const [repoId, storage] of Object.entries(storageByRepo))
        if (storage.backend === "postgres") forRepo(repoId);
      if (existsSync(file)) local ??= openSqliteReplicationSlots(file);
      return [...new Set([...(local ? [local] : []), ...stores.values()])];
    };
  return {
    claim: (key, history) => forRepo(key.repoId).claim(key, history),
    current: (lease) => forRepo(lease.repoId).current(lease),
    cursor: (key) => forRepo(key.repoId).cursor(key),
    acknowledge: (lease, ack, sent) => forRepo(lease.repoId).acknowledge(lease, ack, sent),
    minimumAck: (repoId, history) => forRepo(repoId).minimumAck(repoId, history),
    removeNode: (nodeId) => {
      for (const store of all()) store.removeNode(nodeId);
    },
    invalidateOffline: (repoId) => forRepo(repoId).invalidateOffline(repoId),
    list: () => all().flatMap((store) => store.list()),
    close: () => {
      local?.close();
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}

/**
 * Replication-log retention, after PostgreSQL slots: keep every commit after the slowest slot's ACK,
 * but never more than `windowCommits` behind the head (max_slot_wal_keep_size); a slot beyond that cap
 * is answered with resync. An active base backup pins its start until the replica acknowledges it.
 */
export function createReplicationRetention(input: {
  readonly windowCommits: number;
  readonly slotFloor: (head: ReplicationPosition) => number | null;
  readonly prune: (beforeSequence: number) => void | Promise<void>;
}) {
  const pins = new Set<{ readonly position: ReplicationPosition }>();
  return {
    pin(position: ReplicationPosition): () => void {
      const pin = { position };
      pins.add(pin);
      return () => {
        pins.delete(pin);
      };
    },
    async advance(head: ReplicationPosition): Promise<void> {
      let before = Math.max(head.sequence - input.windowCommits, input.slotFloor(head) ?? head.sequence, 0);
      for (const { position } of pins)
        if (position.history === head.history) before = Math.min(before, position.sequence);
      await input.prune(before);
    },
  };
}
