// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileFactWrite, parseEntityRef, type FactEventDraftV1 } from "../../src/index.ts";
import { factRef, validateCurrentFactEvent } from "../../src/domain/fact-event.ts";
import {
  createFactProjectionTables,
  readFactGraphRows,
  reduceFactEvent,
} from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

const actor = { principal: { personId: "person-fact-contract" }, executor: null } as const;
const payload = {
  statement: "A standalone observation.",
  evidenceSource: "contract-test",
  observedAt: "2026-08-27T00:00:00.000Z",
  confidence: "high" as const,
  memoryClass: "semantic" as const,
  memoryTags: ["pattern"] as const,
  provenance: [
    {
      runtime: "codex" as const,
      sessionId: "fact-contract",
      transcriptReachability: "by_session_id" as const,
      boundAt: "2026-08-27T00:00:00.000Z",
    },
  ],
};

function draft(opId: string, factId: string, taskId?: string): FactEventDraftV1 {
  return {
    schema: "fact-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: 1,
    opId,
    ...(taskId ? { taskId } : {}),
    factId,
    type: "fact_recorded",
    actor,
    source: "local",
    occurredAt: "2026-08-27T00:00:00.000Z",
    payload,
  };
}

test("standalone facts use canonical identity and a per-fact document", () => {
  const compiled = compileFactWrite({ event: draft("standalone", "F-ABCDEFGH") });
  assert.equal(compiled.path, "facts/F-ABCDEFGH.md");
  assert.equal(compiled.event.taskId, undefined);
  assert.deepEqual(validateCurrentFactEvent(compiled.event), []);
  assert.deepEqual(parseEntityRef(factRef("F-ABCDEFGH"))?.kind, "fact");
  assert.equal(parseEntityRef("fact/task-legacy/F-ABCDEFGH"), null);
});

test("a task-owned fact projection emits exactly one active produces edge", () => {
  const db = new DatabaseSync(":memory:");
  createFactProjectionTables(db);
  createRelationGraphProjectionTables(db);
  const compiled = compileFactWrite({ event: draft("owned", "F-BCDEFGHJ", "task-contract") });
  reduceFactEvent(db, compiled.event);
  const graph = readFactGraphRows(db),
    owned = graph.edges.filter(
      (edge) =>
        edge.relationType === "produces" &&
        edge.sourceRef === "task/task-contract" &&
        edge.targetRef === "fact/F-BCDEFGHJ" &&
        edge.state === "active",
    );
  assert.equal(owned.length, 1);
  assert.equal(graph.facts[0]?.ref, "fact/F-BCDEFGHJ");
  db.close();
});
