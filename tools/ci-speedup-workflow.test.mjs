// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const rewrite = readFileSync(path.join(repoRoot, ".github/workflows/rewrite-ci.yml"), "utf8");
const nightly = readFileSync(path.join(repoRoot, ".github/workflows/nightly-integration.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

test("integration shards publish scheduling-only timing artifacts after successful execution", () => {
  const integrationJob = jobBody(rewrite, "integration-shard", "boundaries");
  assert.match(integrationJob, /HARNESS_INTEGRATION_TIMING_OUTPUT: artifacts\/integration-test-timings\/shard-\$\{\{ matrix\.shard \}\}\.json/u);
  assert.match(integrationJob, /name: Upload successful integration timing/u);
  assert.match(integrationJob, /if: \$\{\{ success\(\) && needs\.metadata-source-proof\.outputs\.reuse_source != 'true' \}\}/u);
  assert.match(integrationJob, /name: integration-test-timing-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
});

test("Windows PR smoke no longer delays source proof while nightly retains full fast and contract coverage", () => {
  const windowsJob = jobBody(rewrite, "windows-local-check", "source-validation-proof");
  const proofJob = jobBody(rewrite, "source-validation-proof", null);
  assert.match(windowsJob, /npm run test:windows-smoke/u);
  assert.doesNotMatch(windowsJob, /npm run check:local/u);
  assert.doesNotMatch(proofJob, /^\s{6}- windows-local-check$/mu);
  assert.match(nightly, /^  windows-full-check:\n[\s\S]+?npm run test:fast\n[\s\S]+?npm run test:contract/mu);
  assert.equal(packageJson.scripts["test:windows-smoke"], "node tools/windows-smoke-tests.mjs");
});

test("nightly timing proposal consumes only the latest successful main push and emits a review patch", () => {
  const proposalJob = jobBody(nightly, "integration-timing-proposal", null);
  assert.match(proposalJob, /gh run list --workflow rewrite-ci\.yml --branch main --event push --status success/u);
  assert.match(proposalJob, /gh run download "\$run_id" --pattern 'integration-test-timing-\*'/u);
  assert.match(proposalJob, /aggregate-integration-test-timings\.mjs[\s\S]+--write/u);
  assert.match(proposalJob, /git diff --no-ext-diff -- tools\/integration-test-shards\.mjs/u);
  assert.match(proposalJob, /actions\/upload-artifact@v4/u);
});

function jobBody(workflow, jobId, nextJobId) {
  const startMarker = `  ${jobId}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow job: ${jobId}`);
  if (nextJobId === null) return workflow.slice(start);
  const end = workflow.indexOf(`\n  ${nextJobId}:\n`, start + startMarker.length);
  assert.notEqual(end, -1, `missing workflow job after ${jobId}: ${nextJobId}`);
  return workflow.slice(start, end);
}
