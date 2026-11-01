import { RAW_ARTIFACT_MAX_BYTES } from "@harness-anything/kernel";
import { FLEET_CHUNK_BYTES, FLEET_FRAME_BYTES, type FleetBlob, type FleetDescriptor } from "./command-protocol.ts";

/** Internal ports, not a new wire version. Closed wire schemas remain owned by command-protocol/protocol. */
export type TransportDirection = "edge-to-center" | "center-to-edge";
export type TransportLane = "control" | "replica" | "bulk";
export type ContentPurpose = "artifact" | "document" | "replica-object" | "snapshot" | "runtime";
export type TransportErrorScope = "global" | "node" | "session" | "repository" | "transfer";

export interface TransportContract {
  readonly direction: TransportDirection;
  readonly lane: TransportLane;
  readonly quotaOwner: "resource-budget";
  readonly maxFrameBytes: number;
  readonly chunkBytes: number;
  readonly creditBytes: number;
  readonly maxInFlightChunks: number;
  readonly payload:
    | { readonly kind: "small-inline"; readonly maxBytes: number }
    | { readonly kind: "content"; readonly purpose: ContentPurpose; readonly maxBytes: number };
}

/** Object size is independent of buffering. Disk policy can tighten this safe-integer offset bound. */
export function contentTransportContract(direction: TransportDirection, purpose: ContentPurpose): TransportContract {
  return {
    direction,
    lane: "bulk",
    quotaOwner: "resource-budget",
    maxFrameBytes: FLEET_FRAME_BYTES,
    chunkBytes: FLEET_CHUNK_BYTES,
    creditBytes: 1024 * 1024,
    maxInFlightChunks: 16,
    payload: {
      kind: "content",
      purpose,
      maxBytes: purpose === "artifact" ? RAW_ARTIFACT_MAX_BYTES : Number.MAX_SAFE_INTEGER,
    },
  };
}

export type ContentIdentity = FleetBlob & { readonly purpose: ContentPurpose };

/** Authenticated server binding. A client's transferId/offset never grants authority to this content. */
export interface ContentBinding {
  readonly transferId: string;
  readonly nodeId: string;
  readonly repoId: string;
  readonly opId: string;
  readonly direction: TransportDirection;
  readonly content: ContentIdentity;
  readonly executionId?: string;
}

export interface ContentSource {
  readonly content: ContentIdentity;
  /** One bounded read; 0 bytes means EOF at content.size. No whole-object aggregation. */
  readonly read: (offset: number, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
}

export interface ContentProgress {
  readonly receivedOffset: number;
  /** Contiguous fsynced prefix, never a socket ACK or merely buffered bytes. */
  readonly durableOffset: number;
  readonly sealed: boolean;
}

export interface ContentSink {
  readonly binding: ContentBinding;
  /** Resume from this authoritative durableOffset after reauthentication. */
  readonly status: (signal: AbortSignal) => Promise<ContentProgress>;
  /** Offset replay must match; gaps and mismatches fail. ACK only the durable prefix. */
  readonly write: (offset: number, bytes: Uint8Array, signal: AbortSignal) => Promise<ContentProgress>;
  readonly flush: (signal: AbortSignal) => Promise<number>;
  /** Idempotent size/digest verification + atomic CAS seal; does not accept a business operation. */
  readonly seal: (signal: AbortSignal) => Promise<FleetDescriptor>;
  /** Idempotent; cannot remove content referenced by an accepted operation. */
  readonly abort: (signal: AbortSignal) => Promise<void>;
}

const failurePolicies = {
  busy: { category: "overload", recovery: "same-operation" },
  resource_exhausted: { category: "overload", recovery: "same-operation" },
  quota_exceeded: { category: "quota", recovery: "never" },
  authentication_required: { category: "authentication", recovery: "never" },
  authorization_denied: { category: "authorization", recovery: "never" },
  protocol_upgrade_required: { category: "protocol", recovery: "never" },
  invalid_frame: { category: "protocol", recovery: "never" },
  content_claim_mismatch: { category: "integrity", recovery: "never" },
  upload_replay_mismatch: { category: "integrity", recovery: "never" },
  upload_gap: { category: "offset", recovery: "resume" },
  writer_epoch_stale: { category: "fenced", recovery: "never" },
  outcome_unknown: { category: "unknown-outcome", recovery: "query-receipt" },
  cancelled: { category: "cancelled", recovery: "never" },
} as const;

export type TransportErrorCode = keyof typeof failurePolicies;
export interface TransportFailure {
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly scope: TransportErrorScope | null;
  readonly retryAfterMs: number | null;
  readonly durableOffset: number | null;
}

/** Classification only: retry ownership belongs to Q; this port creates no timer or retry loop. */
export function transportFailurePolicy(code: TransportErrorCode): (typeof failurePolicies)[TransportErrorCode] {
  return failurePolicies[code];
}
