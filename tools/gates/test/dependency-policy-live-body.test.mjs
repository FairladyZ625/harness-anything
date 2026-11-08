// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The Dependency-Change declaration judges the pull request as it is now. Reruns must not replay
// the stale event payload body, so the advisory job fetches the live body and the manifest command
// reads that file rather than an environment copy of the event.
test("dependency-policy-declaration reads the live PR body and diffs against origin/main", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/pr-body.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  pr-body-advisory:"));
  assert.match(job, /gh pr view "\$PR_NUMBER" --json body/);
  assert.match(job, /--jq \.body > "\$RUNNER_TEMP\/pr-body\.md"/);
  assert.match(job, /pull-requests: read/);
  assert.match(job, /GH_TOKEN/);
  assert.match(job, /run: node tools\/run-manifest-gates\.mjs --workflow-job pr-body-advisory/);
  assert.doesNotMatch(job, /github\.event\.pull_request\.body/);

  const manifest = JSON.parse(readFileSync(path.join(rootDir, "tools/gate-manifest.json"), "utf8"));
  const gate = manifest.gates.find((entry) => entry.id === "dependency-policy-declaration");
  assert.match(gate.command, /--base origin\/main/);
  assert.match(gate.command, /--pr-body-file "\$RUNNER_TEMP\/pr-body\.md"/);
  assert.doesNotMatch(gate.command, /--pr-body-env|GITHUB_EVENT_PATH|PR_BASE_SHA/);
});

test("dependency-policy gate never reads the event payload body", () => {
  const gate = readFileSync(path.join(rootDir, "tools/gates/dependency-policy.mjs"), "utf8");
  assert.doesNotMatch(gate, /GITHUB_EVENT_PATH|pull_request/);
});
