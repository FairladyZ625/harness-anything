// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { CAUSAL_CONTEXT_MAX_BYTES, assembleTaskCausalContext } from "../src/dispatch-causal-context.ts";

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

/**
 * The grammar every interior line of a <task-context> block obeys: one complete
 * element per line, escaped attributes (`"` `<` `&` never raw), symmetric open
 * and close tags or a self-closing slash. Any subset of these lines parses the
 * same way — that is the determinism contract budget shedding relies on.
 */
function assertLineGrammar(block: string): void {
  const lines = block.split("\n");
  assert.ok(lines.length >= 3, "a block needs at least the root pair and a refs line");
  assert.match(lines[0]!, /^<task-context(?: truncated="yes")?>$/u, "root open line");
  assert.equal(lines.at(-1), "</task-context>", "root close line");
  for (const line of lines.slice(1, -1)) {
    assert.match(
      line,
      /^<([a-z]+)((?: [a-z-]+="[^"]*")*)(?:\/>|>[^<]*<\/\1>)$/u,
      `line is not one complete element: ${line}`,
    );
    assert.doesNotMatch(line, /&(?!amp;|lt;|gt;|quot;)/u, `raw ampersand outside an entity: ${line}`);
  }
}

test("a task with no causal neighborhood injects no block", () => {
  assert.equal(assembleTaskCausalContext({ projection: stub(), taskId: "task_lonely" }), null);
});

test("the block carries work, decision, and fact refs at one cut", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        {
          taskId: "task_root",
          title: "Work goal",
          taskClass: "work",
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
  assertLineGrammar(block);
  assert.match(block, /^<task-context>\n/u);
  assert.match(block, /<work ref="task\/task_root">Work goal<\/work>/u);
  assert.match(block, /<goal ref="task\/task_root">Ship the causal tree\.<\/goal>/u);
  assert.match(block, /<decision ref="decision\/dec_ABC" title="Completion generalization"\/>/u);
  assert.match(
    block,
    /<chosen ref="decision\/dec_ABC" anchor="CH1">Declarative evidence set — Verifiable without merge<\/chosen>/u,
  );
  assert.match(block, /<claims ref="decision\/dec_ABC">C1 submit supports artifact-only<\/claims>/u);
  assert.match(
    block,
    /<fact ref="fact\/F-0001">submit persists artifact-only receipts \(src:packages\/x.ts\)<\/fact>/u,
  );
  assert.match(block, /<question ref="decision\/dec_ABC">How are receipts delivered\?<\/question>/u);
  assert.match(block, /<refs>task\/task_root decision\/dec_ABC fact\/F-0001<\/refs>/u);
  assert.ok(Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES);
});

test("free text is XML-escaped exactly once in elements and attributes", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        {
          taskId: "task_root",
          title: 'A <B> & "C"',
          taskClass: "work",
          parentTaskId: null,
          packagePath: "tasks/root",
        },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_root" },
      ],
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assertLineGrammar(block);
  assert.match(block, /<work ref="task\/task_root">A &lt;B&gt; &amp; &quot;C&quot;<\/work>/u);
  assert.doesNotMatch(block, /<work ref="task\/task_root">A [<>"]|C["<]/u, "raw markup must not ride the text node");
});

test("assembly is deterministic: same projection content renders byte-identical XML", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        {
          taskId: "task_root",
          title: "Determinism work",
          taskClass: "work",
          parentTaskId: null,
          packagePath: "tasks/r",
        },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_root" },
      ],
    }),
  });
  const first = assembleTaskCausalContext({ projection, taskId: "task_leaf" }),
    second = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(first !== null && second !== null);
  assert.equal(first, second);
});

