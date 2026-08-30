// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { reboundRef, type MigrationRelationsContext } from "../src/migration-import-relations.ts";

test("archived identities satisfy reconciliation but cannot keep relation endpoints active", () => {
  const context = {
    taskMap: new Map([["task_active", "task_active"]]),
    decisionMap: new Map<string, string>(),
    factMap: new Map<string, string>(),
    archivedIds: {
      task: new Set(["task_archived"]),
      decision: new Set(["dec_archived"]),
      fact: new Set(["F-ARCHIVED"]),
      relation: new Set<string>(),
      execution: new Set(["exe_archived"]),
    },
    cold: { knownFactRefs: new Set(["fact/F-ARCHIVED", "fact/F-ACTIVE00"]) },
    oracle: {
      entityKeys: new Set(["execution\0exe_archived", "execution\0exe_active"]),
    },
  } as unknown as MigrationRelationsContext;
  assert.equal(reboundRef(context, "task/task_active"), "task/task_active");
  assert.equal(reboundRef(context, "execution/exe_active"), "execution/exe_active");
  assert.equal(reboundRef(context, "task/task_archived"), null);
  assert.equal(reboundRef(context, "decision/dec_archived"), null);
  assert.equal(reboundRef(context, "fact/F-ARCHIVED"), null);
  assert.equal(reboundRef(context, "execution/exe_archived"), null);
});
