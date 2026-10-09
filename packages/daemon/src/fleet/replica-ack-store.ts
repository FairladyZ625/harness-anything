import { READ_MODEL_SCHEMA_GENERATION, consumeKnownError } from "@harness-anything/kernel";
import { type ReplicaDeliveryLease, replicaDeliveryLeases } from "./replica-delivery-lease.ts";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FleetCut } from "./contract.ts";

export interface ReplicaDeliveryKey {
  readonly nodeId: string;
  readonly viewId: string;
  readonly repoId: string;
}
export interface ReplicaOffer extends ReplicaDeliveryKey {
  readonly transferId: string;
  readonly fromCut: FleetCut | null;
  readonly toCut: FleetCut;
  readonly manifestDigest: string;
  readonly kind: "snapshot" | "delta";
  readonly issuedAt: string;
}
export interface ReplicaAckProof extends ReplicaDeliveryKey {
  readonly revision: number;
  readonly headDigest: string;
  readonly schemaGeneration: number;
  readonly manifestDigest: string;
  readonly transferId: string;
  readonly ackedAt: string;
  readonly cutEventAt: string;
}
export interface ReplicaAckStore {
  readonly delivery: ReturnType<typeof replicaDeliveryLeases>;
  readonly register: (key: ReplicaDeliveryKey, revision: number) => number;
  readonly registrationRevision: (key: ReplicaDeliveryKey) => number | null;
  readonly offer: (key: ReplicaDeliveryKey, input: Omit<ReplicaOffer, keyof ReplicaDeliveryKey>) => ReplicaOffer;
  readonly offerFor: (key: ReplicaDeliveryKey) => ReplicaOffer | null;
  readonly clearOffer: (key: ReplicaDeliveryLease) => void;
  readonly ack: (
    key: ReplicaDeliveryKey,
    transferId: string,
    cut: FleetCut,
    manifestDigest: string,
    ackedAt: string,
    cutEventAt: string,
    lease: ReplicaDeliveryLease,
  ) => { readonly outcome: "applied" | "current" | "op_rejected"; readonly cursor: ReplicaAckProof | null };
  readonly cursor: (key: ReplicaDeliveryKey) => ReplicaAckProof | null;
  readonly proof: (key: ReplicaDeliveryKey, revision: number) => ReplicaAckProof | null;
  readonly keys: () => readonly ReplicaDeliveryKey[];
  readonly close: () => void;
}

