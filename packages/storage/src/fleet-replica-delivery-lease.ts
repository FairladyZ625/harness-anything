import type { DatabaseSync } from "node:sqlite";
import type { ReplicaDeliveryKey } from "./fleet-replication-slot.ts";

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
  const db = (key: Pick<ReplicaDeliveryKey, "repoId">) => {
    const store = database(key.repoId);
    if (!initialized.has(store)) {
      /* @gate-identity state-store/legacy.7199c724d75c312f */ store.exec(/* @gate-identity state-store/legacy.1a27069150365441 */ /* @gate-identity state-store/legacy.e814cd345c42d86e */ `CREATE TABLE IF NOT EXISTS delivery_lease (
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
    const row = /* @gate-identity state-store/legacy.00f2f4656979ca23 */ db(key)
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
    /* @gate-identity state-store/legacy.a4bcfef81c9c5567 */ store.exec("BEGIN IMMEDIATE");
    try {
      const held = active(key, now);
      if (held) {
        /* @gate-identity state-store/legacy.a7a3258f1aabb3f0 */ store.exec("COMMIT");
        return held.holderId === holderId && held.viewId === key.viewId ? held : null;
      }
      const row = /* @gate-identity state-store/legacy.72eba3d1791a9579 */ store
        .prepare("SELECT claim_fence FROM delivery_lease WHERE node_id=?")
        .get(key.nodeId);
      const lease = { ...key, holderId, claimFence: Number(row?.claim_fence ?? 0) + 1, expiresAt: now + ttlMs };
      /* @gate-identity state-store/legacy.f412d0088e2b1b55 */ store
        .prepare("INSERT OR REPLACE INTO delivery_lease VALUES(?,?,?,?,?)")
        .run(key.nodeId, key.viewId, holderId, lease.claimFence, lease.expiresAt);
      /* @gate-identity state-store/legacy.0064b4bba07934bd */ store.exec("COMMIT");
      return lease;
    } catch (error) {
      /* @gate-identity state-store/legacy.5a6e73574cd9ee17 */ store.exec("ROLLBACK");
      throw error;
    }
  };
  const renew = (lease: ReplicaDeliveryLease, now: number, ttlMs: number) => {
    const store = db(lease);
    // Keep rejection evidence under the UPDATE's writer lock; ACK already owns an outer transaction.
    /* @gate-identity state-store/legacy.c27ccf94ae88d5dd */ store.exec("SAVEPOINT delivery_renew");
    try {
      const renewed =
        Number(
          /* @gate-identity state-store/legacy.5055426917ee3ef6 */ store
            .prepare(
              "UPDATE delivery_lease SET expires_at=? WHERE node_id=? AND view_id=? AND holder_id=? AND claim_fence=? AND expires_at>?",
            )
            .run(now + ttlMs, lease.nodeId, lease.viewId, lease.holderId, lease.claimFence, now).changes,
        ) === 1;
      const result = renewed ? { renewed: true as const } : { renewed: false as const, evidence: inspect(lease, now) };
      /* @gate-identity state-store/legacy.64db951e32711f7f */ store.exec("RELEASE delivery_renew");
      return result;
    } catch (error) {
      /* @gate-identity state-store/legacy.6d9e7d5045be5346 */ store.exec(
        "ROLLBACK TO delivery_renew; RELEASE delivery_renew",
      );
      throw error;
    }
  };
  /** Failure evidence includes expired/released rows that active() deliberately filters out. */
  const inspect = (lease: ReplicaDeliveryLease, now: number) => {
    const row = /* @gate-identity state-store/legacy.b0bb3fba7cd092c5 */ db(lease)
      .prepare("SELECT * FROM delivery_lease WHERE node_id=?")
      .get(lease.nodeId);
    const current = row
      ? {
          viewId: String(row.view_id),
          holderId: row.holder_id === null ? null : String(row.holder_id),
          claimFence: Number(row.claim_fence),
          expiresAt: Number(row.expires_at),
        }
      : null;
    const state = !current
      ? "missing"
      : current.viewId !== lease.viewId || current.claimFence !== lease.claimFence
        ? "replaced"
        : current.holderId === null
          ? "released"
          : current.holderId !== lease.holderId
            ? "replaced"
            : current.expiresAt <= now
              ? "expired"
              : "active";
    return { now, state, current };
  };
  const release = (lease: ReplicaDeliveryLease): void => {
    /* @gate-identity state-store/legacy.7eb3ddcb5e775634 */ db(lease)
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
    /* @gate-identity state-store/legacy.60a1deb96f6db576 */ store
      .prepare("INSERT OR IGNORE INTO delivery_metrics(node_id,view_id) VALUES(?,?)")
      .run(key.nodeId, key.viewId);
    /* @gate-identity state-store/legacy.98a9d58235ec7711 */ store
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
    const row = /* @gate-identity state-store/legacy.e3289c3d16277b5f */ db(key)
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
  /** Retire the node's other views: their frozen lease/metrics rows must not outlive the view. */
  const retire = (key: ReplicaDeliveryKey): void => {
    const store = db(key);
    /* @gate-identity state-store/legacy.cc2ee61cce3814d4 */ store
      .prepare("DELETE FROM delivery_lease WHERE node_id=? AND view_id<>?")
      .run(key.nodeId, key.viewId);
    /* @gate-identity state-store/legacy.9430625265647de6 */ store
      .prepare("DELETE FROM delivery_metrics WHERE node_id=? AND view_id<>?")
      .run(key.nodeId, key.viewId);
  };
  // Retain the fence counter so the same holder/view cannot revive a pre-upgrade lease.
  const invalidateOffline = (repoId: string): void => {
    const store = db({ repoId });
    /* @gate-identity state-store/legacy.21cc88e08ef08365 */ store.exec(
      "UPDATE delivery_lease SET holder_id=NULL, expires_at=0, claim_fence=claim_fence+1; DELETE FROM delivery_metrics",
    );
  };
  return { active, claim, renew, inspect, release, record, metrics, retire, invalidateOffline };
}
