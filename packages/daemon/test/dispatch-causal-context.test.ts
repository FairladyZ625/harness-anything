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
  assert.match(block, /^<task-context>\n<note>/u, "the facts note opens the block whenever facts serve");
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

test("decision chosen, claims, question, fact statements, and titles render at full length", () => {
  const long = "满".repeat(120);
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        { taskId: "task_root", title: long, taskClass: "work", parentTaskId: null, packagePath: "tasks/root" },
        {
          taskId: "task_mid",
          title: long,
          taskClass: "standard",
          parentTaskId: "task_root",
          packagePath: "tasks/mid",
        },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_mid" },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_1",
          sourceRef: "decision/dec_FULL/CH1",
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
          decisionId: "dec_FULL",
          title: long,
          question: long,
          chosen: [{ id: "CH1", text: long, rationale: long }],
          claims: [{ id: "C1", text: long, loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_2",
          sourceRef: "decision/dec_FULL/C1",
          targetRef: "fact/F-FULL",
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
          ref: "fact/F-FULL",
          statement: long,
          evidenceSource: "packages/deeply/nested/source/directory/tree/leaf/file.ts",
        },
      ],
    }),
    readDocument: () => ({
      ...cut(),
      document: { body: `# Root\n\n## Goal\n\n${long}\n\n## Other\n\nignored\n` },
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assertLineGrammar(block);
  assert.ok(!block.includes("…"), "nothing inside the budget is field-truncated anymore");
  assert.match(block, new RegExp(`<work ref="task/task_root">${long}</work>`, "u"));
  assert.match(block, new RegExp(`<parent ref="task/task_mid">${long}</parent>`, "u"));
  assert.match(block, new RegExp(`<decision ref="decision/dec_FULL" title="${long}"/>`, "u"));
  assert.match(block, new RegExp(`<chosen ref="decision/dec_FULL" anchor="CH1">${long} — ${long}</chosen>`, "u"));
  assert.match(block, new RegExp(`<claims ref="decision/dec_FULL">C1 ${long}</claims>`, "u"));
  assert.match(
    block,
    new RegExp(
      `<fact ref="fact/F-FULL">${long} \\(src:packages/deeply/nested/source/directory/tree/leaf/file.ts\\)</fact>`,
      "u",
    ),
  );
  assert.match(block, new RegExp(`<question ref="decision/dec_FULL">${long}</question>`, "u"));
  assert.match(block, new RegExp(`<goal ref="task/task_root">${long}</goal>`, "u"));
  assert.ok(Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES);
});

