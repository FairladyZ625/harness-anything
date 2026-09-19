// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The Dependency-Change declaration judges the pull request as it is now. Reruns must not replay
// the stale event payload body, so the job fetches the live body like production-delta does.
test("dependency-policy-declaration job reads the live PR body and diffs against origin/main", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/pr-body.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  dependency-policy-declaration:"));
  assert.match(job, /gh pr view "\$PR_NUMBER" --json body/);
  assert.match(job, /dependency-policy\.mjs --base origin\/main --pr-body-file/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.body/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.base\.sha/);
  assert.match(job, /pull-requests: read/);
});

test("dependency-policy gate never reads the event payload body", () => {
  const gate = readFileSync(path.join(rootDir, "tools/gates/dependency-policy.mjs"), "utf8");
  assert.doesNotMatch(gate, /GITHUB_EVENT_PATH|pull_request/);
});
