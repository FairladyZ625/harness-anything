// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { rebuildTaskProjection, type ProjectionSourceFenceFactory } from "@harness-anything/kernel";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { docWrite, withTempStoreAsync } from "./helpers/store.ts";
import {
  commitAuthoredFixture,
  daemonAttribution,
  git,
  initAuthoredGit,
  stableProjectionFence,
  writeExecutionEvidenceFixture
} from "./helpers/daemon-runtime.ts";

const drainTestAttribution = daemonAttribution("person_test", "test", "credential-test");

const drainProjectionSourceFenceFactory: ProjectionSourceFenceFactory = ({ rootDir }) => {
  const fence = stableProjectionFence(`test-${path.basename(rootDir)}`, git(rootDir, "rev-parse", "HEAD"), []);
  return { capture: () => fence };
};

test("daemon stop drains an in-flight evidence read before it resolves", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Shutdown drain");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    let captureStarted!: () => void;
    let releaseCapture!: () => void;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    const releaseCapturePromise = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      projectionSourceFenceFactory: () => ({
        capture: async () => {
          captureStarted();
          await releaseCapturePromise;
          return {
            kind: "stable",
            identity: "sha256:shutdown-drain",
            headOid: "shutdown-drain",
            dirty: false,
            changedPaths: []
          };
        }
      })
    });
    await runtime.start();

    const settled: string[] = [];
    const read = runtime.queryExecutionEvidencePage({ limit: 1 }).then(
      () => { settled.push("read"); },
      () => { settled.push("read"); }
    );
    await captureStartedPromise;
    const stop = runtime.stop().then(() => {
      settled.push("stop");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(settled, []);
    releaseCapture();
    await Promise.all([read, stop]);
    assert.deepEqual(settled, ["read", "stop"]);
  });
});

test("daemon stop bounds a hung queued write and retains its lock with durable operation tuples", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Bounded shutdown");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0,
      projectionSourceFenceFactory: drainProjectionSourceFenceFactory
    });
    await runtime.start();
    let hungBatchStarted!: () => void;
    const hungBatchStartedPromise = new Promise<void>((resolve) => {
      hungBatchStarted = resolve;
    });
    void runtime.enqueueBackgroundBatch({
      source: "killpoint-hung",
      run: () => {
        hungBatchStarted();
        return new Promise<never>(() => undefined);
      }
    });
    // The hung batch must occupy the drain loop before the interactive write
    // is queued; otherwise the queue commits the write first and the timeout
    // enumeration cannot include its operation tuple.
    await hungBatchStartedPromise;
    void runtime.enqueueInteractiveWrite({
      commandId: "recover-after-killpoint",
      attribution: drainTestAttribution,
      ops: [docWrite("op-recover-after-killpoint", "task-recover", "note.md", "recover")]
    }).catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await assert.rejects(
      runtime.stop({ drainTimeoutMs: 25 }),
      (error: unknown) => error instanceof Error
        && error.name === "DaemonDrainTimeoutError"
        && error.message.includes("killpoint-hung")
        && error.message.includes("recover-after-killpoint")
        && error.message.includes("op-recover-after-killpoint")
    );
    assert.equal(runtime.status().started, false);
    assert.ok(runtime.status().lockPath, "timeout must retain the write fence instead of releasing the lock");
  });
});
