// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createIntegrationTestTimingReport,
  integrationTestFilesFingerprint,
  writeIntegrationTestTimingReport
} from "./integration-test-timing.mjs";

test("integration timing report records successful file-worker wall times and source identity", () => {
  const manifestFiles = ["tools/a.test.mjs", "tools/b.test.mjs"];
  const report = createIntegrationTestTimingReport({
    manifestFiles,
    workers: [
      { file: "tools/b.test.mjs", durationMs: 456.7894, outcome: "passed-after-reap" },
      { file: "tools/a.test.mjs", durationMs: 123.4567, outcome: "passed" }
    ],
    shardId: 2,
    shardCount: 6,
    source: {
      repository: "owner/repo",
      commitSha: "a".repeat(40),
      runId: "123",
      runAttempt: 2
    },
    nodeVersion: "v24.18.0",
    packageLockSha256: "b".repeat(64)
  });

  assert.deepEqual(report, {
    schema: "harness-integration-test-timings/v1",
    purpose: "scheduling-only",
    source: {
      repository: "owner/repo",
      commitSha: "a".repeat(40),
      runId: "123",
      runAttempt: 2
    },
    runtime: {
      nodeVersion: "v24.18.0",
      packageLockSha256: "b".repeat(64),
      testFilesSha256: integrationTestFilesFingerprint(manifestFiles)
    },
    shard: { id: 2, count: 6 },
    files: [
      { path: "tools/a.test.mjs", durationMs: 123.457 },
      { path: "tools/b.test.mjs", durationMs: 456.789 }
    ]
  });
});

test("integration timing report rejects failed, duplicate, or out-of-manifest workers", () => {
  const base = {
    manifestFiles: ["tools/a.test.mjs"],
    shardId: 1,
    shardCount: 1,
    source: {
      repository: "owner/repo",
      commitSha: "a".repeat(40),
      runId: "123",
      runAttempt: 1
    },
    nodeVersion: "v24.18.0",
    packageLockSha256: "b".repeat(64)
  };
  assert.throws(
    () => createIntegrationTestTimingReport({
      ...base,
      workers: [{ file: "tools/a.test.mjs", durationMs: 10, outcome: "failed" }]
    }),
    /successful workers/u
  );
  assert.throws(
    () => createIntegrationTestTimingReport({
      ...base,
      workers: [
        { file: "tools/a.test.mjs", durationMs: 10, outcome: "passed" },
        { file: "tools/a.test.mjs", durationMs: 11, outcome: "passed" }
      ]
    }),
    /duplicate timing file/u
  );
  assert.throws(
    () => createIntegrationTestTimingReport({
      ...base,
      workers: [{ file: "tools/missing.test.mjs", durationMs: 10, outcome: "passed" }]
    }),
    /outside the integration manifest/u
  );
});

test("integration timing report writes one deterministic JSON artifact", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-timing-"));
  try {
    writeFileSync(path.join(root, "package-lock.json"), "fixture-lock\n", "utf8");
    const output = path.join(root, "nested", "shard-1.json");
    const report = createIntegrationTestTimingReport({
      manifestFiles: ["tools/a.test.mjs"],
      workers: [{ file: "tools/a.test.mjs", durationMs: 10, outcome: "passed" }],
      shardId: 1,
      shardCount: 1,
      source: {
        repository: "owner/repo",
        commitSha: "a".repeat(40),
        runId: "123",
        runAttempt: 1
      },
      nodeVersion: "v24.18.0",
      packageLockSha256: "b".repeat(64)
    });
    writeIntegrationTestTimingReport(output, report);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
    assert.equal(readFileSync(output, "utf8").endsWith("\n"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
