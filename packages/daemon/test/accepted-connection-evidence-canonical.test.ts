// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPeerCredentialBytes,
  channelDigest32,
  connectionGeneration,
  createAcceptedConnectionEvidence
} from "../src/index.ts";

test("typed unavailable peer credentials have a distinct canonical domain and a 32-byte digest", () => {
  const unavailable = {
    available: false,
    code: "observation_failed",
    source: "os-peer-credential-adapter"
  } as const;
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "connection-a",
    connectionGeneration: connectionGeneration("generation-a"),
    daemonInstanceId: "daemon-a",
    transportKind: "unix-socket",
    peerCredential: unavailable,
    serverRandom: Buffer.alloc(32, 0x5a)
  });
  const evidenceWithOwnerBoundary = createAcceptedConnectionEvidence({
    connectionId: "connection-a",
    connectionGeneration: connectionGeneration("generation-a"),
    daemonInstanceId: "daemon-a",
    transportKind: "unix-socket",
    peerCredential: unavailable,
    compatibilityBoundary: {
      ownerUid: 999,
      source: "unix-socket-filesystem-owner-boundary"
    },
    serverRandom: Buffer.alloc(32, 0x5a)
  });

  assert.deepEqual(
    canonicalPeerCredentialBytes(unavailable),
    Buffer.concat([
      lengthPrefixed("harness-peer-credential/unavailable/v1"),
      lengthPrefixed("observation_failed"),
      lengthPrefixed("os-peer-credential-adapter")
    ])
  );
  assert.equal(evidence.channelBinding.digest.byteLength, 32);
  assert.equal(evidence.channelBinding.source, "transport-observed");
  assert.deepEqual(evidence.channelBinding.digest, evidenceWithOwnerBoundary.channelBinding.digest);
  assert.equal(
    Buffer.from(evidence.channelBinding.digest).toString("hex"),
    "bcd84a359885c2f4ce5c3416a708b82cfe301a9ad8be72739acdef2d49b2c419"
  );
  const callerDigest = evidence.channelBinding.digest;
  callerDigest[0] = 0;
  assert.equal(
    Buffer.from(evidence.channelBinding.digest).toString("hex"),
    "bcd84a359885c2f4ce5c3416a708b82cfe301a9ad8be72739acdef2d49b2c419"
  );
  assert.notDeepEqual(
    canonicalPeerCredentialBytes(unavailable),
    canonicalPeerCredentialBytes({
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: 0
      }
    })
  );
});

test("available peer credentials preserve canonical source and optional numeric fields", () => {
  const available = {
    available: true,
    value: {
      schema: "os-observed-peer-credential/v1",
      platform: "darwin",
      source: "LOCAL_PEERCRED",
      uid: 501,
      gid: 20,
      pid: 4242
    }
  } as const;

  assert.deepEqual(
    canonicalPeerCredentialBytes(available),
    Buffer.concat([
      lengthPrefixed("harness-peer-credential/available/v1"),
      lengthPrefixed("darwin"),
      lengthPrefixed("LOCAL_PEERCRED"),
      uint64(501),
      Buffer.from([1]),
      uint64(20),
      Buffer.from([1]),
      uint64(4242)
    ])
  );
  assert.throws(() => channelDigest32(Buffer.alloc(31)), /channel digest must be 32 bytes/u);
});

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