export function openReplicaAckStore(rootDir: string): ReplicaAckStore {
  const databases = new Map<string, DatabaseSync>(),
    proofTable = `ack_proof_wire_g${READ_MODEL_SCHEMA_GENERATION}`,
    cursorTable = `ack_cursor_wire_g${READ_MODEL_SCHEMA_GENERATION}`,
    offerTable = `active_offer_wire_g${READ_MODEL_SCHEMA_GENERATION}`,
    transferIndex = `ack_transfer_wire_g${READ_MODEL_SCHEMA_GENERATION}`,
    valid = (value: string) => {
      if (!/^[A-Za-z0-9_-]{1,96}$/u.test(value)) throw new Error("replica delivery key is invalid");
      return value;
    },
    db = (repoId: string) => {
      const id = valid(repoId),
        found = databases.get(id);
      if (found) return found;
      const root = path.join(rootDir, "replica", "repos", id);
      mkdirSync(root, { recursive: true });
      const store = new DatabaseSync(path.join(root, "ack.sqlite"));
      // The cut worker claims leases while the listener writes registrations and ACKs. Wait for that short SQLite writer lock.
      // Registration and delivery leases are shared; proof/cursor/offer belong to this schema generation.
      store.exec(
        `PRAGMA busy_timeout=5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS registration(node_id TEXT NOT NULL, view_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(node_id,view_id)); CREATE TABLE IF NOT EXISTS ${proofTable}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,revision INTEGER NOT NULL,head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,transfer_id TEXT NOT NULL,acked_at TEXT NOT NULL,cut_event_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id,revision)); CREATE UNIQUE INDEX IF NOT EXISTS ${transferIndex} ON ${proofTable}(transfer_id); CREATE TABLE IF NOT EXISTS ${cursorTable}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,revision INTEGER NOT NULL,head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,transfer_id TEXT NOT NULL,acked_at TEXT NOT NULL,cut_event_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id)); CREATE TABLE IF NOT EXISTS ${offerTable}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,transfer_id TEXT NOT NULL UNIQUE,from_revision INTEGER,from_head_digest TEXT,to_revision INTEGER NOT NULL,to_head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,kind TEXT NOT NULL,issued_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id));`,
      );
      databases.set(id, store);
      return store;
    };
  const check = (key: ReplicaDeliveryKey) => {
      valid(key.nodeId);
      valid(key.viewId);
      return db(key.repoId);
    },
    proofFrom = (key: ReplicaDeliveryKey, row: Record<string, unknown> | undefined): ReplicaAckProof | null =>
      row
        ? {
            ...key,
            revision: Number(row.revision),
            headDigest: String(row.head_digest),
            schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
            manifestDigest: String(row.manifest_digest),
            transferId: String(row.transfer_id),
            ackedAt: String(row.acked_at),
            cutEventAt: String(row.cut_event_at),
          }
        : null;
  const registrationRevision = (key: ReplicaDeliveryKey) => {
    const row = check(key)
      .prepare("SELECT revision FROM registration WHERE node_id=? AND view_id=?")
      .get(key.nodeId, key.viewId) as { revision: number } | undefined;
    return row?.revision ?? null;
  };
  const register = (key: ReplicaDeliveryKey, revision: number) => {
    const store = check(key);
    store.prepare("INSERT OR IGNORE INTO registration VALUES(?,?,?)").run(key.nodeId, key.viewId, revision);
    return registrationRevision(key)!;
  };
  const cursor = (key: ReplicaDeliveryKey) =>
      proofFrom(
        key,
        check(key).prepare(`SELECT * FROM ${cursorTable} WHERE node_id=? AND view_id=?`).get(key.nodeId, key.viewId) as
          | Record<string, unknown>
          | undefined,
      ),
    proof = (key: ReplicaDeliveryKey, revision: number) =>
      proofFrom(
        key,
        check(key)
          .prepare(`SELECT * FROM ${proofTable} WHERE node_id=? AND view_id=? AND revision=?`)
          .get(key.nodeId, key.viewId, revision) as Record<string, unknown> | undefined,
      );
  const offerFrom = (key: ReplicaDeliveryKey, row: Record<string, unknown> | undefined): ReplicaOffer | null =>
      row
        ? {
            ...key,
            transferId: String(row.transfer_id),
            fromCut:
              row.from_revision === null
                ? null
                : {
                    revision: Number(row.from_revision),
                    headDigest: String(row.from_head_digest),
                    schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
                  },
            toCut: {
              revision: Number(row.to_revision),
              headDigest: String(row.to_head_digest),
              schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
            },
            manifestDigest: String(row.manifest_digest),
            kind: String(row.kind) as "snapshot" | "delta",
            issuedAt: String(row.issued_at),
          }
        : null,
    offerFor = (key: ReplicaDeliveryKey) =>
      offerFrom(
        key,
        check(key).prepare(`SELECT * FROM ${offerTable} WHERE node_id=? AND view_id=?`).get(key.nodeId, key.viewId) as
          | Record<string, unknown>
          | undefined,
      );
  const offer = (key: ReplicaDeliveryKey, input: Omit<ReplicaOffer, keyof ReplicaDeliveryKey>) => {
      if (
        input.toCut.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION ||
        (input.fromCut !== null && input.fromCut.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION)
      )
        throw new Error("replica offer schema generation is not current");
      const store = check(key),
        existing = offerFor(key);
      if (existing) return existing;
      store
        .prepare(`INSERT INTO ${offerTable} VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(
          key.nodeId,
          key.viewId,
          input.transferId,
          input.fromCut?.revision ?? null,
          input.fromCut?.headDigest ?? null,
          input.toCut.revision,
          input.toCut.headDigest,
          input.manifestDigest,
          input.kind,
          input.issuedAt,
        );
      return { ...key, ...input };
    },
    clearOffer = (key: ReplicaDeliveryLease) => {
      check(key)
        .prepare(
          `DELETE FROM ${offerTable} WHERE node_id=? AND view_id=? AND EXISTS (SELECT 1 FROM delivery_lease WHERE node_id=? AND view_id=? AND holder_id=? AND claim_fence=?)`,
        )
        .run(key.nodeId, key.viewId, key.nodeId, key.viewId, key.holderId, key.claimFence);
    };
  const delivery = replicaDeliveryLeases(db);
  const ackAtCut = (
    key: ReplicaDeliveryKey,
    transferId: string,
    cut: FleetCut,
    digest: string,
    ackedAt: string,
    cutEventAt: string,
  ) => {
    const store = check(key),
      priorProof = store.prepare(`SELECT * FROM ${proofTable} WHERE transfer_id=?`).get(transferId) as
        | Record<string, unknown>
        | undefined;
    if (cut.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION) return { outcome: "op_rejected" as const, cursor: null };
    if (priorProof) {
      const exact =
        Number(priorProof.revision) === cut.revision &&
        priorProof.head_digest === cut.headDigest &&
        priorProof.manifest_digest === digest &&
        priorProof.node_id === key.nodeId &&
        priorProof.view_id === key.viewId;
      return { outcome: exact ? ("current" as const) : ("op_rejected" as const), cursor: exact ? cursor(key) : null };
    }
    const active = offerFor(key);
    if (
      !active ||
      active.transferId !== transferId ||
      active.toCut.revision !== cut.revision ||
      active.toCut.headDigest !== cut.headDigest ||
      active.manifestDigest !== digest
    )
      return { outcome: "op_rejected" as const, cursor: null };
    const prior = cursor(key);
    if (prior) {
      if (cut.revision < prior.revision) return { outcome: "current" as const, cursor: prior };
      if (cut.revision === prior.revision) {
        // A re-delivered transfer to an already-ACKed revision converges only as the same
        // cut; the recorded proof keeps the first transfer's identity and timestamps.
        if (cut.headDigest !== prior.headDigest || digest !== prior.manifestDigest)
          return { outcome: "op_rejected" as const, cursor: null };
        store.prepare(`DELETE FROM ${offerTable} WHERE node_id=? AND view_id=?`).run(key.nodeId, key.viewId);
        return { outcome: "current" as const, cursor: prior };
      }
    }
    store
      .prepare(`INSERT INTO ${proofTable} VALUES(?,?,?,?,?,?,?,?)`)
      .run(key.nodeId, key.viewId, cut.revision, cut.headDigest, digest, transferId, ackedAt, cutEventAt);
    store
      .prepare(
        `INSERT INTO ${cursorTable} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id,view_id) DO UPDATE SET revision=excluded.revision,head_digest=excluded.head_digest,manifest_digest=excluded.manifest_digest,transfer_id=excluded.transfer_id,acked_at=excluded.acked_at,cut_event_at=excluded.cut_event_at WHERE excluded.revision>${cursorTable}.revision`,
      )
      .run(key.nodeId, key.viewId, cut.revision, cut.headDigest, digest, transferId, ackedAt, cutEventAt);
    store.prepare(`DELETE FROM ${offerTable} WHERE node_id=? AND view_id=?`).run(key.nodeId, key.viewId);
    return { outcome: "applied" as const, cursor: cursor(key) };
  };
  const ack: ReplicaAckStore["ack"] = (key, transferId, cut, digest, ackedAt, cutEventAt, lease) => {
    const store = check(key);
    // Lease fencing and ACK advancement share this transport-only SQLite transaction.
    store.exec("BEGIN IMMEDIATE");
    try {
      const valid =
        key.nodeId === lease.nodeId &&
        key.repoId === lease.repoId &&
        key.viewId === lease.viewId &&
        delivery.renew(lease, Date.parse(ackedAt), 30_000).renewed;
      const result = valid
        ? ackAtCut(key, transferId, cut, digest, ackedAt, cutEventAt)
        : { outcome: "op_rejected" as const, cursor: null };
      // A node only ever advances ACKs for the view it pulls (one node, one repo, one view),
      // so a settled ACK proves that view usable and retires the node's other view rows in
      // this same transaction: frozen pre-S8 assignment rows would otherwise stay in
      // status()/fleet overview forever. A rejected ACK proves nothing and must not retire.
      if (result.outcome !== "op_rejected") {
        const tables = store.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
        for (const { name } of tables) {
          if (
            typeof name === "string" &&
            /^(?:registration|(?:ack_proof|ack_cursor|active_offer)(?:_wire)?(?:_g[0-9]+)?)$/u.test(name)
          )
            store.prepare(`DELETE FROM ${name} WHERE node_id=? AND view_id<>?`).run(key.nodeId, key.viewId);
        }
        delivery.retire(key);
      }
      store.exec("COMMIT");
      return result;
    } catch (error) {
      consumeKnownError(error);
      store.exec("ROLLBACK");
      throw error;
    }
  };
  const keys = () => {
    const root = path.join(rootDir, "replica", "repos");
    if (existsSync(root))
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory() && /^[A-Za-z0-9_-]{1,96}$/u.test(entry.name)) db(entry.name);
    return [...databases.entries()].flatMap(([repoId, store]) =>
      (
        store.prepare("SELECT node_id,view_id FROM registration").all() as unknown as readonly {
          node_id: string;
          view_id: string;
        }[]
      ).map((row) => ({ nodeId: row.node_id, viewId: row.view_id, repoId })),
    );
  };
  return {
    delivery,
    register,
    registrationRevision,
    offer,
    offerFor,
    clearOffer,
    ack,
    cursor,
    proof,
    keys,
    close: () => {
      for (const store of databases.values()) store.close();
      databases.clear();
    },
  };
}
