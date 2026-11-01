import type { ReplicationPosition } from "@harness-anything/storage";
import type { FleetReplicaStatus } from "./center-types.ts";
import { replicationSlotKey, type ReplicationSlotKey, type ReplicationSlots } from "@harness-anything/storage";

export interface ReplicaSyncFailure {
  readonly code: string;
  readonly message: string;
}

export function createReplicaStatusTracker(input: {
  readonly slots: ReplicationSlots;
  readonly attachedRepositories: () => ReadonlySet<string>;
  readonly head: (repoId: string) => ReplicationPosition;
  readonly isConnected: (key: ReplicationSlotKey) => boolean;
  readonly diskQuotaBytes: number | null;
}) {
  const failures = new Map<string, ReplicationSlotKey & { readonly failure: ReplicaSyncFailure }>();
  return {
    recordFailure(key: ReplicationSlotKey, failure: ReplicaSyncFailure): void {
      failures.set(replicationSlotKey(key), { ...key, failure });
    },
    clearFailure(key: ReplicationSlotKey): void {
      failures.delete(replicationSlotKey(key));
    },
    removeNode(nodeId: string): void {
      for (const [key, record] of failures) if (record.nodeId === nodeId) failures.delete(key);
    },
    snapshot(): FleetReplicaStatus[] {
      const attached = input.attachedRepositories(),
        heads = new Map<string, ReplicationPosition>(),
        head = (repoId: string) => {
          if (!heads.has(repoId)) heads.set(repoId, input.head(repoId));
          return heads.get(repoId)!;
        },
        now = Date.now();
      const rows = input.slots.list().flatMap((slot): FleetReplicaStatus[] => {
        if (!attached.has(slot.repoId)) return [];
        const center = head(slot.repoId),
          key = { nodeId: slot.nodeId, repoId: slot.repoId },
          failure = failures.get(replicationSlotKey(key))?.failure,
          ack = slot.history === center.history ? slot.ack : null,
          ackSequence = ack?.durable.sequence ?? null,
          lagCommits = ackSequence === null ? null : Math.max(0, center.sequence - ackSequence),
          ackedAt = ack === null ? null : slot.ackedAt;
        return [
          {
            ...key,
            viewId: slot.nodeId,
            centerRevision: center.revision,
            centerSequence: center.sequence,
            ackRevision: ack?.durable.revision ?? null,
            ackSequence,
            ackedAt,
            lagRevisions: Math.max(0, center.revision - (ack?.durable.revision ?? 0)),
            lagCommits,
            lagMs: lagCommits === 0 ? 0 : ackedAt === null ? null : Math.max(0, now - Date.parse(ackedAt)),
            connected: input.isConnected(key) && failure === undefined,
            delivery: lagCommits === null ? "snapshot_required" : lagCommits === 0 ? "current" : "delta",
            diskQuotaBytes: input.diskQuotaBytes,
            syncFailure: failure ?? null,
          },
        ];
      });
      const rowKeys = new Set(rows.map((row) => replicationSlotKey(row)));
      for (const [key, record] of failures) {
        if (!attached.has(record.repoId) || rowKeys.has(key)) continue;
        const center = head(record.repoId);
        rows.push({
          repoId: record.repoId,
          nodeId: record.nodeId,
          viewId: record.nodeId,
          centerRevision: center.revision,
          centerSequence: center.sequence,
          ackRevision: null,
          ackSequence: null,
          ackedAt: null,
          lagRevisions: center.revision,
          lagCommits: null,
          lagMs: null,
          connected: false,
          delivery: "snapshot_required",
          diskQuotaBytes: input.diskQuotaBytes,
          syncFailure: record.failure,
        });
      }
      return rows;
    },
  };
}
