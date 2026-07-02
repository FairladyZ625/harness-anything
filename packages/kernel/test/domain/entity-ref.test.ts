import assert from "node:assert/strict";
import test from "node:test";
import { findEntityRefs, parseEntityRef } from "../../src/domain/entity-ref.ts";
import {
  deriveRelationId,
  formatRelationFlowRecord,
  validateRelationRecordsForHost
} from "../../src/domain/entity-relation.ts";
import type { EntityRelationRecord } from "../../src/domain/entity-relation.ts";

test("EntityRef parser accepts local and prefixed task references", () => {
  assert.deepEqual(parseEntityRef("task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q"), {
    raw: "task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    kind: "task",
    id: "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    externalHarness: false
  });
  assert.deepEqual(parseEntityRef("team-a:task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q"), {
    raw: "team-a:task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    kind: "task",
    id: "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    harnessAlias: "team-a",
    externalHarness: true
  });
  assert.equal(parseEntityRef("issue/123"), null);
  assert.equal(parseEntityRef("task/v1"), null);
  assert.equal(parseEntityRef("task/doc"), null);
});

test("EntityRef parser accepts M3 decision and fact endpoints", () => {
  assert.deepEqual(parseEntityRef("decision/dec_01K7Z/C1"), {
    raw: "decision/dec_01K7Z/C1",
    kind: "decision",
    id: "dec_01K7Z",
    anchor: "C1",
    externalHarness: false
  });
  assert.deepEqual(parseEntityRef("fact/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q/F-a3f2"), {
    raw: "fact/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q/F-a3f2",
    kind: "fact",
    id: "F-a3f2",
    ownerTaskId: "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    externalHarness: false
  });
  assert.equal(parseEntityRef("decision/doc"), null);
  assert.equal(parseEntityRef("fact/F-a3f2"), null);
  assert.equal(parseEntityRef("fact/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q/not-a-fact"), null);
});

test("EntityRef scanner preserves external harness prefixes without resolving them", () => {
  const refs = findEntityRefs("depends on task/local-task and other-harness:task/remote-task");

  assert.deepEqual(refs.map((ref) => [ref.raw, ref.externalHarness]), [
    ["task/local-task", false],
    ["other-harness:task/remote-task", true]
  ]);
});

test("EntityRef scanner ignores task-like prose, package markers, and paths", () => {
  const refs = findEntityRefs([
    "Task Contract: harness-task/v1",
    "workspace has task/doc/terminal panes",
    "path scripts/domain/task/task-subjects.mts",
    "real refs task/local-task, decision/decision-local/C1, and fact/task_local/F-a3f2 remain"
  ].join("\n"));

  assert.deepEqual(refs.map((ref) => ref.raw), ["task/local-task", "decision/decision-local/C1", "fact/task_local/F-a3f2"]);
});

test("relation ids are deterministic and ignore mutable relation attributes", () => {
  const base = relationRecord();
  const variant = {
    ...base,
    strength: "weak",
    rationale: "Different rationale, same canonical edge.",
    state: "deprecated"
  } satisfies EntityRelationRecord;

  assert.equal(deriveRelationId(base), "rel_2bd3fbc51839e11e");
  assert.equal(deriveRelationId(base), deriveRelationId(variant));
});

test("relation validator rejects host drift, duplicates, missing rationale, and invalid endpoints", () => {
  const base = relationRecord();
  const duplicateWithDifferentAttributes = {
    ...base,
    strength: "weak",
    rationale: "A different authored attribute set on the same canonical edge."
  } satisfies EntityRelationRecord;

  assert.deepEqual(
    validateRelationRecordsForHost("decision/dec_01K7ZTRIADIC", [base, duplicateWithDifferentAttributes])
      .map((issue) => issue.code),
    ["duplicate_relation_id"]
  );
  assert.deepEqual(
    validateRelationRecordsForHost("decision/dec_OTHER", [base])
      .map((issue) => issue.code),
    ["relation_host_source_mismatch"]
  );
  assert.deepEqual(
    validateRelationRecordsForHost("decision/dec_01K7ZTRIADIC", [{ ...base, rationale: "   " }])
      .map((issue) => issue.code),
    ["relation_rationale_missing"]
  );
  assert.deepEqual(
    validateRelationRecordsForHost("decision/dec_01K7ZTRIADIC", [{ ...base, target: "fact/F-a3f2" }])
      .map((issue) => issue.code),
    ["invalid_relation_endpoint"]
  );
});

test("relation flow formatter emits one flow-style line per record", () => {
  const line = formatRelationFlowRecord(relationRecord());

  assert.equal(line.includes("\n"), false);
  assert.equal(line.startsWith("- {relation_id: rel_2bd3fbc51839e11e,"), true);
  assert.equal(line.endsWith("state: active}"), true);
  assert.match(line, /rationale: "C1 is supported by the measured finding F-a3f2\."/u);
});

function relationRecord(): EntityRelationRecord {
  return {
    relation_id: "rel_2bd3fbc51839e11e",
    source: "decision/dec_01K7ZTRIADIC/C1",
    target: "fact/task_01KV5TBASE/F-a3f2",
    type: "supports",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "C1 is supported by the measured finding F-a3f2.",
    state: "active"
  };
}
