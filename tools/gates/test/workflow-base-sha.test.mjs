// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.join(process.cwd(), ".github/workflows/rebuild-gates.yml");

test("diff-based gates guard BASE_SHA against the zero SHA of a first branch push", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  for (const gate of ["tools/gates/test-selection.mjs", "tools/gates/line-budget.mjs"]) {
    const invocation = workflow.indexOf(`node ${gate} --base "$BASE_SHA"`);
    assert.notEqual(invocation, -1, `${gate} must be invoked with --base "$BASE_SHA"`);
    const runBlock = workflow.slice(Math.max(0, invocation - 400), invocation);
    assert.match(
      runBlock,
      /git cat-file -e "\$BASE_SHA\^\{tree\}"[\s\S]*git rev-parse origin\/rebuild\/main/u,
      `${gate} must fall back to origin/rebuild/main when BASE_SHA is unresolvable (github.event.before is the zero SHA on a first branch push)`
    );
  }
});
