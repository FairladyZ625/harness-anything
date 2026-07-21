// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeLocalProjectionSourceFenceReader } from "@harness-anything/adapter-local";
import { rebuildTaskProjection, type ProjectionSourceFence } from "@harness-anything/kernel";
import { createDaemonProjectionGenerationManager } from "../../src/runtime/projection-generation-manager.ts";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { withTempStoreAsync } from "./helpers/store.ts";
import {
  commitAuthoredFixture,
  git,
  initAuthoredGit,
  stableProjectionFence,
  writeExecutionEvidenceFixture
} from "./helpers/daemon-runtime.ts";

test("daemon projection requests capture the verified fence without rerunning generation validation", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Request fence");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const fence = stableProjectionFence("request-fence", git(rootDir, "rev-parse", "HEAD"), []);
    let requestCaptures = 0;
    let authoritativeRefreshes = 0;
    const manager = createDaemonProjectionGenerationManager({
      rootDir,
      reconcileIntervalMs: false,
      sourceFence: {
        capture: () => {
          requestCaptures += 1;
          return fence;
        },
        refresh: () => {
          authoritativeRefreshes += 1;
          return fence;
        }
      }
    });

    await manager.queryExecutionEvidencePage({ limit: 1 });
    await manager.queryExecutionEvidencePage({ limit: 1 });

    assert.equal(authoritativeRefreshes, 2);
    assert.equal(requestCaptures, 1);
    assert.equal(manager.snapshot().validationRuns, 1);
    await manager.close();
  });
});

test("authoritative background reconciliation catches a change even when the watcher emits no hint", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Background fence A");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const headOid = git(rootDir, "rev-parse", "HEAD");
    const indexPath = path.join(rootDir, "harness/tasks/task_01KXDG00000000000000000001/INDEX.md");
    let authoritative: ProjectionSourceFence = stableProjectionFence("background-a", headOid, []);
    let verified = authoritative;
    const manager = createDaemonProjectionGenerationManager({
      rootDir,
      reconcileIntervalMs: 5,
      sourceFence: {
        capture: () => verified,
        refresh: () => {
          verified = authoritative;
          return verified;
        },
        subscribe: () => () => undefined
      }
    });

    await manager.queryExecutionEvidencePage({ limit: 1 });
    writeExecutionEvidenceFixture(rootDir, "Background fence B");
    authoritative = stableProjectionFence("background-b", headOid, [indexPath]);
    for (let attempt = 0; attempt < 100 && manager.snapshot().state !== "unknown"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(manager.snapshot().state, "unknown", JSON.stringify(manager.snapshot()));
    assert.ok(manager.snapshot().reconciliationRuns > 0);
    const page = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(page.groups[0]?.title, "Background fence B");
    assert.equal(manager.snapshot().validationRuns, 2);
    await manager.close();
  });
});

test("local source fencing falls back conservatively for assume-unchanged authored files", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Assume unchanged A");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      projectionSourceFenceFactory: makeLocalProjectionSourceFenceReader
    });
    await runtime.start();
    await runtime.queryExecutionEvidencePage({ limit: 1 });

    git(rootDir, "update-index", "--assume-unchanged", "tasks/task_01KXDG00000000000000000001/INDEX.md");
    writeExecutionEvidenceFixture(rootDir, "Assume unchanged B");
    for (let attempt = 0; attempt < 100 && runtime.status().projectionGeneration.state !== "unknown"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const page = await runtime.queryExecutionEvidencePage({ limit: 1 });

    assert.equal(page.groups[0]?.title, "Assume unchanged B");
    assert.equal(runtime.status().projectionGeneration.state, "unknown");
    assert.equal(runtime.status().projectionGeneration.fenceReason, "unsupported-source");
    await runtime.stop();
  });
});
