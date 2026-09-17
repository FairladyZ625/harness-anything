// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileEntityDocumentRematerialization } from "../../src/domain/entity-document-event.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

const repoId = "entity-document-rematerialize",
  writerFence = () => ({ repoId, holderId: "rematerialize-writer", epoch: 1 }),
  actor = { principal: { personId: "person-rematerialize" }, executor: { kind: "agent" as const, id: "codex" } },
  decisionPath = "decisions/decision-dec_REMAT/decision.md",
  factPath = "facts/F-00000001.md";

test("rematerialized document claims land on disk, project, and survive cold replay", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-remat-store-"));
  initRepo(rootDir);
  const decisionBody = "---\nschema: decision-package/v1\n---\n\n# Current Decision\n\nprose\n",
    factBody = "# Facts\n\n- F-00000001 current statement\n",
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const compiled = compileEntityDocumentRematerialization({
      opId: "op-rematerialize-store",
      entityRefs: ["decision/dec_REMAT", "fact/F-00000001"],
      updates: [
        {
          path: decisionPath,
          policyId: "markdown-body-replaceable/v1",
          mediaType: "text/markdown",
          body: decisionBody,
        },
        {
          path: factPath,
          policyId: "document/v1",
          mediaType: "text/markdown",
          body: factBody,
        },
      ],
      rationale: "rematerialize current documents",
      actor,
      source: "local",
      occurredAt: "2026-09-20T00:00:00.000Z",
      workspaceRevision: 1,
    });
    assert.notEqual(compiled, null);
    store.append({ event: compiled!.event, plan: compiled!.plan, blobs: compiled!.blobs });
    assert.equal(store.readCommandOutcome(compiled!.event.opId)?.status, "accepted_durable");
    await store.settlePendingMaterialization?.("rematerialize test");
    assert.equal(readFileSync(path.join(rootDir, "harness", decisionPath), "utf8"), decisionBody);
    assert.equal(readFileSync(path.join(rootDir, "harness", factPath), "utf8"), factBody);
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.apply(compiled!.event, compiled!.plan);
    assert.equal(projection.readDocument(decisionPath).document?.body, decisionBody);
    assert.equal(projection.readDocument(factPath).document?.body, factBody);
  } finally {
    await store.drain();
  }
  // Cold replay: a fresh store and projection over the same ledger must restore the same bytes.
  const replayStore = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const replay = makeTaskProjection({ rootDir, eventStore: replayStore });
    assert.equal(replay.readDocument(decisionPath).document?.body, decisionBody);
    assert.equal(replay.readDocument(factPath).document?.body, factBody);
    assert.equal(replayStore.readHead()?.opId, "op-rematerialize-store");
  } finally {
    await replayStore.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
