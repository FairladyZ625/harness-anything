// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FactEventV1 } from "../../src/domain/fact-event.ts";
import { createFactProjectionTables, FactProjectionError, readFactRow, reduceFactEvent } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

const actor = { principal: { personId: "fact-admission" }, executor: null } as const;

test("Fact admission accepts superseding a standing target", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    reduceFactEvent(db, fact(2, "F-BCDEFGHJ", "fact/task-fact/F-ABCDEFGH"));
    assert.equal(readFactRow(db, "task-fact", "F-ABCDEFGH")?.state, "superseded_fact");
    assert.equal(readFactRow(db, "task-fact", "F-BCDEFGHJ")?.state, "standing");
  } finally {
    db.close();
  }
});

test("Fact admission rejects superseding an already-superseded target", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    reduceFactEvent(db, fact(2, "F-BCDEFGHJ", "fact/task-fact/F-ABCDEFGH"));
    assert.throws(
      () => reduceFactEvent(db, fact(3, "F-CDEFGHJK", "fact/task-fact/F-ABCDEFGH")),
      (error: unknown) => error instanceof FactProjectionError && error.code === "relation_invalid" && /already superseded/u.test(error.message)
    );
  } finally {
    db.close();
  }
});

function fact(revision: number, factId: string, supersedesRef?: string): FactEventV1 {
  return {
    schema: "fact-event/v1", eventId: `event-${revision}`, workspaceRevision: revision, opId: `op-${revision}`,
    taskId: "task-fact", factId, type: "fact_recorded", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z",
    payload: { statement: `Fact ${factId}`, evidenceSource: "admission test", observedAt: "2026-08-18T00:00:00.000Z",
      confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [],
      ...(supersedesRef ? { supersedes: { factRef: supersedesRef, rationale: "New observation replaces the target." } } : {}),
      factsDocumentClaim: { path: "tasks/task-fact/facts.md", sha256: "0".repeat(64), size: 0, mediaType: "text/markdown", policyId: "typed-machine-writer/v1" } }
  };
}