test("an over-budget neighborhood sheds whole facts from the far end and notes every omitted ref", () => {
  // Facts are the farthest layer (task ← derives ← decision ← evidenced-by): with five
  // ~2.1 KB statements the 8,192-byte budget holds identity, the deriving decision, and
  // the first three facts, sheds the last two whole, and names each dropped ref.
  const heavy = `重${"承".repeat(699)}`;
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        { taskId: "task_root", title: "Budget work", taskClass: "work", parentTaskId: null, packagePath: null },
        { taskId: "task_mid", title: "Budget parent", taskClass: "standard", parentTaskId: "task_root" },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_mid" },
      ],
    }),
    readTaskRelationsByTargets: () => ({
      ...cut(),
      rows: [
        {
          relationId: "rel_1",
          sourceRef: "decision/dec_BUDGET/CH1",
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
          decisionId: "dec_BUDGET",
          title: "Budget decision",
          question: "Which layer sheds first?",
          chosen: [{ id: "CH1", text: "The one contract that derives this task", rationale: "Kept whole" }],
          claims: [{ id: "C1", text: "chosen clauses are never field-truncated", loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({
      ...cut(),
      rows: [0, 1, 2, 3, 4].map((index) => ({
        relationId: `rel_f${index}`,
        sourceRef: "decision/dec_BUDGET/C1",
        targetRef: `fact/F-${index}`,
        relationType: "evidenced-by",
        direction: "directed",
        state: "active",
      })),
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [0, 1, 2, 3, 4].map((index) => ({
        ref: `fact/F-${index}`,
        statement: heavy,
        evidenceSource: "packages/x.ts",
      })),
    }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.ok(
    Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
    `block is ${Buffer.byteLength(block, "utf8")} bytes`,
  );
  assert.match(block, /^<task-context truncated="yes">\n/u, "shed entries mark the root truncated");
  assert.match(block, /<work ref="task\/task_root">Budget work<\/work>/u, "identity lines outrank facts");
  assert.match(block, /The one contract that derives this task — Kept whole/u, "the decision layer survives");
  assert.ok(block.includes(heavy), "the first facts ride at full length");
  assert.match(block, /<fact ref="fact\/F-2">/u);
  assert.doesNotMatch(block, /<fact ref="fact\/F-[34]">/u, "the farthest facts are shed whole");
  assert.match(block, /<omitted>[^<]*fact\/F-3[^<]*fact\/F-4[^<]*<\/omitted>/u, "omitted refs are named at the end");
  assert.match(
    block,
    /<refs>[^<]*fact\/F-4[^<]*<\/refs>\n<omitted>/u,
    "shed refs stay queryable ahead of the omission note",
  );
  assert.doesNotMatch(block, /ha graph/u, "the lookup guidance lives in the mission, not the refs tail");
  assertLineGrammar(block);
});

test("a details-only shed at the byte ceiling keeps the close tag instead of clamping it off", () => {
  // A fit measured against `<task-context>` (14 B) but emitted as
  // `<task-context truncated="yes">` (30 B) can pass its budget checks and then overshoot
  // by 16 B. These statement lengths put the block in that window: at 7,512 the omission
  // note passed the old whole-root arithmetic and at 7,520/7,540 the block itself reached
  // the ceiling, so the old final clamp cut `</task-context>` off a details-only shed.
  // Fitting against the root actually emitted must leave every line whole.
  const nearCeiling = (statementBytes: number): TaskProjection => {
    const facts = [100, 100, statementBytes, 2_000].map((length, index) => ({
      ref: `fact/F-${String(index)}`,
      statement: "s".repeat(length),
      evidenceSource: "src",
    }));
    return stub({
      readTaskIndex: () => ({
        ...cut(),
        rows: [
          { taskId: "task_root", title: "Work title", taskClass: "work", parentTaskId: null, packagePath: null },
          { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_root", packagePath: null },
        ],
      }),
      readTaskRelationsByTargets: () => ({
        ...cut(),
        rows: [
          {
            relationId: "rel_1",
            sourceRef: "decision/dec_X/CH1",
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
            decisionId: "dec_X",
            title: "Decision X",
            question: "Q?",
            chosen: [{ id: "CH1", text: "chosen", rationale: "why" }],
            claims: [{ id: "C1", text: "claim", loadBearing: true }],
          },
        ],
      }),
      readRelationQuery: () => ({
        ...cut(),
        rows: facts.map((fact) => ({
          relationId: `rel_${fact.ref}`,
          sourceRef: "decision/dec_X/C1",
          targetRef: fact.ref,
          relationType: "evidenced-by",
          direction: "directed",
          state: "active",
        })),
      }),
      searchFacts: () => ({ ...cut(), facts }),
    });
  };
  for (const statementBytes of [7_512, 7_520, 7_540]) {
    const block = assembleTaskCausalContext({ projection: nearCeiling(statementBytes), taskId: "task_leaf" });
    assert.ok(block !== null);
    assert.ok(
      Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
      `${String(statementBytes)}: block is ${String(Buffer.byteLength(block, "utf8"))} bytes`,
    );
    assert.ok(block.endsWith("</task-context>"), `${String(statementBytes)}: the close tag survives`);
    assertLineGrammar(block);
  }
  const noteFits = assembleTaskCausalContext({ projection: nearCeiling(7_512), taskId: "task_leaf" });
  assert.ok(noteFits !== null);
  assert.match(
    noteFits,
    /<omitted>fact\/F-2<\/omitted>/u,
    "the fixed facts note is budgeted against the truncated root, so the omission line still fits",
  );
});

test("shed detail lines mark the root truncated while every kept line stays parseable", () => {
  // Pathological id set: two long-id decisions and five long-id facts leave the 8,192-byte
  // budget no room past the identity layer and the refs line — the fit sheds every detail
  // entry whole, marks the root truncated, and (the ids themselves cannot fit) degrades
  // the omission note to nothing rather than breaking the budget or the grammar.
  const longWork = `task_${"W".repeat(700)}`,
    longParent = `task_${"P".repeat(700)}`,
    longDecisions = [0, 1].map((index) => `dec_${String(index)}${"D".repeat(700)}`),
    longFacts = [0, 1, 2, 3, 4].map((index) => `fact/F-${String(index)}${"E".repeat(700)}`);
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
  assert.doesNotMatch(block, /<omitted>/u, "ids too long for the note degrade it to nothing, not past the budget");
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

test("facts served with an observed commit name its first 8 hex and the record time", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [{ taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: null }],
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
          question: "",
          chosen: [{ id: "CH1", text: "Declarative evidence set" }],
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
        {
          ref: "fact/F-0001",
          statement: "submit persists artifact-only receipts",
          evidenceSource: "packages/x.ts",
          occurredAt: "2026-10-19T14:04:42.747Z",
          observedCommit: "9f872eabf2075eab04328a239bf5c5d81a2c0e44",
        },
        {
          ref: "fact/F-0002",
          statement: "a fact recorded before the anchor decision",
          evidenceSource: "packages/old.ts",
          occurredAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    }),
    readDocument: () => ({ ...cut(), document: null }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assertLineGrammar(block);
  // Only facts reached through an evidenced-by edge serve; the anchor renders commit@8 + record time.
  assert.match(
    block,
    /<fact ref="fact\/F-0001">submit persists artifact-only receipts \(src:packages\/x\.ts; recorded 2026-10-19T14:04:42\.747Z @ 9f872eab\)<\/fact>/u,
  );
  assert.doesNotMatch(block, /F-0002/u, "facts no decision claim evidences do not serve");
  assert.match(block, /^<task-context>\n<note>fact 是历史观察，涉及代码时以现场为准。<\/note>\n/u);
});

test("a block with no served facts carries no facts note", () => {
  const projection = stub({
    readTaskIndex: () => ({
      ...cut(),
      rows: [
        { taskId: "task_root", title: "Work goal", taskClass: "work", parentTaskId: null, packagePath: "tasks/root" },
        { taskId: "task_leaf", title: "Leaf", taskClass: "standard", parentTaskId: "task_root", packagePath: null },
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
          question: "",
          chosen: [{ id: "CH1", text: "Declarative evidence set" }],
          claims: [{ id: "C1", text: "submit supports artifact-only", loadBearing: true }],
        },
      ],
    }),
    readRelationQuery: () => ({ ...cut(), rows: [] }),
    readDocument: () => ({ ...cut(), document: { body: "# Root\n\n## Goal\n\nShip.\n" } }),
  });
  const block = assembleTaskCausalContext({ projection, taskId: "task_leaf" });
  assert.ok(block !== null);
  assert.match(block, /<decision ref="decision\/dec_ABC"/u);
  assert.doesNotMatch(block, /<note>/u, "no facts served means no facts note");
});
