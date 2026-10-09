// harness-test-tier: integration
import { commitEdgeManifest } from "../src/fleet/replica-read-model.ts";
import { fleetManifestDigest } from "../src/fleet/contract.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";
import { fetchEdgeCiDetails, readEdgeCiDetail } from "../src/ci-detail-cache.ts";
import type { FleetMirrorView, FleetMirrorBlob } from "../src/fleet-edge-mirror.ts";
import type { FleetPeerOptions } from "../src/fleet/edge.ts";

function fixture(t: import("node:test").TestContext, count: number) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ci-detail-cache-")),
    viewDir = path.join(root, "repos", "repo_measure", "views", "measure"),
    entries = new Map<string, FleetMirrorBlob>(),
    digests: string[] = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(viewDir, "ci-detail-cache"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(JSON.stringify({ diagnostic: i })),
      digest = sha256Bytes(bytes),
      descriptor = Buffer.from(
        JSON.stringify({ eventId: `event${i}`, ref: { sha256: digest, encodedBytes: bytes.length } }),
      ),
      sha256 = sha256Bytes(descriptor),
      file = path.join(root, "repos", "repo_measure", "cas", "sha256", sha256.slice(0, 2), sha256);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, descriptor);
    writeFileSync(path.join(viewDir, "ci-detail-cache", digest), bytes);
    entries.set(`.read-model/ci-details/event${i}.json`, {
      sha256,
      size: descriptor.length,
      mediaType: "application/json",
    });
    digests.push(digest);
  }
  const manifest = [...entries].map(([path, blob]) => ({ path, blob }));
  commitEdgeManifest(
    viewDir,
    {
      cut: { revision: 1, schemaGeneration: 1, headDigest: "a".repeat(64) },
      schemaGeneration: 1,
      manifestDigest: fleetManifestDigest(manifest),
    },
    null,
    manifest.map((entry) => ({ op: "put", ...entry })),
  );
  let entryAccesses = 0;
  const view: FleetMirrorView = {
    repoId: "repo_measure",
    viewId: "measure",
    viewDir,
    revision: 1,
    schemaGeneration: 1,
    headDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    authorizationOwner: null,
    authorizationShapeDigest: "c".repeat(64),
    get entries() {
      entryAccesses++;
      return entries;
    },
  };
  return { root, view, digests, accesses: () => entryAccesses };
}

test("fetching cached CI details reads only requested descriptors with indexed authorization", async (t) => {
  const { root, view, accesses } = fixture(t, 200);
  await fetchEdgeCiDetails({
    viewRoot: root,
    view,
    eventIds: Array.from({ length: 30 }, (_, i) => `event${i}`),
    quotaBytes: 1_000_000,
    // Every requested object is cached: a network connection would fail this test.
    peer: { hostname: "invalid", port: 0 } as FleetPeerOptions,
  });
  // Thirty requested descriptors among 200; no whole-manifest authorization scan.
  assert.equal(accesses(), 30);
});

test("CI detail reads still reject unauthorized and altered cached bytes", async (t) => {
  const { root, view, digests } = fixture(t, 2);
  assert.throws(() => readEdgeCiDetail(root, view, "d".repeat(64)), /not in the authorized cut/u);
  assert.ok(readEdgeCiDetail(root, view, digests[0]!));
  writeFileSync(path.join(view.viewDir, "ci-detail-cache", digests[0]!), '{"diagnostic":9}');
  assert.throws(() => readEdgeCiDetail(root, view, digests[0]!), /cache is corrupt/u);
  await assert.rejects(
    fetchEdgeCiDetails({
      viewRoot: root,
      view,
      eventIds: ["event0"],
      quotaBytes: 1_000_000,
      peer: { hostname: "invalid", port: 0 } as FleetPeerOptions,
    }),
    /cache is corrupt/u,
  );
  await assert.rejects(
    fetchEdgeCiDetails({
      viewRoot: root,
      view,
      eventIds: ["absent"],
      quotaBytes: 1_000_000,
      peer: { hostname: "invalid", port: 0 } as FleetPeerOptions,
    }),
    /not in the authorized cut/u,
  );
});
