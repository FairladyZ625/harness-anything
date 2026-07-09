import assert from "node:assert/strict";
import test from "node:test";
import { buildManifestGatePlan, parseManifestGateArgs } from "./run-manifest-gates.mjs";

test("manifest gate runner appends shard args only to shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } }
      }
    ]
  };
  const options = parseManifestGateArgs(["--workflow-job", "integration-shard", "--shard", "3"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 3" }
  ]);
});

test("manifest gate runner rejects --shard for non-shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "npm run harness:check-example",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      }
    ]
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--shard", "1"]);

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /manifest gate check-example is not shardable but --shard was provided/u
  );
});
