// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_EQUIVALENCE_NOTICE,
  buildCiPlan,
  createReceipt,
  formatSummary,
  parseIntegrationShardMatrix
} from "./run-ci-equivalent.mjs";

test("CI-equivalent plan follows a seven-shard workflow authority fixture", () => {
  const result = buildCiPlan(makeManifest(), makeWorkflow(7));

  assert.deepEqual(result.integrationShards, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    result.plan.filter(([job]) => job === "integration-shard"),
    [1, 2, 3, 4, 5, 6, 7].map((shard) => ["integration-shard", shard])
  );
});

test("workflow shard parser fails loudly when the matrix shape drifts", () => {
  const multilineMatrix = makeWorkflow(3).replace("shard: [1, 2, 3]", "shard:\n          - 1\n          - 2\n          - 3");

  assert.throws(
    () => parseIntegrationShardMatrix(makeManifest(), multilineMatrix),
    /strategy\.matrix\.shard must be an inline integer list/u
  );
  assert.throws(
    () => parseIntegrationShardMatrix(makeManifest(), "jobs:\n  boundaries:\n    steps: []\n"),
    /rewrite-ci integration-shard job is missing/u
  );
});

test("CI-equivalent plan rejects a manifest that drops the sharded job", () => {
  const manifest = makeManifest();
  manifest.gates = manifest.gates.filter((gate) => gate.id !== "test-integration");

  assert.throws(
    () => buildCiPlan(manifest, makeWorkflow(6)),
    /no gate in the manifest declares workflow job "integration-shard"/u
  );
});

test("skipped jobs are visible in the final summary and JSON receipt", () => {
  const result = buildCiPlan(makeManifest(), makeWorkflow(2));
  const receipts = result.plan.map(([job, shard]) => ({
    job: shard === undefined ? job : `${job} (${shard})`,
    exitCode: 0,
    seconds: 0
  }));
  const receipt = createReceipt(receipts, result.skipped);
  const summary = formatSummary(receipts, result.skipped);

  assert.deepEqual(receipt.skipped, [
    { job: "pr-body-lint", reason: "needs a real pull request body and cannot run locally" }
  ]);
  assert.equal(receipt.notice, LOCAL_EQUIVALENCE_NOTICE);
  assert.equal(receipt.ok, true);
  assert.match(summary, /SKIPPED pr-body-lint: needs a real pull request body/u);
  assert.match(summary, /ALL GREEN \(locally runnable jobs only; 1 skipped\)/u);
  assert.match(summary, /本地绿 ≠ 完整 CI 等价/u);
});

function makeManifest() {
  return {
    enforcementConstants: [
      {
        id: "ci-integration-shard-sequence",
        description: "Integration shard ids are owned by the pull-request workflow matrix.",
        valueType: "positive-integer-sequence",
        authority: {
          kind: "workflow-matrix",
          path: ".github/workflows/rewrite-ci.yml",
          job: "integration-shard",
          matrixKey: "shard"
        },
        consumers: ["tools/run-ci-equivalent.mjs", "tools/integration-test-shards.mjs"],
        literalAudit: "forbid-derived-count-and-sequence"
      }
    ],
    gates: [
      {
        id: "test-integration",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } }
      },
      {
        id: "check-boundaries",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      },
      {
        id: "check-pr-body",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["pr-body-lint"] } }
      }
    ]
  };
}

function makeWorkflow(shardCount) {
  const shards = Array.from({ length: shardCount }, (_, index) => index + 1);
  return [
    "name: rewrite-ci",
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    `        shard: [${shards.join(", ")}]`,
    "    steps: []",
    "  boundaries:",
    "    steps: []",
    ""
  ].join("\n");
}
