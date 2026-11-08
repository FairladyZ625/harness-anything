// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.join(process.cwd(), ".github/workflows/rewrite-ci.yml");
const manifestPath = path.join(process.cwd(), "tools/gate-manifest.json");

// The patterns below are written against LF. A Windows contributor's checkout has CRLF and they
// would miss the blocks entirely, reporting a missing trigger that is right there -- #1526's
// shape, one layer up. The workflow's bytes are not load-bearing, so the reader normalizes.
const readWorkflow = () => readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");

test("diff-based gates fetch canonical main and resolve their base from origin/main", () => {
  const workflow = readWorkflow();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const gate = manifest.gates.find((candidate) => candidate.id === "test-selection");
  assert.equal(gate?.command, "node tools/gates/test-selection.mjs --base origin/main");

  const fetchBase = workflow.indexOf("git fetch --no-tags origin main");
  const runGates = workflow.indexOf("node tools/run-manifest-gates.mjs --workflow-job quick-gates");
  assert.notEqual(fetchBase, -1, "quick-gates must fetch canonical main before diff-based gates");
  assert.notEqual(runGates, -1, "quick-gates must execute the manifest-owned commands");
  assert.ok(fetchBase < runGates, "quick-gates must fetch canonical main before resolving the gate base");
  const runBlock = workflow.slice(fetchBase, runGates);
  assert.doesNotMatch(runBlock, /github\.event\.pull_request\.base\.sha|\$BASE_SHA|git cat-file -e/u);
});
