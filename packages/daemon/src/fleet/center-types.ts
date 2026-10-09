import type { ReplicaDeliveryLease, ReplicaTransferMetrics } from "./replica-delivery-lease.ts";
import { type WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import type { DaemonHost } from "../daemon-host.ts";
import type { WriterEpochLease } from "../writer-epoch.ts";
import { type FleetBlob, type FleetDescriptor, type FleetFrameV1 } from "./contract.ts";
import { type ReplicaDeliveryKey } from "./replica-ack-store.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { FleetLoginAuthority } from "./contract.ts";

export interface FleetCenterOptions {
  readonly host: Pick<
    DaemonHost,
    | "replica"
    | "run"
    | "read"
    | "awaitRuntimeSessions"
    | "runtimeIngress"
    | "settleMaterialization"
    | "status"
    | "authorize"
  >;
  readonly stateRoot: string;
  readonly writerEpochStateRoot?: string;
  readonly writerEpochLease?: (repoId: string) => WriterEpochLease;
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly replicaDiskQuotaBytes?: number;
  /** How long a replica watch waits for a newer cut before answering with the unchanged head (default 20s). */
  readonly replicaWatchProgressMs?: number;
  readonly replicaPreparationTimeoutMs?: number;
  readonly port?: number;
  readonly hostname?: string;
  readonly now?: () => string;
  readonly writerId?: string;
  readonly authenticate: (nodeId: string, credential: string) => boolean | Promise<boolean>;
  /** The person a node acts for, re-read for every frame so a re-registration applies to the next one. */
  readonly nodeOwner: (nodeId: string) => string | null | Promise<string | null>;
  readonly loginAuthority?: (nodeId: string) => FleetLoginAuthority | null | Promise<FleetLoginAuthority | null>;
  readonly verifyHuman?: (auth: DaemonAuthenticationContext) => Promise<DaemonAuthenticationContext>;
  readonly buildDraining?: () => boolean;
  readonly onDeliverySettled?: () => void;
  readonly onError?: (entry: {
    readonly nodeId: string | null;
    readonly messageId: string | null;
    readonly error: unknown;
  }) => void;
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
  readonly deliveryLease: ReplicaDeliveryLease | null;
  readonly transferMetrics: ReplicaTransferMetrics;
  readonly sendWindowBytes: number;
  readonly sendQuotaBytes: number;
  readonly diskQuotaBytes: number | null;
}

export interface FleetTlsCenter {
  readonly port: number;
  readonly close: () => Promise<void>;
  /** Cuts every session the node holds, including a handshake still awaiting its verdict. */
  readonly pendingDeliveries: () => number;
  readonly disconnectNode: (nodeId: string) => void;
  readonly replicaReceipt: (opId: string, nodeId: string, viewId: string, repoId: string) => WriteReceipt;
  readonly status: () => {
    readonly replicas: readonly FleetReplicaStatus[];
  };
}

export type Upload = {
  nodeId: string;
  repoId: string;
  content: FleetBlob;
  descriptor: FleetDescriptor | null;
};

export type State = { uploads: Record<string, Upload> };

export type SessionWindow = {
  readonly holderId: string;
  readonly uploads: Set<string>;
  readonly keys: Set<string>;
  readonly offers: Map<
    string,
    {
      readonly key: ReplicaDeliveryKey;
      readonly lease: ReplicaDeliveryLease;
      readonly release: (acknowledged?: boolean) => void;
    }
  >;
};

export type Delivery = {
  readonly key: string | null;
  readonly frames: AsyncIterable<FleetFrameV1>;
  readonly beforeSend?: () => void;
  readonly onSent?: (bytes: number) => void;
  readonly onComplete?: () => void;
  readonly onFailure?: (error: unknown) => void;
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
