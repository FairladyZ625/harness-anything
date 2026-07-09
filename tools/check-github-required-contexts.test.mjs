import assert from "node:assert/strict";
import test from "node:test";
import {
  checkGithubRequiredContexts,
  extractGitHubRequiredStatusCheckContexts
} from "./check-github-required-contexts.mjs";

function manifestWithContexts(contexts) {
  return JSON.stringify({
    gates: [
      {
        id: "fixture",
        executionSurfaces: {
          branchProtection: {
            contexts
          }
        }
      }
    ]
  });
}

function requiredStatusCheckRule(contexts) {
  return {
    type: "required_status_checks",
    parameters: {
      required_status_checks: contexts.map((context) => ({ context }))
    }
  };
}

test("github required context check accepts matching context sets", () => {
  const result = checkGithubRequiredContexts({
    branchRules: [requiredStatusCheckRule(["boundaries", "integration-shard (1)"])],
    gateManifestText: manifestWithContexts(["boundaries", "integration-shard (1)"])
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("github required context check rejects missing and extra contexts", () => {
  const result = checkGithubRequiredContexts({
    branchRules: [requiredStatusCheckRule(["boundaries", "nonexistent-job"])],
    gateManifestText: manifestWithContexts(["boundaries", "integration-shard (3)"])
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing required contexts.*integration-shard \(3\)/u);
  assert.match(result.errors.join("\n"), /extra GitHub branch-rule contexts.*nonexistent-job/u);
});

test("github required context check rejects dual empty context sets", () => {
  const result = checkGithubRequiredContexts({
    branchRules: [requiredStatusCheckRule([])],
    gateManifestText: manifestWithContexts([])
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "gate manifest declares no branch-protection contexts",
    "GitHub branch rules declare no required status check contexts"
  ]);
});

test("github required context check rejects missing required_status_checks rule", () => {
  const result = checkGithubRequiredContexts({
    branchRules: [{ type: "pull_request" }],
    gateManifestText: manifestWithContexts(["boundaries"])
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /include no required_status_checks rule/u);
  assert.match(result.errors.join("\n"), /declare no required status check contexts/u);
});

test("github required context parser unions contexts across multiple rulesets", () => {
  assert.deepEqual(extractGitHubRequiredStatusCheckContexts([
    requiredStatusCheckRule(["boundaries", "typecheck (24)"]),
    { type: "deletion" },
    requiredStatusCheckRule(["typecheck (24)", "integration-shard (6)"])
  ]), {
    hasRequiredStatusCheckRule: true,
    contexts: ["boundaries", "typecheck (24)", "integration-shard (6)"]
  });
});
