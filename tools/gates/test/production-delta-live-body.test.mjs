// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// G33 judges the pull request as it is now, not as the triggering event payload described it:
// a rebase moves the merge-base and a body edit changes the declaration, and reruns replay the
// stale payload. The job therefore reads the body through the API and diffs against origin/main.
test("production-delta job reads the live PR body and diffs against origin/main", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/rebuild-gates.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  production-delta:"), workflow.indexOf("\n  lint:"));
  assert.match(job, /gh pr view "\$PR_NUMBER" --json body/);
  assert.match(job, /--base origin\/main --pr-body-file/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.body/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.base\.sha/);
  assert.match(job, /pull-requests: read/);
});
