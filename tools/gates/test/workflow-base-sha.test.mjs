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

test("diff-based gates fetch canonical main and resolve their base from origin/main", () => {
  const workflow = readWorkflow();
  for (const gate of ["tools/gates/test-selection.mjs"]) {
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
