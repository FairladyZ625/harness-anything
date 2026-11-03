import type { ReplicationPosition } from "@harness-anything/storage";
import type { FleetReplicaStatus } from "./center-types.ts";
import { replicationSlotKey, type ReplicationSlotKey, type ReplicationSlots } from "@harness-anything/storage";

export type ReplicaSyncPhase =
  | "preparing_replica"
  | "authorizing"
  | "waiting_backup"
  | "backup_queued"
  | "building_backup"
  | "waiting_shared_backup"
  | "sending_backup"
  | "sending_commits"
  | "awaiting_ack"
  | "waiting_for_commit"
  | "waiting_socket_drain";
export interface ReplicaSyncActivity {
  readonly phase: ReplicaSyncPhase;
  readonly since: string;
  readonly lastProgressAt: string;
  readonly bytesSent: number | null;
  readonly totalBytes: number | null;
}

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
  readonly now?: () => string;
}) {
  const activity = new Map<string, ReplicaSyncActivity>();
  const failures = new Map<string, ReplicationSlotKey & { readonly failure: ReplicaSyncFailure }>();
  return {
    recordActivity(
      key: ReplicationSlotKey,
      phase: ReplicaSyncPhase,
      transfer?: { readonly bytesSent: number; readonly totalBytes: number },
    ): void {
      const id = replicationSlotKey(key),
        previous = activity.get(id),
        now = input.now?.() ?? new Date().toISOString();
      activity.set(id, {
        phase,
        since: previous?.phase === phase ? previous.since : now,
        lastProgressAt: now,
        bytesSent:
          transfer?.bytesSent ??
          (phase === "awaiting_ack" || phase === "waiting_socket_drain" ? (previous?.bytesSent ?? null) : null),
        totalBytes:
          transfer?.totalBytes ??
          (phase === "awaiting_ack" || phase === "waiting_socket_drain" ? (previous?.totalBytes ?? null) : null),
      });
    },
    clearActivity(key: ReplicationSlotKey): void {
      activity.delete(replicationSlotKey(key));
    },
    recordFailure(key: ReplicationSlotKey, failure: ReplicaSyncFailure): void {
      // A refused start may name an arbitrary repo. Keep only attached-repo keys, so retries
      // cannot turn this latest-state map into a history of unauthorised repository names.
      if (!input.attachedRepositories().has(key.repoId)) return;
      failures.set(replicationSlotKey(key), { ...key, failure });
    },
    clearFailure(key: ReplicationSlotKey): void {
      failures.delete(replicationSlotKey(key));
    },
    removeNode(nodeId: string): void {
      for (const key of activity.keys()) if (key.startsWith(`${nodeId}\0`)) activity.delete(key);
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
            activity: activity.get(replicationSlotKey(key)) ?? null,
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
          activity: activity.get(key) ?? null,
        });
      }
      return rows;
    },
  };
}
