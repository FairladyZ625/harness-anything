import type {
  AuthorityOperationEnvelope,
  AuthorityOperationRecord,
  AuthorityOperationReceipt,
  AuthorityProtocolTuple,
  ProtocolSchemaTupleV2,
  ReplicaChangeRecord
} from "@harness-anything/application";

export const authorityWireFrameType = "harness-authority-wire/v1" as const;
export type Sha256Digest = ReplicaChangeRecord["manifest"]["digest"];

export interface AuthoritySnapshotCut {
  readonly workspaceId: string;
  readonly epoch: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly manifestDigest: Sha256Digest;
  readonly provenanceDigest: Sha256Digest;
}

export interface AuthoritySnapshotReservation {
  readonly schema: "authority-snapshot-reservation/v1";
  readonly cut: AuthoritySnapshotCut;
  readonly lease: {
    readonly leaseId: string;
    readonly expiresAt: string;
    readonly minRetainedRevision: number;
    readonly pinnedBlobSetDigest: Sha256Digest;
  };
  readonly stream: {
    readonly streamToken: string;
    readonly fromRevision: number;
  };
}

export interface AuthoritySnapshotManifest {
  readonly schema: "authority-snapshot-manifest/v1";
  readonly cut: AuthoritySnapshotCut;
  readonly entries: ReadonlyArray<AuthoritySnapshotManifestEntry>;
}

export interface AuthoritySnapshotManifestEntry {
  readonly path: string;
  readonly blobDigest: Sha256Digest;
  readonly mode: NonNullable<ReplicaChangeRecord["paths"][number]["mode"]>;
  readonly tombstone: false;
}

interface AuthorityWireFrameBase {
  readonly type: typeof authorityWireFrameType;
  readonly connectionGeneration: number;
}

export interface AuthorityHelloFrame extends AuthorityWireFrameBase {
  readonly kind: "hello";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly channelNonceDigest: string;
  readonly protocol: AuthorityNegotiatedProtocol;
}

export interface AuthoritySubmitFrame extends AuthorityWireFrameBase {
  readonly kind: "submit";
  readonly requestId: string;
  readonly envelope: AuthorityOperationEnvelope;
}

export interface AuthoritySubmitV2Frame extends AuthorityWireFrameBase {
  readonly kind: "submit_v2";
  readonly requestId: string;
  readonly presentationToken: string;
  readonly envelope: string;
}

export interface AuthorityGetOperationFrame extends AuthorityWireFrameBase {
  readonly kind: "get_operation";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly opId: string;
}

export interface AuthorityBeginSnapshotFrame extends AuthorityWireFrameBase {
  readonly kind: "begin_snapshot_and_subscribe";
  readonly requestId: string;
  readonly workspaceId: string;
}

export interface AuthorityGetSnapshotManifestFrame extends AuthorityWireFrameBase {
  readonly kind: "get_snapshot_manifest";
  readonly requestId: string;
  readonly streamToken: string;
  readonly manifestDigest: Sha256Digest;
}

export interface AuthorityGetBlobFrame extends AuthorityWireFrameBase {
  readonly kind: "get_blob";
  readonly requestId: string;
  readonly streamToken: string;
  readonly digest: Sha256Digest;
}

export interface AuthorityChangesAfterFrame extends AuthorityWireFrameBase {
  readonly kind: "changes_after";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly streamToken: string;
  readonly sinceRevision: number;
}

export interface AuthorityBlobResult {
  readonly schema: "authority-blob/v1";
  readonly digest: Sha256Digest;
  readonly bytes: string;
}

export interface AuthorityChangesAfterResult {
  readonly schema: "authority-changes-after/v1";
  readonly sinceRevision: number;
  readonly throughRevision: number;
  readonly changes: ReadonlyArray<ReplicaChangeRecord>;
}

export type AuthorityReadDownResult =
  | AuthoritySnapshotReservation
  | AuthoritySnapshotManifest
  | AuthorityBlobResult
  | AuthorityChangesAfterResult;

