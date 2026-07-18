// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../src/layout/index.ts";
import type { ProjectionSourceFenceFactory } from "../../src/ports/projection-source-fence.ts";
import { projectionDatabaseSignature } from "../../src/projection/projection-generation-readiness.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { createDaemonRuntime, createMultiRepoDaemonRuntime } from "../../../adapters/local/src/index.ts";
import { docWrite, withTempStoreAsync } from "./helpers.ts";
import {
  commitAuthoredFixture,
  daemonAttribution,
  git,
  initAuthoredGit,
  readGitFile,
  stableProjectionFence,
  writeExecutionEvidenceFixture
} from "./helpers/daemon-runtime.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");

const deterministicProjectionSourceFenceFactory: ProjectionSourceFenceFactory = ({ rootDir }) => {
  const fence = stableProjectionFence(`test-${path.basename(rootDir)}`, git(rootDir, "rev-parse", "HEAD"), []);
  return { capture: () => fence };
};

test("daemon materializer producer runs bounded batches under the lifetime global lock", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const sessionOne = makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution, sessionId: "daemon-mat-1", autoMaterialize: false });
    Effect.runSync(sessionOne.enqueue(docWrite("op-mat-1", "task-mat-1", "note.md", "one\n")));
    Effect.runSync(sessionOne.flush("explicit"));
    const sessionTwo = makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution, sessionId: "daemon-mat-2", autoMaterialize: false });
    Effect.runSync(sessionTwo.enqueue(docWrite("op-mat-2", "task-mat-2", "note.md", "two\n")));
    Effect.runSync(sessionTwo.flush("explicit"));

    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      materializerMaxBranchesPerBatch: 1
    });
    await runtime.start();
    const first = await runtime.enqueueMaterializerBatch();
    const second = await runtime.enqueueMaterializerBatch();

    assert.equal(first.merged, 1);
    assert.equal(second.merged, 1);
    assert.equal(git(rootDir, "branch", "--list", "sessions/daemon-mat-*"), "");
    assert.equal(readGitFile(rootDir, "tasks/task-mat-1/note.md"), "one\n");
    assert.equal(readGitFile(rootDir, "tasks/task-mat-2/note.md"), "two\n");
    await runtime.stop();
  });
});

test("authority publication materializes its session before a queued timer batch can observe it", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    await runtime.start();
    const coordinator = runtime.createAttributedCoordinator({
      attribution: testAttribution,
      sessionId: "authority-atomic-materialization"
    });
    let competingMaterializer: ReturnType<typeof runtime.enqueueMaterializerBatch> | undefined;

    const publication = await runtime.enqueueAuthorityPublication({
      sessionId: "authority-atomic-materialization",
      publish: async () => {
        Effect.runSync(coordinator.enqueue(docWrite(
          "op-authority-atomic",
          "task-authority-atomic",
          "note.md",
          "authority\n"
        )));
        const flush = Effect.runSync(coordinator.flush("explicit"));
        competingMaterializer = runtime.enqueueMaterializerBatch();
        return flush;
      }
    });
    const competing = await competingMaterializer!;

    assert.equal(publication.materialization?.branches[0]?.status, "merged");
    assert.equal(publication.materialization?.branches[0]?.commitCount, 1);
    assert.equal(competing.merged, 0);
    assert.equal(readGitFile(rootDir, "tasks/task-authority-atomic/note.md"), "authority\n");
    await runtime.stop();
  });
});

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

test("daemon no-op materializer preserves the ready projection generation", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "No-op materializer");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      projectionSourceFenceFactory: deterministicProjectionSourceFenceFactory
    });
    await runtime.start();
    await runtime.queryExecutionEvidencePage({ limit: 1 });
    const projectionPath = resolveHarnessLayout(createHarnessRuntimeContext(rootDir)).executionEvidenceProjectionPath;
    const before = projectionDatabaseSignature(projectionPath);

    const report = await runtime.enqueueMaterializerBatch();

    assert.equal(report.merged, 0);
    assert.equal(projectionDatabaseSignature(projectionPath), before);
    assert.equal(runtime.status().projectionGeneration.invalidations, 0);
    assert.equal(runtime.status().projectionGeneration.state, "ready");
    await runtime.stop();
  });
});
