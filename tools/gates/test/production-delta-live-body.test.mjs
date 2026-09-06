// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Retained-Path declarations describe the pull request as it is now, while the computed delta is
// measured from the current branch merge-base. Reruns must not replay the stale event body.
test("production-delta job reads live retained paths and diffs against origin/main", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/pr-body.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  production-delta:"), workflow.indexOf("\n  evidence-contract:"));
  assert.match(job, /gh pr view "\$PR_NUMBER" --json body/);
  assert.match(job, /--base origin\/main --pr-body-file/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.body/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.base\.sha/);
  assert.match(job, /pull-requests: read/);
});
