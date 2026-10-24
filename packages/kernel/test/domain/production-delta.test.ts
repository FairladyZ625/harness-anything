// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { classifyPath, normalizeRepoPath, productionDeltaFromNumstat } from "../../src/domain/production-delta.ts";

test("production path policy classifies source, tests, and non-source files consistently", () => {
  assert.deepEqual(classifyPath("packages/kernel/src/domain/task.ts"), { module: "kernel", kind: "production" });
  assert.deepEqual(classifyPath("tools/gates/rule.test.mjs"), { module: null, kind: "test" });
  assert.deepEqual(classifyPath("README.md"), { module: null, kind: "other" });
  assert.equal(normalizeRepoPath("../outside.ts"), null);
});

test("production numstat counts classified source and reports unclassified production paths", () => {
  assert.deepEqual(
    productionDeltaFromNumstat([
      { addedText: "4", deletedText: "2", filePath: "packages/kernel/src/domain/task.ts" },
      { addedText: "3", deletedText: "0", filePath: "packages/unregistered/src/task.ts" },
      { addedText: "9", deletedText: "1", filePath: "packages/kernel/test/domain/task.test.ts" },
      { addedText: "5", deletedText: "0", filePath: "README.md" },
    ]),
    {
      added: 4,
      deleted: 2,
      changed: [{ filePath: "packages/kernel/src/domain/task.ts", module: "kernel", added: 4, deleted: 2 }],
      unclassified: ["packages/unregistered/src/task.ts"],
    },
  );
});

test("production numstat rejects binary source and malformed line counts", () => {
  assert.throws(
    () => productionDeltaFromNumstat([{ addedText: "-", deletedText: "-", filePath: "packages/kernel/src/data.ts" }]),
    /production source must be text/u,
  );
  assert.throws(
    () => productionDeltaFromNumstat([{ addedText: "x", deletedText: "0", filePath: "packages/kernel/src/data.ts" }]),
    /invalid numstat record/u,
  );
});
