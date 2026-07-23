// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMergifyQueueContexts,
  checkRewriteCiMetadataContextRouting,
  parseMergifyQueueCheckSuccessContexts,
  simulateSameShaRequiredChecks
} from "./check-mergify-queue-contexts.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowText = readFileSync(path.join(repoRoot, ".github/workflows/rewrite-ci.yml"), "utf8");
const gateManifestText = readFileSync(path.join(repoRoot, "tools/gate-manifest.json"), "utf8");

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

function mergifyWithQueueContexts(contextLines, extraPullRequestRuleConditions = []) {
  return [
    "queue_rules:",
    "  - name: default",
    "    merge_method: merge",
    "    queue_conditions:",
    "      - base = main",
    ...contextLines.map((context) => `      - check-success = ${context}`),
    "    merge_conditions: []",
    "",
    "pull_request_rules:",
    "  - name: merge via queue",
    "    conditions:",
    "      - base = main",
    ...extraPullRequestRuleConditions.map((condition) => `      - ${condition}`)
  ].join("\n");
}

test("mergify queue context check accepts matching context sets", () => {
  const result = checkMergifyQueueContexts({
    mergifyText: mergifyWithQueueContexts(["boundaries", "\"integration-shard (1)\""]),
    gateManifestText: manifestWithContexts(["boundaries", "integration-shard (1)"])
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("mergify queue context check rejects missing required contexts", () => {
  const result = checkMergifyQueueContexts({
    mergifyText: mergifyWithQueueContexts(["boundaries"]),
    gateManifestText: manifestWithContexts(["boundaries", "integration-shard (3)"])
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /integration-shard \(3\)/u);
});

test("mergify queue context check rejects extra queue contexts", () => {
  const result = checkMergifyQueueContexts({
    mergifyText: mergifyWithQueueContexts(["boundaries", "nonexistent-job"]),
    gateManifestText: manifestWithContexts(["boundaries"])
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /nonexistent-job/u);
});

test("mergify queue context check rejects dual empty context sets", () => {
  const result = checkMergifyQueueContexts({
    mergifyText: mergifyWithQueueContexts([]),
    gateManifestText: manifestWithContexts([])
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "gate manifest declares no branch-protection contexts",
    ".mergify.yml queue_conditions declares no check-success contexts"
  ]);
});

test("mergify queue context parser unquotes quoted context names", () => {
  assert.deepEqual(parseMergifyQueueCheckSuccessContexts(mergifyWithQueueContexts([
    "\"integration-shard (1)\"",
    "'typecheck (24)'"
  ])), [
    "integration-shard (1)",
    "typecheck (24)"
  ]);
});

test("mergify queue context parser ignores pull request rule conditions", () => {
  assert.deepEqual(parseMergifyQueueCheckSuccessContexts(mergifyWithQueueContexts(
    ["boundaries"],
    ["check-success = nonexistent-job"]
  )), ["boundaries"]);
});

test("repeated metadata edits on one queue SHA leave the successful required-check set unchanged", () => {
  const routing = checkRewriteCiMetadataContextRouting({ workflowText, gateManifestText });
  assert.equal(routing.ok, true, routing.errors.join("\n"));

  const successRun = routing.normalContexts.map((name) => ({ name, conclusion: "success" }));
  const metadataEditStarts = routing.metadataContexts.map((name) => ({ name, conclusion: "queued" }));
  const metadataEditCompletes = routing.metadataContexts.map((name) => ({ name, conclusion: "success" }));
  const snapshots = simulateSameShaRequiredChecks({
    requiredContexts: routing.requiredContexts,
    events: [
      successRun,
      metadataEditStarts,
      metadataEditCompletes,
      metadataEditStarts,
      metadataEditCompletes,
      metadataEditStarts,
      metadataEditCompletes
    ]
  });
  const stableSuccess = Object.fromEntries(routing.requiredContexts.map((context) => [context, "success"]));

  assert.deepEqual(snapshots, snapshots.map(() => stableSuccess));
  assert.equal(
    routing.metadataContexts.some((context) => routing.requiredContexts.includes(context)),
    false,
    "metadata-only runs must never publish a required context name"
  );
});

test("same-name metadata no-ops would reset required checks and fail the convergence model", () => {
  const requiredContexts = ["boundaries", "typecheck (24)"];
  const snapshots = simulateSameShaRequiredChecks({
    requiredContexts,
    events: [
      requiredContexts.map((name) => ({ name, conclusion: "success" })),
      requiredContexts.map((name) => ({ name, conclusion: "queued" }))
    ]
  });

  assert.deepEqual(snapshots[0], { boundaries: "success", "typecheck (24)": "success" });
  assert.deepEqual(snapshots[1], { boundaries: "queued", "typecheck (24)": "queued" });
});
