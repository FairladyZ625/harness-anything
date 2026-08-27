// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.join(process.cwd(), ".github/workflows/rebuild-gates.yml");

// The patterns below are written against LF. A Windows contributor's checkout has CRLF and they
// would miss the blocks entirely, reporting a missing trigger that is right there -- #1526's
// shape, one layer up. The workflow's bytes are not load-bearing, so the reader normalizes.
const readWorkflow = () => readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");

// The rename landed: the trunk is "main" and the triggers name only it.
// Drop the retired name from this list the moment the rename lands.
const TRUNK_BRANCHES = ['- "main"'];

test("push trigger covers only trunk branches — feature branches gate through pull_request runs, whose diff is the full PR; a feature-branch push run would re-evaluate walls against the narrow event.before diff and mint contradictory conclusions on the same head SHA (dec_01KZTQ1KRG17545YMSFKXJGEPN)", () => {
  const workflow = readWorkflow();
  const pushBlock = workflow.match(/\n {2}push:\n {4}branches:\n((?: {6}- .*\n)+)/u);
  assert.ok(pushBlock, "rebuild-gates must keep an explicit push trigger for post-merge trunk gating");
  assert.deepEqual(
    pushBlock[1]
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    TRUNK_BRANCHES,
    "push trigger must list exactly the trunk branch names, never a wildcard or a feature branch",
  );
});

test("diff-based gates fetch canonical main and resolve their base from origin/main", () => {
  const workflow = readWorkflow();
  for (const gate of [
    "tools/gates/test-selection.mjs",
    "tools/gates/line-budget.mjs",
    "tools/gates/line-density.mjs",
  ]) {
    const invocation = workflow.indexOf(`node ${gate} --base origin/main`);
    assert.notEqual(invocation, -1, `${gate} must be invoked with --base origin/main`);
    const runBlock = workflow.slice(Math.max(0, invocation - 260), invocation);
    assert.match(
      runBlock,
      /git fetch --no-tags origin main/u,
      `${gate} must fetch canonical main before resolving its base`,
    );
    assert.doesNotMatch(runBlock, /github\.event\.pull_request\.base\.sha|\$BASE_SHA|git cat-file -e/u);
  }
});
