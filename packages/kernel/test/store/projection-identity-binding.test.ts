// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore, type CanonicalEventStore } from "../../src/store/task-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { DOC_CODEC_ID, DOC_POLICY_ID, docSyncWritePlan, type DocEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { compileFactWrite, type FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";

// Two ledgers at the same revision with different content is exactly the shape a genesis replay
// produces: the whole ledger is rewritten while the head revision stays put. A projection cache
// scanned from one ledger must not be able to impersonate the other's cache, so opening a cache
// against a same-revision ledger with a different head eventDigest must cold-rebuild it.
test("projection cache from a same-revision different-content ledger is discarded and cold-rebuilt", async () => {
  await withTempStoreAsync(async (rootA) => {
    await withTempStoreAsync(async (rootB) => {
      const bodyA = "# Notes\n\nLedger A generation prose.\n", bodyB = "# Notes\n\nLedger B generation prose.\n";
      const storeA = seedLedger(rootA, "ledger-a", bodyA), storeB = seedLedger(rootB, "ledger-b", bodyB);
      const projectionA = makeTaskProjection({ rootDir: rootA, eventStore: storeA });
      const warmed = projectionA.readDocument("context/notes.md");
      assert.equal(warmed.status, "ready");
      assert.equal(warmed.document?.body, bodyA);

      // Reuse ledger A's warmed cache file for ledger B: same revision (1), different content.
      const projectionBOnStaleCache = makeTaskProjection({ rootDir: rootB, eventStore: storeB, projectionPath: projectionA.path });
      const readB = projectionBOnStaleCache.readDocument("context/notes.md");
      assert.equal(readB.status, "ready");
      assert.equal(readB.document?.body, bodyB);
      assert.equal(readB.sourceRevision, 1);

      // Swap back: the cache now carries ledger B's identity, so ledger A must rebuild it again.
      const projectionAOnStaleCache = makeTaskProjection({ rootDir: rootA, eventStore: storeA, projectionPath: projectionA.path });
      const readA = projectionAOnStaleCache.readDocument("context/notes.md");
      assert.equal(readA.status, "ready");
      assert.equal(readA.document?.body, bodyA);
      assert.equal(readA.sourceRevision, 1);
    });
  });
});

test("event relation truth cannot cross a same-revision ledger identity", async () => {
  await withTempStoreAsync(async (rootA) => { await withTempStoreAsync(async (rootB) => {
    const storeA = seedFactLedger(rootA), storeB = seedLedger(rootB, "relation-empty", "# Empty\n"), projectionA = makeTaskProjection({ rootDir: rootA, eventStore: storeA });
    projectionA.readFactGraph();
    assert.deepEqual(projectionA.readRelationTruth().factAnchors.map(({ factRef }) => factRef), ["fact/task-identity/F-12345678"]);
    const projectionB = makeTaskProjection({ rootDir: rootB, eventStore: storeB, projectionPath: projectionA.path });
    assert.deepEqual(projectionB.readRelationTruth(), { factAnchors: [], decisionAnchors: [], edges: [], coverageRows: [] });
  }); });
});

test("a cache ahead of a replacement source history is discarded before staged events can apply", async () => {
  await withTempStoreAsync(async (rootA) => { await withTempStoreAsync(async (rootB) => {
    const storeA = seedTaskLedger(rootA, "history-a", 6), storeB = seedTaskLedger(rootB, "history-b", 2), projectionA = makeTaskProjection({ rootDir: rootA, eventStore: storeA });
    assert.equal(projectionA.read("task-1").watermark, 6);

    const projectionB = makeTaskProjection({ rootDir: rootB, eventStore: storeB, projectionPath: projectionA.path });
    const recovered = projectionB.read("task-1");
    assert.deepEqual({ status: recovered.status, watermark: recovered.watermark, sourceRevision: recovered.sourceRevision }, { status: "ready", watermark: 2, sourceRevision: 2 });
    assert.equal(recovered.snapshot.task?.status, "active");
    assert.equal(projectionB.readOperation(lifecycleFixture().events[2]!.opId), null);
  }); });
});

function seedLedger(rootDir: string, name: string, body: string): CanonicalEventStore {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Identity Test");
  git(rootDir, "config", "user.email", "identity-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  const eventStore = makeTaskEventStore({ repoId: name, rootDir });
  const hash = sha256Text(body), base = eventStore.currentCut();
  const event: DocEventV1 = { schema: "doc-event/v1", eventId: `event-${name}`, workspaceRevision: 1, opId: `op-${name}`, type: "documents_written",
    actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-18T00:00:00.000Z",
    payload: { executionId: null, baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null,
      candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, policyId: DOC_POLICY_ID,
      regionProofs: [{ regionId: "heading/notes", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } };
  eventStore.append({ event, plan: docSyncWritePlan(event), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] });
  return eventStore;
}

function seedFactLedger(rootDir: string): CanonicalEventStore {
  git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Identity Test"); git(rootDir, "config", "user.email", "identity-test@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  const eventStore = makeTaskEventStore({ repoId: "relation-source", rootDir }), event: FactEventDraftV1 = { schema: "fact-event/v1", eventId: "event-relation-source", workspaceRevision: 1, opId: "op-relation-source", taskId: "task-identity", factId: "F-12345678", type: "fact_recorded", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { statement: "Identity-bound fact", evidenceSource: "fixture", observedAt: "2026-08-18T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [{ runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable", boundAt: "2026-08-18T00:00:00.000Z" }] } }, compiled = compileFactWrite({ event, packagePath: "tasks/task-identity-identity", currentFacts: [] }); eventStore.append(compiled); return eventStore;
}

function seedTaskLedger(rootDir: string, name: string, count: number): CanonicalEventStore {
  git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Identity Test"); git(rootDir, "config", "user.email", "identity-test@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  const store = makeTaskEventStore({ repoId: name, rootDir });
  for (const event of lifecycleFixture().events.slice(0, count)) store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  return store;
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
