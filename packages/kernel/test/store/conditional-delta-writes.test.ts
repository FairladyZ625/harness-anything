import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  decisionEntityId,
  deriveRelationId,
  parseFactFlowRecords,
  taskEntityId,
  type DecisionPackage,
  type EntityRelationRecord,
  type FactRecord,
  type WriteError
} from "../../src/domain/index.ts";
import { parseDecisionDocument } from "../../src/domain/decision-document.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { withTempStore } from "./helpers.ts";

test("fact append deltas from the same base snapshot both survive", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(factAppendOp("fact-a", "task_fact_owner", fact("F-AAAA1111", "Writer A fact."))));
    Effect.runSync(coordinator.enqueue(factAppendOp("fact-b", "task_fact_owner", fact("F-BBBB2222", "Writer B fact."))));

    Effect.runSync(coordinator.flush("explicit"));

    const body = readFileSync(path.join(rootDir, "harness/tasks/task_fact_owner/facts.md"), "utf8");
    const factIds = parseFactFlowRecords(body).map((record) => record.fact_id).sort();
    assert.deepEqual(factIds, ["F-AAAA1111", "F-BBBB2222"]);
  });
});

test("decision relation append deltas from the same base snapshot both survive", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(decisionSnapshotOp("decision-base", decisionPackage({ state: "active" }), null)));
    Effect.runSync(coordinator.flush("explicit"));
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_TEST/decision.md");
    const bodyBeforeRelations = decisionBody(readFileSync(decisionPath, "utf8"));

    const base = decisionPackage({ state: "active", _coordinatorWatermark: "decision-base" });
    const relationA = relationRecord("decision/dec_TEST/C1", "fact/task_fact_owner/F-AAAA1111");
    const relationB = relationRecord("decision/dec_TEST/C1", "fact/task_fact_owner/F-BBBB2222");
    Effect.runSync(coordinator.enqueue(decisionRelationAppendOp("relation-a", base, relationA)));
    Effect.runSync(coordinator.enqueue(decisionRelationAppendOp("relation-b", base, relationB)));

    Effect.runSync(coordinator.flush("explicit"));

    const body = readFileSync(decisionPath, "utf8");
    const decision = parseDecisionDocument(body).decision;
    assert.deepEqual(decision.relations.map((relation) => relation.relation_id).sort(), [
      relationA.relation_id,
      relationB.relation_id
    ].sort());
    assert.equal(decision._coordinatorWatermark, "relation-b");
    assert.equal(decisionBody(body), bodyBeforeRelations);
  });
});

test("stale decision snapshot CAS is rejected with retryable current watermark", () => {
  withTempStore((rootDir) => {
    const baseCoordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(baseCoordinator.enqueue(decisionSnapshotOp("decision-base", decisionPackage({ state: "proposed" }), null)));
    Effect.runSync(baseCoordinator.flush("explicit"));

    const sameSnapshotWatermark = "decision-base";
    const writerA = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(writerA.enqueue(decisionSnapshotOp(
      "decision-writer-a",
      decisionPackage({ state: "active", decidedAt: "2026-07-05T00:00:00.000Z", _coordinatorWatermark: sameSnapshotWatermark }),
      sameSnapshotWatermark
    )));
    Effect.runSync(writerA.flush("explicit"));

    const writerB = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(writerB.enqueue(decisionSnapshotOp(
      "decision-writer-b",
      decisionPackage({ state: "rejected", decidedAt: "2026-07-05T00:01:00.000Z", _coordinatorWatermark: sameSnapshotWatermark }),
      sameSnapshotWatermark
    )));
    const result = Effect.runSync(Effect.either(writerB.flush("explicit")));

    assert.equal(result._tag, "Left");
    const error = result._tag === "Left" ? result.left : null;
    assert.deepEqual(error, {
      _tag: "WriteRejected",
      entityId: "decision/dec_TEST",
      reason: "cas_watermark_mismatch: expected decision-base but current is decision-writer-a",
      code: "cas_watermark_mismatch",
      currentWatermark: "decision-writer-a",
      expectedWatermark: "decision-base",
      retryable: true
    } satisfies WriteError);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_TEST/decision.md"), "utf8");
    assert.match(body, /^state: active$/mu);
    assert.match(body, /^_coordinatorWatermark: decision-writer-a$/mu);
  });
});