export type AuthorityRequestFrame =
  | AuthorityHelloFrame
  | AuthoritySubmitFrame
  | AuthoritySubmitV2Frame
  | AuthorityGetOperationFrame
  | AuthorityBeginSnapshotFrame
  | AuthorityGetSnapshotManifestFrame
  | AuthorityGetBlobFrame
  | AuthorityChangesAfterFrame;

export interface AuthorityResponseFrame extends AuthorityWireFrameBase {
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: AuthorityOperationReceipt | AuthorityOperationRecord | AuthorityHelloResult | AuthorityReadDownResult | null;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AuthorityReplicaChangeFrame extends AuthorityWireFrameBase {
  readonly kind: "replica_change";
  readonly change: ReplicaChangeRecord;
}

export interface AuthorityStreamClosedFrame extends AuthorityWireFrameBase {
  readonly kind: "stream_closed";
  readonly code: "BACKPRESSURE" | "UPGRADE_REQUIRED" | "SERVER_SHUTDOWN";
  readonly lastDurableRevision: number;
  readonly message: string;
}

export interface AuthorityHelloResult {
  readonly accepted: true;
  readonly protocol: AuthorityNegotiatedProtocol;
  readonly capabilities: ReadonlyArray<string>;
}

export type AuthorityServerFrame = AuthorityResponseFrame | AuthorityReplicaChangeFrame | AuthorityStreamClosedFrame;
export type AuthorityNegotiatedProtocol = AuthorityProtocolTuple | ProtocolSchemaTupleV2;

export function isAuthorityRequestFrame(value: unknown): value is AuthorityRequestFrame {
  if (!isBase(value) || typeof value.kind !== "string" || typeof value.requestId !== "string") return false;
  if (value.kind === "hello") {
    return typeof value.workspaceId === "string"
      && typeof value.channelNonceDigest === "string"
      && isProtocolTuple(value.protocol);
  }
  if (value.kind === "submit") return isObject(value.envelope);
  if (value.kind === "submit_v2") return typeof value.presentationToken === "string" && typeof value.envelope === "string";
  if (value.kind === "get_operation") return typeof value.workspaceId === "string" && typeof value.opId === "string";
  if (value.kind === "begin_snapshot_and_subscribe") return typeof value.workspaceId === "string";
  if (value.kind === "get_snapshot_manifest") {
    return typeof value.streamToken === "string" && isSha256Digest(value.manifestDigest);
  }
  if (value.kind === "get_blob") return typeof value.streamToken === "string" && isSha256Digest(value.digest);
  if (value.kind === "changes_after") {
    return typeof value.workspaceId === "string"
      && typeof value.streamToken === "string"
      && typeof value.sinceRevision === "number"
      && Number.isSafeInteger(value.sinceRevision)
      && value.sinceRevision >= 0;
  }
  return false;
}

export function isAuthorityServerFrame(value: unknown): value is AuthorityServerFrame {
  if (!isBase(value) || typeof value.kind !== "string") return false;
  if (value.kind === "response") return typeof value.requestId === "string" && typeof value.ok === "boolean";
  if (value.kind === "replica_change") return isObject(value.change);
  return value.kind === "stream_closed"
    && typeof value.code === "string"
    && typeof value.lastDurableRevision === "number"
    && typeof value.message === "string";
}

export function sameAuthorityProtocol(left: AuthorityNegotiatedProtocol, right: AuthorityNegotiatedProtocol): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

function isBase(value: unknown): value is Record<string, unknown> & AuthorityWireFrameBase {
  return isObject(value)
    && value.type === authorityWireFrameType
    && typeof value.connectionGeneration === "number";
}

function isProtocolTuple(value: unknown): value is AuthorityNegotiatedProtocol {
  if (!isObject(value)) return false;
  const v1 = ["wire", "event", "receipt", "digest", "commandRegistry"];
  const v2 = [...v1, "policy", "entityRegistry", "mutationRegistry", "localState", "applyJournal"];
  const keys = Object.keys(value);
  const expected = keys.length === v1.length ? v1 : keys.length === v2.length ? v2 : undefined;
  return Boolean(expected)
    && expected!.every((key) => keys.includes(key)
      && typeof value[key] === "number"
      && Number.isInteger(value[key])
      && value[key] >= 0
      && value[key] <= 0xffff_ffff);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
