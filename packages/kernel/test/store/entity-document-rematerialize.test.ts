// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
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
    const first = store.append({ event: compiled!.event, plan: compiled!.plan, blobs: compiled!.blobs }),
      replay = store.append({ event: compiled!.event, plan: compiled!.plan, blobs: compiled!.blobs });
    assert.deepEqual(replay.cut, first.cut);
    assert.equal(store.read().events.length, 1, "same-op replay must not append another batch event");
    assert.deepEqual(store.readCommandOutcome(compiled!.event.opId)?.memberOpIds, [compiled!.event.opId]);
    assert.equal(store.readCommandOutcome(compiled!.event.opId)?.status, "accepted_durable");
    assert.deepEqual(
      JSON.parse(serializePersistedCanonicalEvent(compiled!.event)),
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "../../fixtures/canonical-events/entity-document-event-v1/accepted.json"),
          "utf8",
        ),
      ),
      "the governed fixture is captured from this isolated accepted append",
    );
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
    assert.equal(replayStore.read().events.length, 1);
    const event = replayStore.read().events[0];
    assert.equal(event?.schema, "entity-document-event/v1");
    if (event?.schema === "entity-document-event/v1")
      assert.deepEqual(event.payload.entityRefs, ["decision/dec_REMAT", "fact/F-00000001"]);
  } finally {
    await replayStore.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
