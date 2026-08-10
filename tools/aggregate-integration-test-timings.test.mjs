// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateIntegrationTestTimings,
  applyIntegrationTestWeightProposal
} from "./aggregate-integration-test-timings.mjs";
import {
  createIntegrationTestTimingReport
} from "./integration-test-timing.mjs";

const manifestFiles = [
  "tools/a.test.mjs",
  "tools/b.test.mjs",
  "tools/c.test.mjs",
  "tools/d.test.mjs",
  "tools/e.test.mjs",
  "tools/f.test.mjs"
];

test("successful shard timing artifacts produce a complete scheduling-only weight proposal", () => {
  const reports = reportsFor(manifestFiles.map((file, index) => ({
    file,
    durationMs: [600, 500, 400, 300, 200, 100][index]
  })), 2);
  const proposal = aggregateIntegrationTestTimings(reports, {
    manifestFiles,
    currentWeights: Object.fromEntries(manifestFiles.map((file) => [file, 100])),
    shardCount: 2
  });

  assert.equal(proposal.schema, "harness-integration-test-weight-proposal/v1");
  assert.equal(proposal.purpose, "human-reviewed-scheduling-update");
  assert.deepEqual(proposal.weightsMs, {
    "tools/a.test.mjs": 600,
    "tools/b.test.mjs": 500,
    "tools/c.test.mjs": 400,
    "tools/d.test.mjs": 300,
    "tools/e.test.mjs": 200,
    "tools/f.test.mjs": 100
  });
  assert.equal(proposal.balance.before.maxOverAverage > proposal.balance.after.maxOverAverage, true);
  assert.equal(proposal.balance.after.maxOverAverage, 1100 / 1050);
});

test("aggregation fails closed on mixed runs, missing shards, duplicates, and file-set drift", () => {
  const reports = reportsFor(manifestFiles.map((file) => ({ file, durationMs: 100 })), 2);
  assert.throws(
    () => aggregateIntegrationTestTimings(reports.slice(0, 1), { manifestFiles, currentWeights: {}, shardCount: 2 }),
    /expected timing shards \[1, 2\]/u
  );
  assert.throws(
    () => aggregateIntegrationTestTimings([
      reports[0],
      { ...reports[1], source: { ...reports[1].source, runId: "other-run" } },
      ...reports.slice(2)
    ], { manifestFiles, currentWeights: {}, shardCount: 2 }),
    /same successful run/u
  );
  assert.throws(
    () => aggregateIntegrationTestTimings([
      reports[0],
      { ...reports[1], files: reports[0].files },
      ...reports.slice(2)
    ], { manifestFiles, currentWeights: {}, shardCount: 2 }),
    /duplicate timing file/u
  );
  assert.throws(
    () => aggregateIntegrationTestTimings(reports, {
      manifestFiles: [...manifestFiles, "tools/new.test.mjs"],
      currentWeights: {},
      shardCount: 2
    }),
    /test file set does not match/u
  );
  assert.throws(
    () => aggregateIntegrationTestTimings(reports, {
      manifestFiles,
      currentWeights: {},
      shardCount: 2,
      packageLockSha256: "c".repeat(64)
    }),
    /package-lock fingerprint/u
  );
  assert.throws(
    () => aggregateIntegrationTestTimings(reports, {
      manifestFiles,
      currentWeights: {},
      shardCount: 2,
      nodeMajor: 26
    }),
    /Node major/u
  );
});

test("weight proposal rewrites only the generated integration weight block", () => {
  const source = [
    "const before = true;",
    "// BEGIN GENERATED INTEGRATION TEST WEIGHTS",
    "export const integrationTestFileWeightsMs = Object.freeze({",
    "  \"tools/old.test.mjs\": 1",
    "});",
    "// END GENERATED INTEGRATION TEST WEIGHTS",
    "const after = true;",
    ""
  ].join("\n");
  const updated = applyIntegrationTestWeightProposal(source, {
    "tools/b.test.mjs": 234.56,
    "tools/a.test.mjs": 123.45
  });

  assert.match(updated, /const before = true;/u);
  assert.match(updated, /const after = true;/u);
  assert.match(updated, /"tools\/a\.test\.mjs": 123\.45,\n  "tools\/b\.test\.mjs": 234\.56/u);
  assert.doesNotMatch(updated, /old\.test/u);
});

function reportsFor(entries, shardCount) {
  return Array.from({ length: shardCount }, (_, shardIndex) => createIntegrationTestTimingReport({
    manifestFiles,
    workers: entries
      .filter((_, index) => index % shardCount === shardIndex)
      .map(({ file, durationMs }) => ({ file, durationMs, outcome: "passed" })),
    shardId: shardIndex + 1,
    shardCount,
    source: {
      repository: "owner/repo",
      commitSha: "a".repeat(40),
      runId: "123",
      runAttempt: 1
    },
    nodeVersion: "v24.18.0",
    packageLockSha256: "b".repeat(64)
  }));
}
