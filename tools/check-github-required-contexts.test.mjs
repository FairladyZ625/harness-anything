import assert from "node:assert/strict";
import test from "node:test";
import {
  checkGithubRequiredContexts,
  extractGitHubRequiredStatusCheckContexts,
  fetchGitHubBranchRules
} from "./check-github-required-contexts.mjs";

const FETCH_OPTIONS = { repo: "o/r", token: "t", backoffMs: 0, sleepImpl: async () => {} };

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

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

test("branch-rules fetch retries a transport fault and then succeeds", async () => {
  let calls = 0;
  const rules = await fetchGitHubBranchRules({
    ...FETCH_OPTIONS,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return response(200, [{ type: "deletion" }]);
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(rules, [{ type: "deletion" }]);
});

test("branch-rules fetch retries 5xx and 429 but not 403", async () => {
  let serverErrorCalls = 0;
  await fetchGitHubBranchRules({
    ...FETCH_OPTIONS,
    fetchImpl: async () => {
      serverErrorCalls += 1;
      return serverErrorCalls < 3 ? response(503, {}) : response(200, []);
    }
  });
  assert.equal(serverErrorCalls, 3);

  let rateLimitedCalls = 0;
  await fetchGitHubBranchRules({
    ...FETCH_OPTIONS,
    fetchImpl: async () => {
      rateLimitedCalls += 1;
      return rateLimitedCalls === 1 ? response(429, {}) : response(200, []);
    }
  });
  assert.equal(rateLimitedCalls, 2);

  // A 403 is an answer, not a fault: it must fail on the first attempt so a
  // missing token permission stays red instead of being retried into silence.
  let forbiddenCalls = 0;
  await assert.rejects(
    fetchGitHubBranchRules({
      ...FETCH_OPTIONS,
      fetchImpl: async () => {
        forbiddenCalls += 1;
        return response(403, { message: "Resource not accessible by integration" });
      }
    }),
    /403/u
  );
  assert.equal(forbiddenCalls, 1);
});

test("branch-rules fetch stays fail-closed after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGitHubBranchRules({
      ...FETCH_OPTIONS,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("EOF");
      }
    }),
    /EOF/u
  );
  assert.equal(calls, 3);
});
