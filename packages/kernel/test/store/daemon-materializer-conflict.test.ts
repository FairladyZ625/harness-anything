// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createMultiRepoDaemonRuntime } from "../../../adapters/local/src/index.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { git, initAuthoredGit } from "./helpers/daemon-runtime.ts";

test("daemon status exposes materializer merge conflicts", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const conflictPath = path.join(rootDir, "harness/conflict.txt");
    git(rootDir, "checkout", "-b", "sessions/daemon-conflict");
    writeFileSync(conflictPath, "session\n", "utf8");
    git(rootDir, "add", "--", "conflict.txt");
    git(rootDir, "commit", "-m", "session conflict");
    git(rootDir, "checkout", "master");
    writeFileSync(conflictPath, "trunk\n", "utf8");
    git(rootDir, "add", "--", "conflict.txt");
    git(rootDir, "commit", "-m", "trunk conflict");

    const runtime = createMultiRepoDaemonRuntime({
      repos: [{ repoId: "conflict-repo", rootDir }],
      materializerPollMs: false,
      materializerMaxBranchesPerBatch: 1
    });
    await runtime.start();
    const report = await runtime.enqueueMaterializerBatch("conflict-repo");

    assert.equal(report.branches[0]?.status, "conflict");
    assert.match(runtime.status().repos[0]?.lastMaterializerError ?? "", /sessions\/daemon-conflict/u);
    await runtime.stop();
  });
});
