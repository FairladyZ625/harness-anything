// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "../../kernel/src/index.ts";
import { assembleTaskCausalContext } from "../src/dispatch-causal-context.ts";

const cut = (revision = 1) => ({ status: "ready" as const, watermark: revision, sourceRevision: revision });

function stub(overrides: Record<string, unknown> = {}): TaskProjection {
  return {
    readCut: () => cut(),
    readTaskIndex: () => ({ ...cut(), rows: [] }),
    readTaskRelationsByTargets: () => ({ ...cut(), rows: [] }),
    readDecisions: () => ({ ...cut(), decisions: [] }),
    readRelationQuery: () => ({ ...cut(), rows: [] }),
    searchFacts: () => ({ ...cut(), facts: [] }),
    readDocument: () => ({ ...cut(), document: null }),
    ...overrides,
  } as unknown as TaskProjection;
}

test("a task with no causal neighborhood injects no block", () => {
  assert.equal(assembleTaskCausalContext({ projection: stub(), taskId: "task_lonely" }), null);
});

test("the block carries milestone, decision, and fact refs at one cut", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        {
          taskId: "task_root",
          title: "Milestone goal",
          taskClass: "milestone",
          parentTaskId: null,
          packagePath: "tasks/root",
        },
        {
          taskId: "task_leaf",
          title: "Leaf",
          taskClass: "standard",
          parentTaskId: "task_root",
          packagePath: "tasks/leaf",
        },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_1",
          sourceRef: "decision/dec_ABC/CH1",
          targetRef: "task/task_leaf",
          relationType: "derives",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    readDecisions: () => ({
      ...cut(),
      decisions: [
        {
          decisionId: "dec_ABC",
          title: "Completion generalization",
          question: "How are receipts delivered?",
          chosen: [{ id: "CH1", text: "Declarative evidence set", rationale: "Verifiable without merge" }],
          claims: [{ id: "C1", text: "submit supports artifact-only", loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_2",
          sourceRef: "decision/dec_ABC/C1",
          targetRef: "fact/F-0001",
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [
        { ref: "fact/F-0001", statement: "submit persists artifact-only receipts", evidenceSource: "packages/x.ts" },
      ],
    }),
    readDocument: () => ({
      ...cut(),
      document: { body: "# Root\n\n## Goal\n\nShip the causal tree.\n\n## Other\n\nignored\n" },
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.match(block, /^# Task Causal Context\n/u);
  assert.match(block, /- Milestone: Milestone goal\n/u);
  assert.match(block, /Goal: Ship the causal tree\./u);
  assert.match(block, /- Decision: dec_ABC "Completion generalization"/u);
  assert.match(block, /Chosen CH1: Declarative evidence set — Verifiable without merge/u);
  assert.match(block, /C1 submit supports artifact-only/u);
  assert.match(block, /F-0001: submit persists artifact-only receipts \(src:packages\/x.ts\)/u);
  assert.ok(Buffer.byteLength(block, "utf8") <= 2048);
});

test("a cut advancing mid-read is rejected instead of serving a mixed view", () => {
  let reads = 0;
  const projection = stub({
    readTaskIndex: () => ({ ...cut(++reads), rows: [] }),
    readTaskRelationsByTargets: () => ({ ...cut(++reads), rows: [] }),
  });
  assert.throws(
    () => assembleTaskCausalContext({ projection, taskId: "task_x" }),
    /spans multiple event projection cuts/u,
  );
});

test("oversized CJK content truncates inside the byte budget and keeps refs", () => {
  const long = "承".repeat(400);
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        { taskId: "task_root", title: long, taskClass: "milestone", parentTaskId: null, packagePath: "tasks/root" },
        {
          taskId: "task_leaf",
          title: "Leaf",
          taskClass: "standard",
          parentTaskId: "task_root",
          packagePath: "tasks/leaf",
        },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: [0, 1].map((index) => ({
        relationId: `rel_${index}`,
        sourceRef: `decision/dec_${index}/CH1`,
        targetRef: "task/task_leaf",
        relationType: "derives",
        direction: "directed",
        state: "active",
      })),
    }),
    readDecisions: () => ({
      ...cut(),
      decisions: [0, 1].map((index) => ({
        decisionId: `dec_${index}`,
        title: long,
        question: long,
        chosen: [{ id: "CH1", text: long, rationale: long }],
        claims: [0, 1, 2].map((c) => ({ id: `C${c + 1}`, text: long, loadBearing: true })),
      })),
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_f",
          sourceRef: "decision/dec_0/C1",
          targetRef: "fact/F-1",
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [{ ref: "fact/F-1", statement: long, evidenceSource: long }],
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.ok(Buffer.byteLength(block, "utf8") <= 2048, `block is ${Buffer.byteLength(block, "utf8")} bytes`);
  assert.match(block, /dec_0/u);
  assert.match(block, /…/u, "dropped detail is honestly marked");
  assert.match(block, /F-1:/u, "the evidence layer survives the widened budget");
  assert.match(block, /Refs: .*ha graph task_leaf/u, "canonical refs stay queryable");
});

test("ASCII noise, long ids, and long source paths stay inside the byte budget", () => {
  const noise = "x9Qz".repeat(300),
    longId = `dec_${"A".repeat(120)}`,
    longPath = `packages/${"deep/".repeat(40)}source.ts`;
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        {
          taskId: "task_root",
          title: noise,
          taskClass: "milestone",
          parentTaskId: null,
          packagePath: "tasks/root",
        },
        {
          taskId: "task_leaf",
          title: "Leaf",
          taskClass: "standard",
          parentTaskId: "task_root",
          packagePath: "tasks/leaf",
        },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_1",
          sourceRef: `decision/${longId}/CH1`,
          targetRef: "task/task_leaf",
          relationType: "derives",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    readDecisions: () => ({
      ...cut(),
      decisions: [
        {
          decisionId: longId,
          title: noise,
          question: noise,
          chosen: [{ id: "CH1", text: noise, rationale: noise }],
          claims: [{ id: "C1", text: noise, loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_f",
          sourceRef: `decision/${longId}/C1`,
          targetRef: "fact/F-long",
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [{ ref: "fact/F-long", statement: noise, evidenceSource: longPath }],
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.ok(Buffer.byteLength(block, "utf8") <= 2048, `block is ${Buffer.byteLength(block, "utf8")} bytes`);
  assert.match(block, /^# Task Causal Context\n/u);
  assert.match(block, /ha graph task_leaf/u);
});
