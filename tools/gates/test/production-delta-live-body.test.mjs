// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The computed delta is measured from the branch's merge-base alone (dec_BB2BCE9F995CD3A126E2918734
// CH3): reruns must not fetch or replay the pull request body for this job.
test("production-delta job computes from the diff and reads no pull request body", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/pr-body.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  production-delta:"), workflow.indexOf("\n  evidence-contract:"));
  assert.match(job, /--base origin\/main/u);
  assert.doesNotMatch(job, /--pr-body-file/u);
  assert.doesNotMatch(job, /gh pr view/u);
  assert.doesNotMatch(job, /github\.event\.pull_request\.body/u);
  assert.doesNotMatch(job, /pull-requests: read/u);
});
