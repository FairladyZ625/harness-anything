import type { DatabaseSync } from "node:sqlite";
import type { ReplicaDeliveryKey } from "./replica-ack-store.ts";

export interface ReplicaDeliveryLease extends ReplicaDeliveryKey {
  readonly holderId: string;
  readonly claimFence: number;
  readonly expiresAt: number;
}
export interface ReplicaTransferMetrics {
  readonly transferBytes: number;
  readonly snapshotStarts: number;
  readonly deltaStarts: number;
  readonly errors: number;
  readonly lastFailureCode: string | null;
}

/** Transport coordination lives beside ACKs, never in the canonical writer queue. */
export function replicaDeliveryLeases(database: (repoId: string) => DatabaseSync) {
  const initialized = new WeakSet<DatabaseSync>();
  const db = (key: ReplicaDeliveryKey) => {
    const store = database(key.repoId);
    if (!initialized.has(store)) {
      store.exec(`CREATE TABLE IF NOT EXISTS delivery_lease (
        node_id TEXT PRIMARY KEY, view_id TEXT NOT NULL, holder_id TEXT,
        claim_fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ); CREATE TABLE IF NOT EXISTS delivery_metrics (
        node_id TEXT NOT NULL, view_id TEXT NOT NULL, transfer_bytes INTEGER NOT NULL DEFAULT 0,
        snapshot_starts INTEGER NOT NULL DEFAULT 0, delta_starts INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0, last_failure_code TEXT, PRIMARY KEY(node_id,view_id)
      );`);
      initialized.add(store);
    }
    return store;
  };
  const active = (key: ReplicaDeliveryKey, now: number): ReplicaDeliveryLease | null => {
    const row = db(key)
      .prepare("SELECT * FROM delivery_lease WHERE node_id=? AND holder_id IS NOT NULL AND expires_at>?")
      .get(key.nodeId, now);
    return row
      ? {
          repoId: key.repoId,
          nodeId: key.nodeId,
          viewId: String(row.view_id),
          holderId: String(row.holder_id),
          claimFence: Number(row.claim_fence),
          expiresAt: Number(row.expires_at),
        }
      : null;
  };
  const claim = (
    key: ReplicaDeliveryKey,
    holderId: string,
    now: number,
    ttlMs: number,
  ): ReplicaDeliveryLease | null => {
    if (!holderId || !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new Error("Invalid delivery lease claim");
    const store = db(key);
    store.exec("BEGIN IMMEDIATE");
    try {
      const held = active(key, now);
      if (held) {
        store.exec("COMMIT");
        return held.holderId === holderId && held.viewId === key.viewId ? held : null;
      }
      const row = store.prepare("SELECT claim_fence FROM delivery_lease WHERE node_id=?").get(key.nodeId);
      const lease = { ...key, holderId, claimFence: Number(row?.claim_fence ?? 0) + 1, expiresAt: now + ttlMs };
      store
        .prepare("INSERT OR REPLACE INTO delivery_lease VALUES(?,?,?,?,?)")
        .run(key.nodeId, key.viewId, holderId, lease.claimFence, lease.expiresAt);
      store.exec("COMMIT");
      return lease;
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  };
  const renew = (lease: ReplicaDeliveryLease, now: number, ttlMs: number): boolean =>
    Number(
      db(lease)
        .prepare(
          "UPDATE delivery_lease SET expires_at=? WHERE node_id=? AND view_id=? AND holder_id=? AND claim_fence=? AND expires_at>?",
        )
        .run(now + ttlMs, lease.nodeId, lease.viewId, lease.holderId, lease.claimFence, now).changes,
    ) === 1;
  const release = (lease: ReplicaDeliveryLease): void => {
    db(lease)
      .prepare(
        "UPDATE delivery_lease SET holder_id=NULL, expires_at=0 WHERE node_id=? AND view_id=? AND holder_id=? AND claim_fence=?",
      )
      .run(lease.nodeId, lease.viewId, lease.holderId, lease.claimFence);
  };
  const record = (
    key: ReplicaDeliveryKey,
    change: { readonly bytes?: number; readonly started?: "snapshot" | "delta"; readonly failureCode?: string },
  ): void => {
    const store = db(key);
    store.prepare("INSERT OR IGNORE INTO delivery_metrics(node_id,view_id) VALUES(?,?)").run(key.nodeId, key.viewId);
    store
      .prepare(
        "UPDATE delivery_metrics SET transfer_bytes=transfer_bytes+?, snapshot_starts=snapshot_starts+?, delta_starts=delta_starts+?, errors=errors+?, last_failure_code=COALESCE(?,last_failure_code) WHERE node_id=? AND view_id=?",
      )
      .run(
        change.bytes ?? 0,
        change.started === "snapshot" ? 1 : 0,
        change.started === "delta" ? 1 : 0,
        change.failureCode ? 1 : 0,
        change.failureCode ?? null,
        key.nodeId,
        key.viewId,
      );
  };
  const metrics = (key: ReplicaDeliveryKey): ReplicaTransferMetrics => {
    const row = db(key)
      .prepare("SELECT * FROM delivery_metrics WHERE node_id=? AND view_id=?")
      .get(key.nodeId, key.viewId);
    return {
      transferBytes: Number(row?.transfer_bytes ?? 0),
      snapshotStarts: Number(row?.snapshot_starts ?? 0),
      deltaStarts: Number(row?.delta_starts ?? 0),
      errors: Number(row?.errors ?? 0),
      lastFailureCode: typeof row?.last_failure_code === "string" ? row.last_failure_code : null,
    };
  };
  return { active, claim, renew, release, record, metrics };
}