test("archived facts leave the injected block while their edges stay canonical", () => {
  const projection = stub({
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
          title: "Archive read face",
          question: "",
          chosen: [{ id: "CH1", text: "Archive events retire the document", rationale: "" }],
          claims: [{ id: "C1", text: "archived facts leave the injection", loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_2",
          sourceRef: "decision/dec_ABC/C1",
          targetRef: "fact/F-ARCHIVE1",
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        },
        {
          relationId: "rel_3",
          sourceRef: "decision/dec_ABC/C1",
          targetRef: "fact/F-STANDING",
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        },
      ],
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [
        {
          ref: "fact/F-ARCHIVE1",
          statement: "archived bookkeeping noise",
          evidenceSource: "packages/x.ts",
          archived: true,
        },
        { ref: "fact/F-STANDING", statement: "still load-bearing", evidenceSource: "packages/y.ts" },
      ],
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null, "a deriving decision must produce a block");
  assert.doesNotMatch(block, /F-ARCHIVE1/u, "archived fact refs must leave the whole block, refs line included");
  assert.match(block, /<fact ref="fact\/F-STANDING">still load-bearing/u);
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
        { taskId: "task_root", title: long, taskClass: "work", parentTaskId: null, packagePath: "tasks/root" },
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
  assert.ok(
    Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
    `block is ${Buffer.byteLength(block, "utf8")} bytes`,
  );
  assert.match(block, /dec_0/u);
  assert.match(block, /…/u, "dropped detail is honestly marked");
  assert.match(block, /ref="fact\/F-1"/u, "the evidence layer survives the widened budget");
  assert.match(block, /<refs>[^<]*task_root/u, "canonical refs stay queryable");
  assert.doesNotMatch(block, /ha graph/u, "the lookup guidance lives in the mission, not the refs tail");
});

test("shed detail lines mark the root truncated while every kept line stays parseable", () => {
  // Pathological id set: two long-id decisions and five long-id facts give the
  // greedy fit more detail lines than the 2,048-byte budget can hold — the fit
  // must shed whole lines, mark the root truncated, and still parse per line.
  const longWork = `task_${"W".repeat(150)}`,
    longParent = `task_${"P".repeat(150)}`,
    longDecisions = [0, 1].map((index) => `dec_${String(index)}${"D".repeat(150)}`),
    longFacts = [0, 1, 2, 3, 4].map((index) => `fact/F-${String(index)}${"E".repeat(150)}`);
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        { taskId: longWork, title: "Long-id work", taskClass: "work", parentTaskId: null, packagePath: "tasks/w" },
        { taskId: longParent, title: "Long-id parent", taskClass: "standard", parentTaskId: longWork },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: longParent },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: longDecisions.map((decisionId, index) => ({
        relationId: `rel_${index}`,
        sourceRef: `decision/${decisionId}/CH1`,
        targetRef: "task/task_leaf",
        relationType: "derives",
        direction: "directed",
        state: "active",
      })),
    }),
    readDecisions: () => ({
      ...cut(),
      decisions: longDecisions.map((decisionId) => ({
        decisionId,
        title: "Long-id decision",
        question: "Which lines survive?",
        chosen: [{ id: "CH1", text: "Greedy fit keeps identity first", rationale: "Refs stay queryable" }],
        claims: [{ id: "C1", text: "shed lines are whole lines", loadBearing: true }],
      })),
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: longFacts.map((ref, index) => ({
        relationId: `rel_f${index}`,
        sourceRef: `decision/${longDecisions[0]}/C1`,
        targetRef: ref,
        relationType: "evidenced-by",
        direction: "directed",
        state: "active",
      })),
    }),
    searchFacts: () => ({
      ...cut(),
      facts: longFacts.map((ref) => ({ ref, statement: "long-id fact", evidenceSource: "packages/x.ts" })),
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.ok(
    Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
    `block is ${Buffer.byteLength(block, "utf8")} bytes`,
  );
  assert.match(block, /^<task-context truncated="yes">\n/u, "shed detail lines mark the root truncated");
  assert.match(block, /<work ref="task\/task_W+">Long-id work<\/work>/u, "identity lines outrank detail tails");
  assert.match(block, /<parent ref="task\/task_P+">Long-id parent<\/parent>/u, "both identity lines fit");
  assert.doesNotMatch(block, /Long-id decision/u, "the decision detail layer was shed whole");
  assert.match(
    block,
    /<refs>[^<]*task\/task_W+[^<]*decision\/dec_0D+[^<]*fact\/F-0E+[^<]*<\/refs>/u,
    "refs survive shedding",
  );
  assertLineGrammar(block);
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
          taskClass: "work",
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
  assert.ok(
    Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
    `block is ${Buffer.byteLength(block, "utf8")} bytes`,
  );
  assert.match(block, /^<task-context[^>]*>\n/u);
  assert.match(block, /<refs>[^<]*fact\/F-long/u);
  assert.doesNotMatch(block, /ha graph/u, "the lookup guidance lives in the mission, not the refs tail");
});
