// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileFactRecordAction } from "../../src/domain/entity-action-execution.ts";

const compile = (classification: Readonly<Record<string, unknown>>) =>
  compileFactRecordAction({
    action: {
      kind: "fact-record",
      statement: "Observed",
      evidenceSource: "test:fact",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
      ...classification,
    },
    actor: { principal: { personId: "person-fixture" }, executor: null },
    source: "local",
    session: { kind: "unavailable", reason: "test" },
    opId: "op-fact-classification",
    occurredAt: "2026-11-05T00:00:00.000Z",
    workspaceRevision: 1,
  });

const rejection = (classification: Readonly<Record<string, unknown>>): Error => {
  try {
    compile(classification);
  } catch (error) {
    assert.equal((error as { code: string }).code, "invalid_command");
    return error as Error;
  }
  assert.fail(`classification ${JSON.stringify(classification)} must be rejected`);
};

test("an invalid memory tag names the flag, the value, and every legal tag", () => {
  const error = rejection({ memoryTags: ["harness-bug"] });
  assert.match(error.message, /--memory-tag "harness-bug" is invalid/u);
  assert.match(error.message, /episode, procedural, tool_memory, pattern, task_skill, abstract_rule, other/u);
  assert.doesNotMatch(error.message, /Fact classification is invalid/u);
});

test("invalid confidence and memory class name their own flag and legal values", () => {
  const confidence = rejection({ confidence: "certain" });
  assert.match(confidence.message, /--confidence "certain" is invalid/u);
  assert.match(confidence.message, /low, medium, high/u);
  assert.doesNotMatch(confidence.message, /memory-tag|memory-class/u);

  const memoryClass = rejection({ memoryClass: "working" });
  assert.match(memoryClass.message, /--memory-class "working" is invalid/u);
  assert.match(memoryClass.message, /semantic, episodic, procedural/u);
  assert.doesNotMatch(memoryClass.message, /memory-tag|--confidence/u);
});

test("an invalid domain type names --type and points at the registration commands", () => {
  for (const domainType of ["", " padded", "padded ", "x".repeat(65), "control\u0007char"]) {
    const error = rejection({ domainTypes: [domainType] });
    assert.ok(error.message.startsWith(`--type ${JSON.stringify(domainType)} is invalid`), error.message);
    assert.match(error.message, /1-64 characters/u);
    assert.match(error.message, /ha fact type list/u);
    assert.match(error.message, /ha fact type register/u);
    assert.doesNotMatch(error.message, /memory-tag|--confidence/u);
  }
});

test("every legal classification value still compiles", () => {
  for (const confidence of ["low", "medium", "high"] as const) {
    for (const memoryClass of ["semantic", "episodic", "procedural"] as const) {
      const draft = compile({
        confidence,
        memoryClass,
        domainTypes: ["architecture"],
        memoryTags: ["episode", "procedural", "tool_memory", "pattern", "task_skill", "abstract_rule", "other"],
      });
      assert.equal(draft.kind, "fact");
      if (draft.kind === "fact") {
        assert.equal(draft.event.payload.confidence, confidence);
        assert.equal(draft.event.payload.memoryClass, memoryClass);
        assert.deepEqual(draft.event.payload.domainTypes, ["architecture"]);
        assert.deepEqual(draft.event.payload.memoryTags, [
          "episode",
          "procedural",
          "tool_memory",
          "pattern",
          "task_skill",
          "abstract_rule",
          "other",
        ]);
      }
    }
  }
  const boundary = compile({ domainTypes: ["x".repeat(64)] });
  assert.equal(boundary.kind, "fact");
});
