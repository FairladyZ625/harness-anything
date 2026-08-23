import { type WriteReceipt } from "../../../kernel/src/index.ts";
import type { DaemonHost } from "../daemon-host.ts";
import { type FleetLeaseBroker } from "../lease-broker.ts";
import { type FleetAssignmentBinding, type FleetBlob, type FleetDescriptor, type FleetFrameV1 } from "./contract.ts";
import { type ReplicaDeliveryKey } from "./replica-ack-store.ts";

export interface FleetAssignmentRecord extends FleetAssignmentBinding {
  readonly viewId: string;
  readonly expiresAt: string;
}

export interface FleetCenterOptions {
  readonly host: Pick<DaemonHost, "replica" | "run" | "read" | "runtimeIngress" | "status">;
  readonly stateRoot: string;
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly replicaDiskQuotaBytes?: number;
  readonly port?: number;
  readonly hostname?: string;
  readonly now?: () => string;
  readonly writerId?: string;
  readonly authenticate: (nodeId: string, credential: string) => boolean | Promise<boolean>;
  readonly isNodeActive?: (nodeId: string) => boolean | Promise<boolean>;
  readonly resolveAssignment: (
    assignmentId: string,
  ) => FleetAssignmentRecord | null | Promise<FleetAssignmentRecord | null>;
}

export interface FleetReplicaStatus extends ReplicaDeliveryKey {
  readonly centerRevision: number;
  readonly centerEventAt: string | null;
  readonly centerManifestBytes: number;
  readonly ackRevision: number | null;
  readonly ackCutEventAt: string | null;
  readonly ackedAt: string | null;
  readonly lagRevisions: number;
  readonly lagMs: number | null;
  readonly catchUpBytes: number;
  readonly delivery: "current" | "delta" | "snapshot_required" | "busy" | "degraded";
  readonly activeTransfers: number;
  readonly sendWindowBytes: number;
  readonly sendQuotaBytes: number;
  readonly diskQuotaBytes: number | null;
}

export interface FleetTlsCenter {
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly replicaReceipt: (opId: string, nodeId: string, viewId: string, repoId: string) => WriteReceipt;
  readonly status: () => {
    readonly replicas: readonly FleetReplicaStatus[];
    readonly leases: ReturnType<FleetLeaseBroker["status"]>;
  };
}

export type Upload = {
  nodeId: string;
  assignmentId: string;
  repoId: string;
  content: FleetBlob;
  descriptor: FleetDescriptor | null;
};

export type State = { uploads: Record<string, Upload> };

export type SessionWindow = {
  readonly uploads: Set<string>;
  readonly keys: Set<string>;
  readonly offers: Map<string, ReplicaDeliveryKey>;
};

export type Delivery = {
  readonly key: string | null;
  readonly frames: AsyncIterable<FleetFrameV1>;
};

export class FleetFault extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly resumeOffset: number | null;
  constructor(code: string, message: string, retryable = false, resumeOffset: number | null = null) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.resumeOffset = resumeOffset;
  }
}
