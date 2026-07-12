// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deriveRelationId,
  formatFactFlowRecord,
  formatRelationFlowRecord,
  readDecisionFactCoverage,
  rebuildTaskProjection,
  sha256Text
} from "../../src/index.ts";
import type { EntityRelationRecord } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("relation graph coverage rejects non-evidence paths and supersession edges", () => {
  withTempStore((rootDir) => {
    writeTask(rootDir, "task-non-evidence", [relationRecord({
      source: "task/task-non-evidence",
      target: "fact/task-non-evidence/F-DEADBEEF",
      type: "produces"
    })]);
    writeDecision(rootDir, "dec_RELATES_PATH", [relationRecord({
      source: "decision/dec_RELATES_PATH/C1",
      target: "task/task-non-evidence",
      type: "relates"
    })]);
    writeDecision(rootDir, "dec_DERIVES_PATH", [relationRecord({
      source: "decision/dec_DERIVES_PATH/C1",
      target: "task/task-non-evidence",
      type: "derives"
    })]);
    writeDecision(rootDir, "dec_SUPERSEDES_PATH", [relationRecord({
      source: "decision/dec_SUPERSEDES_PATH/C1",
      target: "fact/task-non-evidence/F-DEADBEEF",
      type: "supersedes-fact"
    })]);

    rebuildTaskProjection({ rootDir });

    for (const decisionId of ["dec_RELATES_PATH", "dec_DERIVES_PATH", "dec_SUPERSEDES_PATH"]) {
      assert.deepEqual(readDecisionFactCoverage({ rootDir, decisionId }).rows, [{
        decisionRef: `decision/${decisionId}`,
        claimRef: `decision/${decisionId}/C1`,
        status: "uncovered",
        relationPath: []
      }]);
    }
  });
});

test("relation graph coverage records active fact refutations and keeps the claim uncovered", () => {
  withTempStore((rootDir) => {
    const supportingFactRef = "fact/task-refutation/F-DEADBEEF";
    const refutingFactRef = "fact/task-refutation/F-FEEDFACE";
    writeTask(rootDir, "task-refutation", [relationRecord({
      source: refutingFactRef,
      target: "decision/dec_REFUTED/C1",
      type: "refutes"
    })], true);
    writeDecision(rootDir, "dec_REFUTED", [relationRecord({
      source: "decision/dec_REFUTED/C1",
      target: supportingFactRef,
      type: "evidenced-by"
    })]);

    rebuildTaskProjection({ rootDir });

    assert.deepEqual(readDecisionFactCoverage({ rootDir, decisionId: "dec_REFUTED" }).rows, [{
      decisionRef: "decision/dec_REFUTED",
      claimRef: "decision/dec_REFUTED/C1",
      status: "uncovered",
      refutingFactRefs: [refutingFactRef],
      relationPath: []
    }]);
  });
});

test("relation graph coverage dispatches only by explicit claim fulfillment", () => {
  withTempStore((rootDir) => {
    const deliveredTaskId = "task_01KXAMRP4D7VF0HPSSEEK2VHX7";
    writeTask(rootDir, "task-evidenced", []);
    writeDoneTask(rootDir, deliveredTaskId);
    writeDecisionFixture(rootDir, "dec_EVIDENCED", { fulfillment: "evidenced" });
    writeDecisionFixture(rootDir, "dec_DELIVERED", {
      fulfillment: "delivered",
      relations: [relationRecord({
        source: "decision/dec_DELIVERED/C1",
        target: `task/${deliveredTaskId}`,
        type: "derives"
      })]
    });
    writeDecisionFixture(rootDir, "dec_POLICY", { fulfillment: "standing-policy" });
    writeDecisionFixture(rootDir, "dec_UNDECLARED", {
      relations: [relationRecord({
        source: "decision/dec_UNDECLARED/C1",
        target: `task/${deliveredTaskId}`,
        type: "derives"
      })]
    });

    rebuildTaskProjection({ rootDir });
    for (const decisionId of ["dec_EVIDENCED", "dec_DELIVERED", "dec_POLICY", "dec_UNDECLARED"]) {
      assert.equal(coverageStatus(rootDir, decisionId), "uncovered");
    }

    writeDecisionFixture(rootDir, "dec_EVIDENCED", {
      fulfillment: "evidenced",
      relations: [relationRecord({
        source: "decision/dec_EVIDENCED/C1",
        target: "fact/task-evidenced/F-DEADBEEF",
        type: "evidenced-by"
      })]
    });
    writeExecution(rootDir, deliveredTaskId, false);
    writeDecisionFixture(rootDir, "dec_POLICY", { fulfillment: "standing-policy", appliesTo: ["kernel"] });
    rebuildTaskProjection({ rootDir });

    assert.equal(coverageStatus(rootDir, "dec_EVIDENCED"), "covered");
    assert.equal(coverageStatus(rootDir, "dec_DELIVERED"), "uncovered");
    assert.equal(coverageStatus(rootDir, "dec_POLICY"), "covered");
    assert.equal(coverageStatus(rootDir, "dec_UNDECLARED"), "uncovered");

    writeExecution(rootDir, deliveredTaskId, true);
    rebuildTaskProjection({ rootDir });

    assert.equal(coverageStatus(rootDir, "dec_DELIVERED"), "covered");
    assert.equal(coverageStatus(rootDir, "dec_UNDECLARED"), "uncovered");
  });
});

