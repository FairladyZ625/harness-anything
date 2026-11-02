import type { ReplicationPosition } from "./store/replication-log.ts";
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

export function assertReplicationAcknowledgement(
  lease: ReplicationSlotLease,
  ack: ReplicationAcknowledgement,
  sent: ReplicationPosition,
  current: boolean,
  prior: ReplicationAcknowledgement | null,
): void {
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
  if (!current) throw new Error("replication session fenced");
  if (prior && (ack.durable.sequence < prior.durable.sequence || ack.applied.sequence < prior.applied.sequence))
    throw new Error("replication ACK regressed");
}
