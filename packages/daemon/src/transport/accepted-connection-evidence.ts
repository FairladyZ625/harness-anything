import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AcceptedConnectionEvidence,
  ChannelDigest32,
  ConnectionGeneration,
  DaemonTransportKind,
  OsObservedPeerCredential,
  OsPeerCredentialEvidence,
  UnixSocketOwnerCompatibilityBoundary
} from "./auth-context.ts";

const channelDigestDomain = Buffer.from("harness-daemon-channel/v1\0", "utf8");

export interface CreateAcceptedConnectionEvidenceInput {
  readonly connectionId: string;
  readonly connectionGeneration: ConnectionGeneration;
  readonly daemonInstanceId: string;
  readonly transportKind: DaemonTransportKind;
  readonly peerCredential: OsPeerCredentialEvidence;
  readonly compatibilityBoundary?: UnixSocketOwnerCompatibilityBoundary;
  readonly serverRandom?: Uint8Array;
}

export function connectionGeneration(value: string = randomUUID()): ConnectionGeneration {
  if (value.length === 0) throw new Error("connection generation must not be empty");
  return value as ConnectionGeneration;
}

export function canonicalPeerCredentialBytes(peerCredential: OsPeerCredentialEvidence): Buffer {
  if (!peerCredential.available) {
    return Buffer.concat([
      lengthPrefixed("harness-peer-credential/unavailable/v1"),
      lengthPrefixed(peerCredential.code),
      lengthPrefixed(peerCredential.source)
    ]);
  }

  const credential = peerCredential.value;
  return Buffer.concat([
    lengthPrefixed("harness-peer-credential/available/v1"),
    lengthPrefixed(credential.platform),
    lengthPrefixed(credential.source),
    uint64(credential.uid, "uid"),
    optionalUint64(credential.gid, "gid"),
    optionalUint64(credential.pid, "pid")
  ]);
}

export function createAcceptedConnectionEvidence(
  input: CreateAcceptedConnectionEvidenceInput
): AcceptedConnectionEvidence {
  if (input.connectionId.length === 0) throw new Error("connection id must not be empty");
  if (input.daemonInstanceId.length === 0) throw new Error("daemon instance id must not be empty");
  const serverRandom = Buffer.from(input.serverRandom ?? randomBytes(32));
  if (serverRandom.byteLength !== 32) throw new Error("accepted connection server random must be 32 bytes");
  const peerCredential = freezePeerCredential(input.peerCredential);
  const digest = createHash("sha256")
    .update(channelDigestDomain)
    .update(lengthPrefixed(input.daemonInstanceId))
    .update(lengthPrefixed(input.connectionId))
    .update(lengthPrefixed(input.connectionGeneration))
    .update(serverRandom)
    .update(canonicalPeerCredentialBytes(peerCredential))
    .digest();
  const channelBinding = Object.freeze({
    get digest(): ChannelDigest32 {
      return channelDigest32(digest);
    },
    source: "transport-observed" as const
  });
  const compatibilityBoundary = input.compatibilityBoundary
    ? Object.freeze({ ...input.compatibilityBoundary })
    : undefined;

  return Object.freeze({
    schema: "daemon-accepted-connection-evidence/v1" as const,
    connectionId: input.connectionId,
    connectionGeneration: input.connectionGeneration,
    transportKind: input.transportKind,
    channelBinding,
    peerCredential,
    ...(compatibilityBoundary ? { compatibilityBoundary } : {})
  });
}

export function channelDigest32(value: Uint8Array): ChannelDigest32 {
  if (value.byteLength !== 32) throw new Error("channel digest must be 32 bytes");
  return Uint8Array.from(value) as ChannelDigest32;
}

function freezePeerCredential(peerCredential: OsPeerCredentialEvidence): OsPeerCredentialEvidence {
  if (!peerCredential.available) return Object.freeze({ ...peerCredential });
  validatePeerCredential(peerCredential.value);
  return Object.freeze({ available: true as const, value: Object.freeze({ ...peerCredential.value }) });
}

function validatePeerCredential(credential: OsObservedPeerCredential): void {
  uint64(credential.uid, "uid");
  if (credential.gid !== undefined) uint64(credential.gid, "gid");
  if (credential.pid !== undefined) uint64(credential.pid, "pid");
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function optionalUint64(value: number | undefined, field: string): Buffer {
  return value === undefined
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), uint64(value, field)]);
}

function uint64(value: number, field: string): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
