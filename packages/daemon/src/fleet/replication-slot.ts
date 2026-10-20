import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReplicationPosition } from "@harness-anything/kernel";

export interface ReplicationSlotKey {
  readonly repoId: string;
  readonly nodeId: string;
}
export const replicationSlotKey = (key: ReplicationSlotKey): string => `${key.nodeId}\u0000${key.repoId}`;
export interface ReplicaDeliveryKey extends ReplicationSlotKey {
  readonly viewId: string;
}
export interface ReplicationSlotLease extends ReplicationSlotKey {
  readonly fence: number;
  readonly history: string;
}
export interface ReplicationAcknowledgement {
  readonly durable: ReplicationPosition;
  readonly applied: ReplicationPosition;
}

/** Transport state only. A new authenticated session fences the previous node/repo sender. */
export function openReplicationSlots(file: string) {
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
      // sent is owned by this sender, never supplied by the remote ACK.
      if (
        ack.durable.history !== lease.history ||
        ack.applied.history !== lease.history ||
        sent.history !== lease.history ||
        ack.applied.sequence > ack.durable.sequence ||
        ack.durable.sequence > sent.sequence ||
        ack.applied.revision > ack.durable.revision ||
        ack.durable.revision > sent.revision
      )
        throw new Error("replication ACK exceeds sent position");
      const previous = row(lease);
      if (previous?.fence !== lease.fence || previous.history !== lease.history)
        throw new Error("replication session fenced");
      const prior = previous.ack == null ? null : (JSON.parse(String(previous.ack)) as ReplicationAcknowledgement);
      if (prior && (ack.durable.sequence < prior.durable.sequence || ack.applied.sequence < prior.applied.sequence))
        throw new Error("replication ACK regressed");
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

export type ReplicationSlots = ReturnType<typeof openReplicationSlots>;

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
