// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { RAW_ARTIFACT_MAX_BYTES } from "@harness-anything/kernel";
import { FLEET_CHUNK_BYTES, FLEET_FRAME_BYTES } from "../src/fleet/command-protocol.ts";
import {
  contentTransportContract,
  transportFailurePolicy,
  type ContentSource,
  type ContentSink,
  type ContentBinding,
  type TransportDirection,
} from "../src/fleet/transport-contract.ts";

test("both directions use bounded chunks and credit independently of multi-GiB object size", () => {
  for (const direction of ["edge-to-center", "center-to-edge"] as const) {
    const contract = contentTransportContract(direction, "snapshot");
    assert.equal(contract.direction, direction);
    assert.equal(contract.lane, "bulk");
    assert.equal(contract.quotaOwner, "resource-budget");
    assert.equal(contract.maxFrameBytes, FLEET_FRAME_BYTES);
    assert.equal(contract.chunkBytes, FLEET_CHUNK_BYTES);
    assert.equal(contract.creditBytes, 1024 ** 2);
    assert.equal(contract.maxInFlightChunks, 16);
    assert.equal(contract.payload.kind, "content");
    assert.ok(contract.payload.maxBytes > 4 * 1024 ** 3);
    const artifact = contentTransportContract(direction, "artifact");
    assert.equal(artifact.payload.maxBytes, RAW_ARTIFACT_MAX_BYTES);
    assert.equal(artifact.payload.maxBytes, 50_000_000);
  }
});

for (const direction of ["edge-to-center", "center-to-edge"] as const satisfies readonly TransportDirection[]) {
  test(`${direction} source/sink consumer resumes at the sink's durable offset`, async () => {
    const signal = new AbortController().signal;
    // A virtual object tests 64-bit offsets without allocating its multi-GiB prefix.
    const prefix = 5 * 1024 ** 3;
    const content = {
      sha256: "a".repeat(64),
      size: prefix + 3,
      mediaType: "application/octet-stream",
      purpose: "snapshot" as const,
    };
    const binding: ContentBinding = {
      transferId: "transfer",
      nodeId: "node",
      repoId: "repo",
      opId: "stable-op",
      direction,
      content,
    };
    const reads: number[] = [];
    let receivedOffset = prefix,
      durableOffset = prefix,
      sealed = false;
    const source: ContentSource = {
      content,
      read: async (offset, maxBytes, readSignal) => {
        assert.equal(readSignal, signal);
        assert.equal(maxBytes, FLEET_CHUNK_BYTES);
        reads.push(offset);
        return offset === prefix ? new Uint8Array([1, 2, 3]) : new Uint8Array();
      },
    };
    const sink: ContentSink = {
      binding,
      status: async () => ({ receivedOffset, durableOffset, sealed }),
      write: async (offset, bytes) => {
        assert.equal(offset, receivedOffset);
        receivedOffset += bytes.byteLength;
        return { receivedOffset, durableOffset, sealed };
      },
      flush: async () => {
        durableOffset = receivedOffset;
        return durableOffset;
      },
      seal: async () => {
        assert.equal(durableOffset, content.size);
        sealed = true;
        return { ...content, ref: "objects/sealed" };
      },
      abort: async () => {
        throw new Error("healthy consumer must not abort");
      },
    };
    let offset = (await sink.status(signal)).durableOffset;
    while (offset < source.content.size) {
      const bytes = await source.read(offset, FLEET_CHUNK_BYTES, signal);
      assert.ok(bytes.byteLength > 0);
      const progress = await sink.write(offset, bytes, signal);
      assert.equal(progress.durableOffset, prefix, "received bytes are not durable before flush");
      offset = progress.receivedOffset;
    }
    assert.equal(await sink.flush(signal), content.size);
    assert.equal((await sink.seal(signal)).ref, "objects/sealed");
    assert.deepEqual(reads, [prefix]);
    assert.equal((await sink.status(signal)).sealed, true);
  });
}

test("error policy distinguishes admission retry, offset recovery, unknown outcome and permanent rejection", () => {
  assert.deepEqual(transportFailurePolicy("resource_exhausted"), { category: "overload", recovery: "same-operation" });
  assert.deepEqual(transportFailurePolicy("quota_exceeded"), { category: "quota", recovery: "never" });
  assert.deepEqual(transportFailurePolicy("upload_gap"), { category: "offset", recovery: "resume" });
  assert.deepEqual(transportFailurePolicy("outcome_unknown"), {
    category: "unknown-outcome",
    recovery: "query-receipt",
  });
  for (const code of [
    "authentication_required",
    "authorization_denied",
    "protocol_upgrade_required",
    "invalid_frame",
    "content_claim_mismatch",
    "upload_replay_mismatch",
    "writer_epoch_stale",
    "cancelled",
  ] as const)
    assert.equal(transportFailurePolicy(code).recovery, "never");
});
