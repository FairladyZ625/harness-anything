import assert from "node:assert/strict";
import test from "node:test";
import {
  checkIntegrationTestShards,
  validateIntegrationShardRequiredContexts,
  validateIntegrationShardWorkflowMatrix
} from "./check-integration-test-shards.mjs";

test("integration shard declaration is non-overlapping and complete", () => {
  const result = checkIntegrationTestShards();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.fileCount, 78);
  assert.deepEqual(result.workflowShards, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.requiredContexts, [
    "integration-shard (1)",
    "integration-shard (2)",
    "integration-shard (3)",
    "integration-shard (4)",
    "integration-shard (5)",
    "integration-shard (6)"
  ]);
  assert.equal(result.summaries.length, 6);
  assert.ok(result.summaries.every((summary) => summary.files > 0));
});

test("integration shard checker rejects workflow matrix drift", () => {
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 2, 3, 4]",
    "  integration:",
    "    needs: [integration-shard]"
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6), {
    shards: [1, 2, 3, 4],
    errors: ["integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 2, 3, 4]"]
  });
});

test("integration shard checker requires exact workflow matrix ordering", () => {
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 3, 2, 4, 5, 6]"
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6).errors, [
    "integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 3, 2, 4, 5, 6]"
  ]);
});

test("integration shard checker rejects gate manifest required context drift", () => {
  const gateManifest = JSON.stringify({
    gates: [
      {
        id: "test-integration",
        githubContext: {
          requiredContexts: [
            "integration-shard (1)",
            "integration-shard (2)",
            "integration-shard (3)",
            "integration-shard (4)",
            "integration-shard (5)"
          ]
        },
        executionSurfaces: {
          branchProtection: {
            contexts: [
              "integration-shard (1)",
              "integration-shard (2)",
              "integration-shard (3)",
              "integration-shard (4)",
              "integration-shard (5)"
            ]
          }
        }
      }
    ]
  });

  assert.deepEqual(validateIntegrationShardRequiredContexts(gateManifest, 6), {
    contexts: [
      "integration-shard (1)",
      "integration-shard (2)",
      "integration-shard (3)",
      "integration-shard (4)",
      "integration-shard (5)"
    ],
    errors: [
      "test-integration githubContext.requiredContexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]",
      "test-integration executionSurfaces.branchProtection.contexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]"
    ]
  });
});
