// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.join(process.cwd(), ".github/workflows/rebuild-gates.yml");

// The trunk carries two names while the rebuild line is being renamed to main:
// "rebuild/main" today, "main" after the rename, never both at once in practice.
// Drop the retired name from this list the moment the rename lands.
const TRUNK_BRANCHES = ['- "main"', '- "rebuild/main"'];

test("push trigger covers only trunk branches — feature branches gate through pull_request runs, whose diff is the full PR; a feature-branch push run would re-evaluate walls against the narrow event.before diff and mint contradictory conclusions on the same head SHA (dec_01KZTQ1KRG17545YMSFKXJGEPN)", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const pushBlock = workflow.match(/\n {2}push:\n {4}branches:\n((?: {6}- .*\n)+)/u);
  assert.ok(pushBlock, "rebuild-gates must keep an explicit push trigger for post-merge trunk gating");
  assert.deepEqual(
    pushBlock[1].trim().split("\n").map((line) => line.trim()),
    TRUNK_BRANCHES,
    "push trigger must list exactly the trunk branch names, never a wildcard or a feature branch"
  );
});

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