test("decision snapshot without an explicit body preserves the existing body bytes", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const originalBody = "Original rationale.\n\n## Evidence\n\nByte-stable prose.\n";
    Effect.runSync(coordinator.enqueue(decisionSnapshotOp(
      "decision-base",
      decisionPackage({ state: "proposed" }),
      null,
      originalBody
    )));
    Effect.runSync(coordinator.flush("explicit"));
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_TEST/decision.md");
    const before = decisionBody(readFileSync(decisionPath, "utf8"));

    Effect.runSync(coordinator.enqueue(decisionSnapshotOp(
      "decision-amend",
      decisionPackage({ state: "proposed", title: "Amended title", _coordinatorWatermark: "decision-base" }),
      "decision-base"
    )));
    Effect.runSync(coordinator.flush("explicit"));

    assert.equal(decisionBody(readFileSync(decisionPath, "utf8")), before);
  });
});

test("decision snapshot body append is idempotent by heading across different rationales", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const section = "## Judgment-only acceptance\n\nThe arbiter accepts this policy choice.";
    Effect.runSync(coordinator.enqueue(decisionSnapshotOp(
      "decision-base",
      decisionPackage({ state: "proposed" }),
      null,
      "Original rationale."
    )));
    Effect.runSync(coordinator.flush("explicit"));

    Effect.runSync(coordinator.enqueue(decisionSnapshotOp(
      "decision-accept-one",
      decisionPackage({ state: "active", _coordinatorWatermark: "decision-base" }),
      "decision-base",
      undefined,
      section
    )));
    Effect.runSync(coordinator.flush("explicit"));
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_TEST/decision.md");
    const afterFirstAppend = decisionBody(readFileSync(decisionPath, "utf8"));

    Effect.runSync(coordinator.enqueue(decisionSnapshotOp(
      "decision-accept-two",
      decisionPackage({ state: "active", _coordinatorWatermark: "decision-accept-one" }),
      "decision-accept-one",
      undefined,
      "## Judgment-only acceptance\n\nA later acceptance uses different words."
    )));
    Effect.runSync(coordinator.flush("explicit"));
    const afterSecondAppend = decisionBody(readFileSync(decisionPath, "utf8"));

    assert.equal(afterSecondAppend, afterFirstAppend);
    assert.equal(afterSecondAppend.split("## Judgment-only acceptance").length - 1, 1);
  });
});

function factAppendOp(opId: string, taskId: string, record: FactRecord) {
  return {
    opId,
    entityId: taskEntityId(taskId),
    kind: "doc_write" as const,
    payload: {
      path: "facts.md",
      appendRecord: {
        kind: "fact-record/v1",
        record
      }
    }
  };
}

function decisionSnapshotOp(
  opId: string,
  decision: DecisionPackage,
  expectedWatermark: string | null,
  body?: string,
  appendBody?: string
) {
  return {
    opId,
    entityId: decisionEntityId(decision.decision_id),
    kind: "decision_amend" as const,
    payload: {
      decision,
      ...(body !== undefined ? { body } : {}),
      writeMode: {
        kind: "snapshot",
        expectedWatermark,
        ...(appendBody !== undefined ? { appendBody } : {})
      }
    }
  };
}

function decisionBody(document: string): string {
  return document.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "");
}

function decisionRelationAppendOp(opId: string, current: DecisionPackage, relation: EntityRelationRecord) {
  return {
    opId,
    entityId: decisionEntityId(current.decision_id),
    kind: "decision_relate" as const,
    payload: {
      decision: {
        ...current,
        relations: [relation]
      },
      writeMode: {
        kind: "append_relation",
        relation
      }
    }
  };
}

function fact(factId: string, statement: string): FactRecord {
  return {
    fact_id: factId,
    statement,
    source: "test",
    observedAt: "2026-07-04T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{
      runtime: "human",
      sessionId: "session-1",
      boundAt: "2026-07-04T00:00:00.000Z"
    }]
  };
}

function decisionPackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_TEST",
    title: "Test decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: ["kernel"],
      productLines: []
    },
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-07-02T00:00:00Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    provenance: [{
      runtime: "codex",
      sessionId: "session-1",
      boundAt: "2026-07-02T00:00:00Z"
    }],
    question: "Should this test write a decision?",
    chosen: [{ id: "CH1", text: "Write it through the coordinator." }],
    rejected: [{ id: "RJ1", text: "Write it by hand.", why_not: "Machine-readable decision frontmatter needs a coordinator watermark." }],
    claims: [{ id: "C1", text: "Coordinator writes are auditable." }],
    relations: [],
    ...overrides
  };
}

function relationRecord(source: string, target: string): EntityRelationRecord {
  const base = {
    source,
    target,
    type: "supersedes-fact",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "The linked fact supports the decision claim.",
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return {
    relation_id: deriveRelationId(base),
    ...base
  };
}
