import type { ReplicaDeliveryLease } from "@harness-anything/storage";
import { type WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import type { DaemonHost } from "../daemon-host.ts";
import type { WriterEpochLease } from "@harness-anything/storage";
import { type FleetBlob, type FleetDescriptor, type FleetFrameV1 } from "./command-protocol.ts";
import type { ReplicationSlotKey, ReplicaDeliveryKey } from "@harness-anything/storage";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { FleetDeviceLoginNotice, FleetLoginAuthority } from "./command-protocol.ts";
import type { ReplicationFrame, ReplicationPeer } from "./protocol.ts";
import type { ResourceBudget } from "./resource-budget.ts";

export interface FleetCenterOptions {
  /** Persist one transport record per completed frame; the runtime wires this to the conn log. */
  readonly recordTraffic?: (entry: import("../conn-log.ts").DaemonTrafficLogEntry) => void;
  readonly commandResourceBudget?: ResourceBudget;
  readonly storage?: Readonly<Record<string, import("@harness-anything/storage").DaemonStorageConfig>>;
  readonly host: Pick<
    DaemonHost,
    | "replica"
    | "pruneReplicationLog"
    | "run"
    | "read"
    | "awaitRuntimeSessions"
    | "runtimeIngress"
    | "settleMaterialization"
    | "status"
    | "authorize"
    | "readNodeAutoClaimCandidates"
    | "readNodeAutoDispatchCandidates"
  >;
  readonly stateRoot: string;
  readonly writerEpochStateRoot?: string;
  readonly writerEpochLease?: (repoId: string) => WriterEpochLease;
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly replicaDiskQuotaBytes?: number;
  /** Maximum simultaneous base-backup archive builds across every repository in this center. */
  readonly replicationBaseBackupConcurrency?: number;
  /** Number of replication log commits retained for incremental receivers. */
  readonly replicationRetentionWindowCommits?: number;
  /** An idle replication stream sends `replica.progress` this often, so a dead peer is noticed. */
  readonly replicationKeepaliveMs?: number;
  readonly port?: number;
  readonly hostname?: string;
  /** Overrides the default hello window for an unauthenticated connection (tests, slow-link tuning). */
  readonly helloTimeoutMs?: number;
  readonly now?: () => string;
  readonly writerId?: string;
  /**
   * `source` is the pre-authentication connection source (the peer address), supplied by the
   * transport so hello-failure budgets are keyed on something the hello frame cannot choose.
   */
  readonly authenticate: (nodeId: string, credential: string, source: string) => boolean | Promise<boolean>;
  /** Registered device owner, re-read for admission; action identity comes from the request user token. */
  readonly nodeOwner: (nodeId: string) => string | null | Promise<string | null>;
  readonly loginAuthority?: (nodeId: string) => FleetLoginAuthority | null | Promise<FleetLoginAuthority | null>;
  /**
   * One unauthenticated admission frame used only by edge join; the callback validates the human token and
   * the invitation's complete multi-repository permission snapshot.
   */
  readonly edgeJoin?: (input: {
    readonly joinId: string;
    readonly inviteToken?: string;
    readonly recovery?: import("./edge-join-admission.ts").EdgeJoinRecovery;
    readonly accessToken: string;
  }) => EdgeJoinAdmission | Promise<EdgeJoinAdmission>;
  readonly edgeJoinStatus?: (input: {
    readonly joinId: string;
    readonly accessToken: string;
  }) => Promise<import("./edge-join.ts").EdgeJoinStatusResult>;
  readonly createMemberEdgeJoin?: (
    repoIds: readonly string[],
    personId: string,
    accessToken: string,
  ) => Promise<import("./edge-join.ts").EdgeJoinCreated>;
  readonly revokeDeviceSessions?: (nodeId: string) => Promise<void>;
  readonly deviceLoginNotice?: (nodeId: string, personId: string, notice: FleetDeviceLoginNotice) => void;
  readonly verifyHuman?: (auth: DaemonAuthenticationContext) => Promise<DaemonAuthenticationContext>;
  /** Authenticates a registered node service account for the replication admission path only. */
  readonly verifyReplica?: (auth: DaemonAuthenticationContext) => Promise<DaemonAuthenticationContext | null>;
  readonly buildDraining?: () => boolean;
  readonly onDeliverySettled?: () => void;
  readonly onError?: (entry: {
    readonly nodeId: string | null;
    readonly messageId: string | null;
    readonly error: unknown;
  }) => void;
  /** Records the informational build mismatch from a command or replica hello. */
  readonly onVersionWarning?: (nodeId: string, warning: string | null) => void;
  readonly onReplicationStart?: (
    nodeId: string,
    accessToken: string | undefined,
    frame: Extract<ReplicationFrame, { readonly type: "replica.start" }>,
    peer: ReplicationPeer,
    signal: AbortSignal,
  ) => Promise<void>;
}

/** One replication slot as the center sees it: the node's last durable ACK against the log head. */
export interface FleetReplicaStatus extends ReplicationSlotKey {
  readonly viewId: string;
  readonly centerRevision: number;
  readonly centerSequence: number;
  readonly ackRevision: number | null;
  readonly ackSequence: number | null;
  readonly ackedAt: string | null;
  readonly lagRevisions: number;
  readonly lagCommits: number | null;
  /** How long the node has been behind: now minus its last ACK while lagging, 0 when current. */
  readonly lagMs: number | null;
  /** The node holds the replication session for this repository right now. */
  readonly connected: boolean;
  readonly delivery: "current" | "delta" | "snapshot_required";
  readonly diskQuotaBytes: number | null;
  readonly syncFailure: { readonly code: string; readonly message: string } | null;
  readonly activity: import("./replica-status.ts").ReplicaSyncActivity | null;
}

export interface FleetTlsCenter {
  readonly port: number;
  readonly close: () => Promise<void>;
  /** Cuts every session the node holds, including a handshake still awaiting its verdict. */
  readonly pendingDeliveries: () => number;
  readonly disconnectNode: (nodeId: string) => void;
  readonly inspectNode: (nodeId: string) => {
    readonly online: boolean;
    readonly inFlight: number;
    readonly slots: readonly ReplicationSlotKey[];
  };
  readonly drainNode: (nodeId: string) => Promise<void>;
  readonly fenceNode: (nodeId: string) => () => void;
  readonly removeNode: (nodeId: string) => void;
  readonly replicaReceipt: (opId: string, nodeId: string, viewId: string, repoId: string) => WriteReceipt;
  readonly status: () => {
    readonly replicas: readonly FleetReplicaStatus[];
    readonly nodeSessions: readonly import("./node-session-status.ts").FleetNodeSessionStatus[];
    readonly uploads: FleetUploadWindow;
    readonly versionWarnings: readonly string[];
  };
  readonly versionWarnings: () => readonly string[];
}

export interface FleetUploadWindow {
  readonly limit: number;
  readonly receiving: number;
  readonly staged: number;
  readonly nodes: readonly { readonly nodeId: string; readonly receiving: number; readonly staged: number }[];
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
  readonly drainedBytes: () => number;
  readonly requestRepos: Map<string, string>;
  readonly uploads: Set<string>;
  readonly keys: Set<string>;
  readonly offers: Map<
    string,
    {
      readonly key: ReplicaDeliveryKey;
      readonly lease: ReplicaDeliveryLease;
      readonly renewalFailure: AbortSignal;
      readonly release: (acknowledged?: boolean) => void;
    }
  >;
};

export type Delivery = {
  readonly signal?: AbortSignal;
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

export interface EdgeJoinAdmission {
  readonly joinId: string;
  readonly nodeId: string;
  readonly personId: string;
  readonly credential: string;
  readonly repositories: readonly {
    readonly repoId: string;
    readonly harnessYaml: string;
    readonly originUrl: string | null;
    readonly originAddress?: string | null;
    readonly originPushUrls: readonly string[];
    readonly defaultBranch: string | null;
    readonly defaultBranchCommit: string | null;
  }[];
}