function writeTask(
  rootDir: string,
  taskId: string,
  relations: ReadonlyArray<EntityRelationRecord>,
  includeRefutingFact = false
): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "---",
    ""
  ].join("\n"));
  const facts = [
    formatFact("F-DEADBEEF", "The reachable fact."),
    ...(includeRefutingFact ? [formatFact("F-FEEDFACE", "The refuting fact.")] : [])
  ];
  writeFileSync(path.join(taskRoot, "facts.md"), [
    ...facts,
    "",
    "relations:",
    ...relations.map(formatRelationFlowRecord),
    ""
  ].join("\n"));
}

function formatFact(factId: string, statement: string): string {
  return formatFactFlowRecord({
    fact_id: factId,
    statement,
    source: "test",
    observedAt: "2026-07-03T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "human", sessionId: "fixture", boundAt: "2026-07-03T00:00:00.000Z" }]
  });
}

function writeDecision(rootDir: string, decisionId: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    "claims:",
    "  - { id: \"C1\", text: \"Fixture claim\" }",
    "relations:",
    ...relations.map(formatRelationFlowRecord),
    "---",
    ""
  ].join("\n"));
}

function writeDecisionFixture(rootDir: string, decisionId: string, input: {
  readonly fulfillment?: "evidenced" | "delivered" | "standing-policy";
  readonly appliesTo?: ReadonlyArray<string>;
  readonly relations?: ReadonlyArray<EntityRelationRecord>;
}): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  const fulfillment = input.fulfillment ? `, fulfillment: "${input.fulfillment}"` : "";
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    "applies_to:",
    `  modules: ${JSON.stringify(input.appliesTo ?? [])}`,
    "  productLines: []",
    "claims:",
    `  - { id: "C1", text: "Fixture claim"${fulfillment} }`,
    "relations:",
    ...(input.relations ?? []).map(formatRelationFlowRecord),
    "---",
    ""
  ].join("\n"));
}

function writeDoneTask(rootDir: string, taskId: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "lifecycle:",
    "  engine: local",
    "  status: done",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "facts.md"), "");
}

function writeExecution(rootDir: string, taskId: string, withReceipt: boolean): void {
  const executionId = "exe_01KXAMRP4D7VF0HPSSEEK2VHX7";
  const text = "verified delivery";
  const digest = sha256Text(text);
  const output = {
    evidence_id: "output-1",
    execution_ref: `execution/${taskId}/${executionId}`,
    locator: { substrate: "inline", text },
    sha256: digest,
    ...(withReceipt ? { checker_receipt_ref: "receipt-1" } : {})
  };
  const receipt = {
    evidence_id: "receipt-1",
    execution_ref: `execution/${taskId}/${executionId}`,
    locator: {
      substrate: "checker_receipt",
      receipt: {
        checker_id: "test-checker",
        checker_version: "1",
        target_evidence_id: "output-1",
        target_sha256: digest,
        checked_at: "2026-07-12T00:00:00.000Z",
        result: "pass"
      }
    }
  };
  const executionRoot = path.join(rootDir, "harness/tasks", taskId, "executions");
  mkdirSync(executionRoot, { recursive: true });
  writeFileSync(path.join(executionRoot, `${executionId}.md`), JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "accepted",
    primary_actor: {
      principal: { personId: "person_zeyu" },
      executor: { kind: "agent", id: "codex" },
      responsibleHuman: "person_zeyu"
    },
    claimed_at: "2026-07-12T00:00:00.000Z",
    submitted_at: "2026-07-12T00:01:00.000Z",
    closed_at: "2026-07-12T00:02:00.000Z",
    session_bindings: [],
    outputs: withReceipt ? [output, receipt] : [output],
    submission: null
  }, null, 2));
}

function coverageStatus(rootDir: string, decisionId: string): "covered" | "uncovered" | undefined {
  return readDecisionFactCoverage({ rootDir, decisionId }).rows[0]?.status;
}

function relationRecord(input: {
  readonly source: string;
  readonly target: string;
  readonly type: EntityRelationRecord["type"];
}): EntityRelationRecord {
  const identity = { ...input, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active"
  };
}
