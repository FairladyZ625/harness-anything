// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import { filterTestFilesByNames, filterTestFilesByPrefixes, parseRunnerArgs } from "../../node-test-runner-lib.mjs";

// dec_04A9211B073F29F0FC1E1CA573 CH2: include daemon commit-isolate restart/restore.
// dec_09C1CE4481EEF4096867FA034E: moving the database arm to Node 26 must keep it PR-visible.
const workflow = parseGateWorkflow(
  readFileSync(new URL("../../../.github/workflows/rewrite-ci.yml", import.meta.url), "utf8"),
);
const manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8"));

test("PGlite database assertions run on Node 26 for PRs and pushes without changing Node 24 shards", () => {
  const lane = workflow.get("pglite-node26");
  assert.ok(lane?.isPullRequestJob);
  assert.ok(lane.isNonPullRequestJob);
  assert.deepEqual(lane.nodeVersions, [26]);
  assert.ok(lane.blockingRunCommands.includes("node tools/run-manifest-gates.mjs --workflow-job pglite-node26"));
  assert.ok(lane.runCommands.includes("npm ci"), "Node 26 builds its own native dependencies");
  assert.deepEqual(workflow.get("integration-shard").nodeVersions, [24]);
  const gate = manifest.gates.find(({ id }) => id === "test-pglite-node26");
  assert.equal(
    gate.command,
    "node tools/run-node-tests.mjs --prefix packages/storage/test/pglite --concurrency 2 && node tools/run-node-tests.mjs --file packages/daemon/test/pglite-repo-cell.integration.test.ts --concurrency 2",
  );
  assert.deepEqual(gate.executionSurfaces.rewriteCi.pullRequestJobs, ["pglite-node26"]);
  assert.deepEqual(gate.executionSurfaces.rewriteCi.nonPullRequestJobs, ["pglite-node26"]);
});

test("Node 26's effective selection includes the daemon regression; a file prefix cannot substitute for it", () => {
  const daemon = "packages/daemon/test/pglite-repo-cell.integration.test.ts",
    storage = "packages/storage/test/pglite/pglite-owner.integration.test.ts",
    files = [daemon, storage, "packages/daemon/test/unrelated.test.ts"],
    selected = (command) =>
      command.split(" && ").flatMap((invocation) => {
        const options = parseRunnerArgs(invocation.split(" ").slice(2));
        return filterTestFilesByNames(filterTestFilesByPrefixes(files, options.prefixes), options.files);
      });
  const gate = manifest.gates.find(({ id }) => id === "test-pglite-node26");
  assert.deepEqual(selected(gate.command).sort(), [daemon, storage].sort());
  assert.deepEqual(
    selected(`node tools/run-node-tests.mjs --prefix packages/storage/test/pglite --prefix ${daemon}`),
    [storage],
    "negative control: normalizing a filename as a directory silently drops the daemon",
  );
});
