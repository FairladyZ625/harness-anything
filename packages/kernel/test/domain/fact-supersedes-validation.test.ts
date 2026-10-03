// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileFactRecordAction } from "../../src/domain/entity-action-execution.ts";

const factRef = "fact/F-12345678";
const compile = (supersedes: unknown) =>
  compileFactRecordAction({
    action: {
      kind: "fact-record",
      statement: "Observed",
      evidenceSource: "test:fact",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
      supersedes,
    },
    actor: { principal: { personId: "person-fixture" }, executor: null },
    source: "local",
    session: { kind: "unavailable", reason: "test" },
    opId: "op-fact-supersedes",
    occurredAt: "2026-10-03T00:00:00.000Z",
    workspaceRevision: 1,
  });

test("supersession names the failing field without weakening canonical validation", () => {
  for (const supersedes of [
    null,
    [],
    "F-12345678",
    { factRef: "F-12345678", rationale: "why" },
    { factRef: "task/task-1", rationale: "why" },
    { factRef: "fact/F-invalid", rationale: "why" },
  ]) {
    assert.throws(
      () => compile(supersedes),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "invalid_command");
        assert.match((error as Error).message, /--supersedes.*fact\/F-12345678/u);
        assert.doesNotMatch((error as Error).message, /rationale.*characters/u);
        return true;
      },
    );
  }
  for (const rationale of [undefined, null, 1, "", "x".repeat(200), "😀".repeat(200)]) {
    assert.throws(
      () => compile({ factRef, rationale }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "invalid_command");
        assert.match((error as Error).message, /--rationale.*1-199 characters/u);
        assert.doesNotMatch((error as Error).message, /canonical ref/u);
        return true;
      },
    );
  }
});

test("canonical supersession retains both Unicode length boundaries and omission", () => {
  for (const rationale of ["x", "x".repeat(199), "😀".repeat(199)]) {
    const draft = compile({ factRef, rationale });
    assert.equal(draft.kind, "fact");
    if (draft.kind === "fact") assert.deepEqual(draft.event.payload.supersedes, { factRef, rationale });
  }
  const draft = compile(undefined);
  if (draft.kind === "fact") assert.equal(draft.event.payload.supersedes, undefined);
});
