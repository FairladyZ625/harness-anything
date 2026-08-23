import { type WriteReceipt } from "../../../kernel/src/index.ts";
import type { FleetReplicaStatus } from "./center-types.ts";
import { FLEET_KEY_SEND_WINDOW_BYTES, FLEET_SESSION_SEND_WINDOW_BYTES } from "./contract.ts";
import { type ReplicaAckStore, type ReplicaDeliveryKey } from "./replica-ack-store.ts";
import type { ReplicaCutSource } from "./replica-cut-store.ts";

export function deriveReplicaReceipt(
  replica: ReplicaCutSource,
  ackStore: ReplicaAckStore,
  key: ReplicaDeliveryKey,
  opId: string,
): WriteReceipt {
  const basis = replica.receiptBasis(opId),
    reject = (code: string, nextAction: string): WriteReceipt => ({
      outcome: "op_rejected",
      opId,
      code,
      origin: "fleet-replica",
      evidence: `replica:${key.repoId}:${key.viewId}`,
      nextAction,
    });
  if (!basis) return reject("operation_not_published", "Query the center receipt or retry after publication.");
  const revision = basis.event.workspaceRevision,
    canonicalVisible = basis.event.opId === opId && revision > 0,
    registration = ackStore.registrationRevision(key);
  if (registration === null || revision <= registration)
    return reject(
      "replica_not_registered_at_revision",
      "Use the center receipt; this view did not subscribe at that revision.",
    );
  const cut = replica.cut(revision),
    proof = cut && ackStore.proof(key, revision),
    base = {
      opId,
      revision,
      visibility: { kind: "replica" as const, viewId: key.viewId },
      evidence: `event-object:${opId};replica-cut:${revision}`,
    };
  if (
    canonicalVisible &&
    basis.applied &&
    cut &&
    proof &&
    proof.headDigest === cut.headDigest &&
    proof.manifestDigest === cut.manifest.digest
  )
    return {
      outcome: "applied",
      ...base,
      proof: {
        committedRevision: revision,
        appliedCut: revision,
        ackCut: revision,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: canonicalVisible,
      },
    };
  return {
    outcome: "pending",
    ...base,
    proof: {
      committedRevision: revision,
      appliedCut: basis.applied ? revision : 0,
      durable: canonicalVisible,
      canonicalVisible,
      worktreeVisible: false,
    },
    nextAction: "Pull and ACK the exact replica cut, then retry this opId query.",
  };
}

export function replicaStatus(
  replica: ReplicaCutSource,
  ackStore: ReplicaAckStore,
  key: ReplicaDeliveryKey,
  diskQuotaBytes: number | null,
): FleetReplicaStatus {
  const latest = replica.latest(),
    cursor = ackStore.cursor(key);
  if (!latest)
    return {
      ...key,
      centerRevision: 0,
      centerEventAt: null,
      centerManifestBytes: 0,
      ackRevision: cursor?.revision ?? null,
      ackCutEventAt: cursor?.cutEventAt ?? null,
      ackedAt: cursor?.ackedAt ?? null,
      lagRevisions: 0,
      lagMs: null,
      catchUpBytes: 0,
      delivery: "degraded",
      activeTransfers: ackStore.offerFor(key) ? 1 : 0,
      sendWindowBytes: FLEET_KEY_SEND_WINDOW_BYTES,
      sendQuotaBytes: FLEET_SESSION_SEND_WINDOW_BYTES,
      diskQuotaBytes,
    };
  const changes = cursor && replica.changes(cursor.revision, latest.revision),
    current = cursor?.revision === latest.revision,
    centerEventAt = replica.eventAt(latest.revision),
    ackCutEventAt = cursor?.cutEventAt ?? null,
    catchUpBytes = current
      ? 0
      : changes
        ? changes.reduce((sum, change) => sum + (change.op === "put" ? change.blob.size : 0), 0)
        : latest.manifest.totalBytes;
  return {
    ...key,
    centerRevision: latest.revision,
    centerEventAt,
    centerManifestBytes: latest.manifest.totalBytes,
    ackRevision: cursor?.revision ?? null,
    ackCutEventAt,
    ackedAt: cursor?.ackedAt ?? null,
    lagRevisions: Math.max(0, latest.revision - (cursor?.revision ?? 0)),
    lagMs: centerEventAt && ackCutEventAt ? Math.max(0, Date.parse(centerEventAt) - Date.parse(ackCutEventAt)) : null,
    catchUpBytes,
    delivery: current ? "current" : changes ? "delta" : "snapshot_required",
    activeTransfers: ackStore.offerFor(key) ? 1 : 0,
    sendWindowBytes: FLEET_KEY_SEND_WINDOW_BYTES,
    sendQuotaBytes: FLEET_SESSION_SEND_WINDOW_BYTES,
    diskQuotaBytes,
  };
}
