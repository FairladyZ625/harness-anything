// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintDigest,
  materializationWitnessToAppliedExactAtCutV2,
  type MaterializationWitness
} from "../src/index.ts";

test("broker historical witness maps without changing its kind or opaque epoch", () => {
  const source: MaterializationWitness = {
    cutId: "cut-broker",
    selectedDigest: fingerprintDigest(["a.md", "z.md"]),
    cutKind: "HISTORICAL_EXCLUDED_SET",
    epoch: "epoch:opaque:001",
    revision: 9,
    fingerprints: {
      "z.md": { objectKind: "tombstone", logicalMode: 0, byteSize: 0, blobDigest: "sha256:z" },
      "a.md": { objectKind: "file", logicalMode: 0o644, byteSize: 3, blobDigest: "sha256:a" }
    },
    watcherFenceVector: { "z.md": "fence-z", "a.md": "fence-a" },
    journalLSN: 90
  };
  const origin = materializationWitnessToAppliedExactAtCutV2({
    witness: source,
    viewId: "view-broker",
    opId: "op-broker"
  });
  assert.equal(origin.cutKind, "WRITE_EXCLUDED");
  assert.equal(origin.witness.kind, "HISTORICAL_EXCLUDED_SET");
  assert.equal(origin.witness.epochToken, source.epoch);
  assert.equal(origin.writerExclusionId, undefined, "adapter must not invent a writer exclusion identifier");
  assert.equal(origin.witnessDigest, origin.witness.canonicalWitnessDigest);
  assert.deepEqual(origin.witness.fingerprints.map((entry) => entry.path), ["a.md", "z.md"]);
});

test("broker witness adapter rejects an incomplete watcher fence set", () => {
  const witness: MaterializationWitness = {
    cutId: "cut-broker",
    selectedDigest: fingerprintDigest(["a.md"]),
    cutKind: "HISTORICAL_EXCLUDED_SET",
    epoch: "epoch:opaque:001",
    revision: 9,
    fingerprints: {
      "a.md": { objectKind: "file", logicalMode: 0o644, byteSize: 3, blobDigest: "sha256:a" }
    },
    watcherFenceVector: {},
    journalLSN: 90
  };
  assert.throws(() => materializationWitnessToAppliedExactAtCutV2({
    witness,
    viewId: "view-broker",
    opId: "op-broker"
  }), /FENCE_SET_MISMATCH/u);
});
