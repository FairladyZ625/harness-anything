// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskProjection,
  openSqliteEventStore,
  sha256Bytes,
  sqliteLedgerPath,
} from "@harness-anything/kernel";
import { fetchEdgeCiDetails, readEdgeCiDetail } from "../src/ci-detail-cache.ts";
import { startBaseBackup } from "../src/fleet/basebackup.ts";
import { installReplicaGeneration, readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import type { FleetMirrorView, FleetMirrorBlob } from "../src/fleet-edge-mirror.ts";
import type { FleetPeerOptions } from "../src/fleet/peer.ts";

/**
 * The cache layer sits above a real replica generation: descriptors are documents of the
 * authorized cut, their bytes live in the generation's object store, and the cache directory
 * hangs off the generation root. The fixture installs one real generation over a minimal repo
 * (for the on-disk layout) and seeds synthetic CI-detail descriptors into its object store.
 */
async function fixture(t: import("node:test").TestContext, count: number) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ci-detail-cache-")),
    repo = path.join(root, "repo"),
    viewDir = path.join(root, "repos", "repo_measure", "views", "measure"),
    entries = new Map<string, FleetMirrorBlob>(),
    digests: string[] = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Cache Test");
  git("config", "user.email", "cache@example.invalid");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: measure\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git("add", "harness");
  git("commit", "-qm", "base");
  activateEmptyCanonicalGeneration({ repoId: "repo_measure", rootInput: repo });
  const ledgerStore = openSqliteEventStore({ repoId: "repo_measure", rootInput: repo });
  ledgerStore.close();
  const projection = makeTaskProjection({
    rootDir: repo,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  projection.catchUp();
  const projectionPath = projection.path;
  projection.close();
  const transfer = await startBaseBackup({
      ledgerPath: sqliteLedgerPath(repo),
      projectionPath,
      directory: path.join(viewDir, "staging"),
    }),
    archive = await transfer.complete;
  await installReplicaGeneration({
    root: viewDir,
    archive: archive.file,
    metadata: archive.metadata,
    sha256: archive.sha256,
    size: archive.size,
    quotaBytes: 16 * 1024 * 1024,
  });
  const generation = readReplicaGeneration(viewDir)!,
    generationRoot = generation.rootDir;
  mkdirSync(path.join(viewDir, "ci-detail-cache"), { recursive: true });
  const objects = path.join(
    generationRoot,
    ".harness",
    "store",
    "generations",
    String(generation.metadata.ledgerGeneration),
    "objects",
    "sha256",
  );
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(JSON.stringify({ diagnostic: i })),
      digest = sha256Bytes(bytes),
      descriptor = Buffer.from(
        JSON.stringify({ eventId: `event${i}`, ref: { sha256: digest, encodedBytes: bytes.length } }),
      ),
      sha256 = sha256Bytes(descriptor);
    mkdirSync(path.join(objects, sha256.slice(0, 2)), { recursive: true });
    writeFileSync(path.join(objects, sha256.slice(0, 2), sha256), descriptor);
    writeFileSync(path.join(viewDir, "ci-detail-cache", digest), bytes);
    entries.set(`.read-model/ci-details/event${i}.json`, {
      sha256,
      size: descriptor.length,
      mediaType: "application/json",
    });
    digests.push(digest);
  }
  let entryAccesses = 0;
  const view: FleetMirrorView = {
    repoId: "repo_measure",
    viewId: "measure",
    viewDir,
    revision: generation.metadata.position.revision,
    schemaGeneration: 1,
    headDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    readerProfile: null,
    authorizationShapeDigest: "c".repeat(64),
    get entries() {
      entryAccesses++;
      return entries;
    },
  };
  return { root, view, digests, accesses: () => entryAccesses };
}

test("fetching cached CI details reads only requested descriptors with indexed authorization", async (t) => {
  const { root, view, accesses } = await fixture(t, 200);
  await fetchEdgeCiDetails({
    viewRoot: root,
    view,
    eventIds: Array.from({ length: 30 }, (_, i) => `event${i}`),
    quotaBytes: 1_000_000,
    // Every requested object is cached: a network connection would fail this test.
    peer: { hostname: "invalid", port: 0 } as FleetPeerOptions,
  });
  // Thirty requested descriptors among 200; no whole-manifest authorization scan. Two entry
  // reads per requested path in the current cache layer: the descriptor lookup and the blob
  // resolution, which scans entries by sha (runtime-result-read.ts readEdgeViewBlob).
  assert.equal(accesses(), 60);
});

test("CI detail reads still reject unauthorized and altered cached bytes", async (t) => {
  const { root, view, digests } = await fixture(t, 2);
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

// The retired fleet.ci-detail.get/v1 serving frame and the host.replica() manifest mocks went
// with the cut-manifest serving path; CI detail objects now ride the replicated generation.
