// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../src/layout/index.ts";
import { makeTaskHolderService, taskHolderActor } from "../../src/local/task-holder-state.ts";
import type { ProjectionSourceFence, ProjectionSourceFenceFactory } from "../../src/ports/projection-source-fence.ts";
import { queryExecutionEvidencePage } from "../../src/projection/sqlite-execution-evidence-reader.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
import { createDaemonProjectionGenerationManager } from "../../src/store/daemon-projection-generation-manager.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import {
  createDaemonRuntime,
  createMultiRepoDaemonRuntime
} from "../../../adapters/local/src/index.ts";
import { acquireDaemonGlobalLock } from "../../src/store/write-journal-locks.ts";
import { docWrite, withTempStoreAsync } from "./helpers.ts";
import {
  commitAuthoredFixture,
  daemonAttribution,
  git,
  initAuthoredGit,
  spawnJournalOnlyDaemon,
  stableProjectionFence,
  writeExecutionEvidenceFixture
} from "./helpers/daemon-runtime.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");

const deterministicProjectionSourceFenceFactory: ProjectionSourceFenceFactory = ({ rootDir }) => {
  const fence = stableProjectionFence(`test-${path.basename(rootDir)}`, git(rootDir, "rev-parse", "HEAD"), []);
  return { capture: () => fence };
};

test("daemon runtime coalesces concurrent evidence reads into one ready repo generation", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Concurrent generation");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0,
      projectionSourceFenceFactory: deterministicProjectionSourceFenceFactory
    });
    await runtime.start();

    const pages = await Promise.all(Array.from({ length: 100 }, () =>
      runtime.queryExecutionEvidencePage({ limit: 1 })));

    assert.equal(pages.length, 100);
    assert.ok(pages.every((page) => page.groups[0]?.title === "Concurrent generation"));
    assert.equal(runtime.status().projectionGeneration.validationRuns, 1);
    assert.equal(runtime.status().projectionGeneration.state, "ready", JSON.stringify(runtime.status().projectionGeneration));
    for (let index = 0; index < 20; index += 1) {
      await runtime.queryExecutionEvidencePage({ limit: 1 });
    }
    assert.ok(runtime.status().projectionGeneration.fenceRuns >= 22, JSON.stringify(runtime.status().projectionGeneration));
    await runtime.stop();
  });
});

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

test("daemon runtime invalidates only its repo generation after a canonical write", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Canonical invalidation");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 25,
      projectionSourceFenceFactory: deterministicProjectionSourceFenceFactory
    });
    await runtime.start();

    await runtime.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(runtime.status().projectionGeneration.validationRuns, 1);
    assert.equal(runtime.status().projectionGeneration.state, "ready", JSON.stringify(runtime.status().projectionGeneration));

    const pendingWrite = runtime.enqueueInteractiveWrite({
      commandId: "cmd-generation-invalidation",
      attribution: testAttribution,
      ops: [docWrite("op-generation-invalidation", "task-generation", "note.md", "changed")]
    });
    assert.equal(runtime.status().projectionGeneration.invalidations, 1);
    assert.equal(runtime.status().projectionGeneration.state, "unknown");
    await pendingWrite;

    await runtime.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(runtime.status().projectionGeneration.validationRuns, 2);
    assert.equal(runtime.status().projectionGeneration.state, "ready");
    await runtime.stop();
  });
});

test("multi-repo daemon keeps projection generations and evidence pages isolated", async () => {
  await withTempStoreAsync(async (workspaceRoot) => {
    const repos = Array.from({ length: 5 }, (_, index) => ({
      repoId: `repo-${index + 1}`,
      rootDir: path.join(workspaceRoot, `repo-${index + 1}`),
      title: `Repository ${index + 1} evidence`
    }));
    for (const repo of repos) {
      mkdirSync(repo.rootDir, { recursive: true });
      writeExecutionEvidenceFixture(repo.rootDir, repo.title);
      initAuthoredGit(repo.rootDir);
      commitAuthoredFixture(repo.rootDir);
      rebuildTaskProjection({ rootDir: repo.rootDir });
    }
    const runtime = createMultiRepoDaemonRuntime({
      materializerPollMs: false,
      interactiveMicroBatchMs: 0,
      projectionSourceFenceFactory: deterministicProjectionSourceFenceFactory,
      repos
    });
    await runtime.start();

    const pages = await Promise.all(repos.map((repo) =>
      runtime.getRepoRuntime(repo.repoId)!.queryExecutionEvidencePage({ limit: 1 })));
    assert.deepEqual(pages.map((page) => page.groups[0]?.title), repos.map((repo) => repo.title));
    const status = runtime.status();
    const generations = status.repos.map((repo) => repo.projectionGeneration);
    assert.ok(generations.every((generation) => generation.validationRuns === 1));
    assert.equal(new Set(generations.map((generation) => generation.sourceHash)).size, 5);
    assert.equal(new Set(repos.map((repo) => resolveHarnessLayout(createHarnessRuntimeContext(repo.rootDir)).executionEvidenceProjectionPath)).size, 5);

    await runtime.enqueueInteractiveWrite("repo-1", {
      commandId: "cmd-first-generation-invalidation",
      attribution: testAttribution,
      ops: [docWrite("op-first-generation-invalidation", "task-first", "note.md", "first")]
    });
    const afterWrite = runtime.status();
    assert.equal(afterWrite.repos.find((repo) => repo.repoId === "repo-1")!.projectionGeneration.state, "unknown");
    assert.ok(afterWrite.repos
      .filter((repo) => repo.repoId !== "repo-1")
      .every((repo) => repo.projectionGeneration.state === "ready" && repo.projectionGeneration.invalidations === 0));
    await runtime.stop();
  });
});

test("daemon runtime rejects a cached generation after an external authored source edit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "External title A");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const indexPath = path.join(rootDir, "harness/tasks/task_01KXDG00000000000000000001/INDEX.md");
    const headOid = git(rootDir, "rev-parse", "HEAD");
    let fence = stableProjectionFence("external-a", headOid, []);
    let invalidateFence!: () => void;
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0,
      projectionSourceFenceFactory: () => ({
        capture: () => fence,
        subscribe: (listener) => {
          invalidateFence = listener;
          return () => undefined;
        }
      })
    });
    await runtime.start();

    const before = await runtime.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(before.groups[0]?.title, "External title A");
    const originalTimes = statSync(indexPath);
    writeExecutionEvidenceFixture(rootDir, "External title B");
    utimesSync(indexPath, originalTimes.atime, originalTimes.mtime);
    fence = stableProjectionFence("external-b", headOid, [indexPath]);
    invalidateFence();
    assert.equal(runtime.status().projectionGeneration.state, "unknown", JSON.stringify(runtime.status().projectionGeneration));

    const after = await runtime.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(after.groups[0]?.title, "External title B");
    assert.equal(runtime.status().projectionGeneration.validationRuns, 2);
    await runtime.stop();
  });
});

test("daemon projection manager incrementally applies one externally changed source and preserves full-rebuild parity", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Incremental external A");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const indexPath = path.join(rootDir, "harness/tasks/task_01KXDG00000000000000000001/INDEX.md");
    const executionPath = path.join(
      rootDir,
      "harness/tasks/task_01KXDG00000000000000000001/executions/exe_01KXDG00000000000000000001.md"
    );
    const headOid = git(rootDir, "rev-parse", "HEAD");
    let fence: ProjectionSourceFence = stableProjectionFence("external-a", headOid, []);
    let invalidateFence!: () => void;
    const preparations: Array<{ readonly mode: string; readonly touchedPaths: ReadonlyArray<string> }> = [];
    const manager = createDaemonProjectionGenerationManager({
      rootDir,
      sourceFence: {
        capture: () => fence,
        subscribe: (listener) => {
          invalidateFence = listener;
          return () => undefined;
        }
      },
      onPreparation: (event: { readonly mode: string; readonly touchedPaths: ReadonlyArray<string> }) => {
        preparations.push(event);
      }
    });

    const before = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(before.groups[0]?.title, "Incremental external A");
    writeExecutionEvidenceFixture(rootDir, "Incremental external B");
    fence = stableProjectionFence("external-b", headOid, [indexPath]);
    invalidateFence();

    const incremental = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(incremental.groups[0]?.title, "Incremental external B");
    assert.deepEqual(preparations.map((event) => event.mode), ["full-readiness", "incremental"]);
    assert.deepEqual(preparations.at(-1)?.touchedPaths, [path.resolve(indexPath)]);

    const canonicalWrite = manager.beginCanonicalWrite([indexPath]);
    writeExecutionEvidenceFixture(rootDir, "Incremental external C");
    fence = stableProjectionFence("external-c", headOid, [executionPath]);
    canonicalWrite.settle();
    const combined = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(combined.groups[0]?.title, "Incremental external C");
    assert.equal(preparations.at(-1)?.mode, "incremental");
    assert.deepEqual(preparations.at(-1)?.touchedPaths, [path.resolve(executionPath), path.resolve(indexPath)]);
    await manager.close();

    rebuildTaskProjection({ rootDir });
    const rebuilt = queryExecutionEvidencePage({ rootDir, limit: 1 });
    assert.deepEqual(combined, rebuilt);
  });
});

test("daemon projection manager falls back across HEAD changes and unknown fences", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Fence fallback A");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const indexPath = path.join(rootDir, "harness/tasks/task_01KXDG00000000000000000001/INDEX.md");
    let headOid = git(rootDir, "rev-parse", "HEAD");
    let fence: ProjectionSourceFence = stableProjectionFence("fallback-a", headOid, []);
    let invalidateFence!: () => void;
    const preparationModes: string[] = [];
    const manager = createDaemonProjectionGenerationManager({
      rootDir,
      sourceFence: {
        capture: () => fence,
        subscribe: (listener) => {
          invalidateFence = listener;
          return () => undefined;
        }
      },
      onPreparation: (event: { readonly mode: string }) => {
        preparationModes.push(event.mode);
      }
    });

    await manager.queryExecutionEvidencePage({ limit: 1 });

    const canonicalWrite = manager.beginCanonicalWrite([indexPath]);
    writeExecutionEvidenceFixture(rootDir, "Fence fallback B");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-m", "canonical B");
    headOid = git(rootDir, "rev-parse", "HEAD");
    fence = stableProjectionFence("fallback-b", headOid, []);
    canonicalWrite.settle();
    const canonical = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(canonical.groups[0]?.title, "Fence fallback B");

    writeExecutionEvidenceFixture(rootDir, "Fence fallback C");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-m", "external clean HEAD C");
    headOid = git(rootDir, "rev-parse", "HEAD");
    fence = stableProjectionFence("fallback-c", headOid, []);
    invalidateFence();
    const cleanHead = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(cleanHead.groups[0]?.title, "Fence fallback C");

    writeExecutionEvidenceFixture(rootDir, "Fence fallback D");
    fence = { kind: "unknown", reason: "unstable" };
    invalidateFence();
    const unknown = await manager.queryExecutionEvidencePage({ limit: 1 });
    assert.equal(unknown.groups[0]?.title, "Fence fallback D");
    assert.deepEqual(preparationModes, ["full-readiness", "full-readiness", "full-readiness", "full-readiness"]);
    await manager.close();
  });
});

test("daemon runtime holds global.lock, rejects direct writes before journaling, and yields background batches to P0 writes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0
    });
    const status = await runtime.start();
    assert.equal(status.started, true);
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, ".harness/locks/global.lock"), "utf8")).ownerKind, "daemon");

    const direct = makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution });
    const directFailure = Effect.runSync(Effect.either(direct.enqueue(docWrite("op-direct", "task-1", "direct.md", "direct"))));
    assert.equal(directFailure._tag, "Left");
    assert.equal(directFailure.left._tag, "GlobalWriteConflict");
    assert.match(directFailure.left.owner ?? "", /write through daemon/u);
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);

    const order: string[] = [];
    let backgroundStarted!: () => void;
    let releaseBackground!: () => void;
    const backgroundStartedPromise = new Promise<void>((resolve) => {
      backgroundStarted = resolve;
    });
    const releaseBackgroundPromise = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const firstBackground = runtime.enqueueBackgroundBatch({
      source: "test-background-1",
      priority: "background",
      run: async () => {
        order.push("background-1-start");
        backgroundStarted();
        await releaseBackgroundPromise;
        order.push("background-1-end");
      }
    });
    const secondBackground = runtime.enqueueBackgroundBatch({
      source: "test-background-2",
      priority: "background",
      run: () => {
        const interactivePath = path.join(rootDir, "harness/tasks/task-1/interactive.md");
        order.push(existsSync(interactivePath) ? "background-2-after-interactive" : "background-2-before-interactive");
      }
    });
    await backgroundStartedPromise;
    const interactive = runtime.enqueueInteractiveWrite({
      commandId: "cmd-interactive",
      attribution: testAttribution,
      ops: [docWrite("op-interactive", "task-1", "interactive.md", "interactive")]
    }).then((receipt) => {
      order.push("interactive");
      return receipt;
    });
    releaseBackground();

    const receipt = await interactive;
    await firstBackground;
    await secondBackground;
    assert.equal(receipt.durable, true);
    assert.equal(receipt.flush.watermark, "op-interactive");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/interactive.md"), "utf8"), "interactive");
    assert.ok(order.includes("background-2-after-interactive"), order.join(","));
    await runtime.stop();
    assert.equal(existsSync(path.join(rootDir, ".harness/locks/global.lock")), false);
  });
});

test("daemon runtime runs the reservation reconciler at attach and on the existing materializer timer", async () => {
  await withTempStoreAsync(async (rootDir) => {
    let reconciliations = 0;
    const taskId = "task_01KX7H00000000000000000001";
    const executionId = "exe_01KX7H00000000000000000001";
    const holder = makeTaskHolderService({ rootInput: rootDir });
    await holder.reserveExecution({
      taskId,
      executionId,
      principal: taskHolderActor({ personId: "person_test" }, { kind: "agent", id: "test" })
    });
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: 10,
      reservationReconciler: async () => {
        reconciliations += 1;
        await holder.reconcileExecution({ taskId, executionId, authoredState: "missing" });
      }
    });

    await runtime.start();
    assert.equal(reconciliations, 1);
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.ok(reconciliations > 1, `expected periodic reconciliation, saw ${reconciliations}`);
    await runtime.stop();
  });
});

test("daemon restart after SIGKILL takes over stale lock and recovers durable journal", async () => {
  await withTempStoreAsync(async (rootDir) => {
    await spawnJournalOnlyDaemon(rootDir);
    assert.equal(existsSync(path.join(rootDir, ".harness/locks/global.lock")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-crash/recovered.md")), false);

    const runtime = createDaemonRuntime({
      rootDir,
      lockTtlMs: 1,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0
    });
    const status = await runtime.start();

    assert.equal(status.lastRecovery?.replayedOps, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-crash/recovered.md"), "utf8"), "recovered");
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /"schema":"lock-takeover\/v1"/u);
    await runtime.stop();
  });
});

test("daemon interactive writes route sessionId commits to authored session branches", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0
    });
    await runtime.start();

    const receipt = await runtime.enqueueInteractiveWrite({
      commandId: "cmd-session-routed",
      attribution: testAttribution,
      sessionId: "daemon-session-1",
      ops: [docWrite("op-daemon-session", "task-daemon-session", "note.md", "session routed\n")]
    });

    assert.equal(receipt.flush.watermark, "op-daemon-session");
    assert.equal(git(rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    assert.equal(git(rootDir, "branch", "--list", "sessions/daemon-session-1"), "sessions/daemon-session-1");
    assert.match(git(rootDir, "log", "master..sessions/daemon-session-1", "--oneline"), /op-daemon-session/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-daemon-session/note.md")), false);

    await runtime.stop();
  });
});

test("daemon interactive queue does not mix different principals or sources with the same executor", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 20
    });
    await runtime.start();

    const alice = runtime.enqueueInteractiveWrite({
      commandId: "cmd-alice",
      attribution: daemonAttribution("person_alice", "codex", "credential-alice"),
      commitAuthor: { name: "Shared Author", email: "shared@example.test" },
      ops: [docWrite("op-author-alice", "task-author-a", "note.md", "alice\n")]
    });
    const bob = runtime.enqueueInteractiveWrite({
      commandId: "cmd-bob",
      attribution: daemonAttribution("person_bob", "codex", "credential-bob"),
      commitAuthor: { name: "Shared Author", email: "shared@example.test" },
      ops: [docWrite("op-author-bob", "task-author-b", "note.md", "bob\n")]
    });
    const aliceOtherSource = runtime.enqueueInteractiveWrite({
      commandId: "cmd-alice-other-source",
      attribution: daemonAttribution("person_alice", "codex", "credential-alice-other"),
      commitAuthor: { name: "Shared Author", email: "shared@example.test" },
      ops: [docWrite("op-author-alice-source", "task-author-c", "note.md", "alice other source\n")]
    });

    const [aliceReceipt, bobReceipt, aliceOtherSourceReceipt] = await Promise.all([alice, bob, aliceOtherSource]);
    assert.equal(aliceReceipt.flush.opCount, 1);
    assert.equal(bobReceipt.flush.opCount, 1);
    assert.equal(aliceOtherSourceReceipt.flush.opCount, 1);
    assert.deepEqual(
      git(rootDir, "log", "-3", "--format=%an <%ae>|%s").split(/\r?\n/u),
      [
        "Shared Author <shared@example.test>|task(doc): task-author-c note.md [op-author-alice-source]",
        "Shared Author <shared@example.test>|task(doc): task-author-b note.md [op-author-bob]",
        "Shared Author <shared@example.test>|task(doc): task-author-a note.md [op-author-alice]"
      ]
    );

    await runtime.stop();
  });
});

test("multi-repo daemon isolates attach lock failures by repo", async () => {
  await withTempStoreAsync(async (lockedRoot) => {
    await withTempStoreAsync(async (availableRoot) => {
      const lockedContext = createHarnessRuntimeContext(lockedRoot);
      const lockedLayout = resolveHarnessLayout(lockedContext);
      const externalLock = acquireDaemonGlobalLock(
        lockedRoot,
        lockedContext,
        lockedLayout.journalPath,
        { scope: "operational", kind: "system", id: "other-daemon" },
        60_000
      );
      const runtime = createMultiRepoDaemonRuntime({
        materializerPollMs: false,
        interactiveMicroBatchMs: 0,
        repos: [
          { repoId: "locked", rootDir: lockedRoot },
          { repoId: "available", rootDir: availableRoot }
        ]
      });

      try {
        const status = await runtime.start();
        assert.equal(status.repoCount, 2);
        assert.equal(status.attachedCount, 1);
        assert.equal(status.unavailableCount, 1);
        assert.equal(status.repos.find((repo) => repo.repoId === "locked")?.state, "unavailable");
        assert.equal(status.repos.find((repo) => repo.repoId === "available")?.state, "attached");

        await runtime.enqueueInteractiveWrite("available", {
          commandId: "cmd-available",
          attribution: testAttribution,
          ops: [docWrite("op-available", "task-available", "note.md", "available")]
        });
        assert.equal(readFileSync(path.join(availableRoot, "harness/tasks/task-available/note.md"), "utf8"), "available");

        assert.throws(
          () => runtime.enqueueInteractiveWrite("locked", {
            commandId: "cmd-locked",
            attribution: testAttribution,
            ops: [docWrite("op-locked", "task-locked", "note.md", "locked")]
          }),
          (error: unknown) => {
            assert.equal(typeof error, "object");
            assert.notEqual(error, null);
            assert.equal((error as { readonly _tag?: string })._tag, "JournalUnavailable");
            assert.match(String((error as { readonly cause?: unknown }).cause), /daemon repo "locked" is not attached/u);
            return true;
          }
        );
      } finally {
        await runtime.stop();
        externalLock.release();
      }
    });
  });
});

test("multi-repo daemon detaches one repo without releasing other repo locks", async () => {
  await withTempStoreAsync(async (firstRoot) => {
    await withTempStoreAsync(async (secondRoot) => {
      const runtime = createMultiRepoDaemonRuntime({
        materializerPollMs: false,
        interactiveMicroBatchMs: 0,
        repos: [
          { repoId: "first", rootDir: firstRoot },
          { repoId: "second", rootDir: secondRoot }
        ]
      });

      await runtime.start();
      assert.equal(existsSync(path.join(firstRoot, ".harness/locks/global.lock")), true);
      assert.equal(existsSync(path.join(secondRoot, ".harness/locks/global.lock")), true);

      const detached = await runtime.detachRepo("first");
      assert.equal(detached.state, "detached");
      assert.equal(existsSync(path.join(firstRoot, ".harness/locks/global.lock")), false);
      assert.equal(existsSync(path.join(secondRoot, ".harness/locks/global.lock")), true);

      const reattached = await runtime.attachRepo({ repoId: "first", rootDir: firstRoot, materializerPollMs: false });
      assert.equal(reattached.state, "attached");
      assert.equal(existsSync(path.join(firstRoot, ".harness/locks/global.lock")), true);

      await runtime.enqueueInteractiveWrite("first", {
        commandId: "cmd-first",
        attribution: testAttribution,
        ops: [docWrite("op-first", "task-first", "note.md", "first")]
      });
      assert.equal(readFileSync(path.join(firstRoot, "harness/tasks/task-first/note.md"), "utf8"), "first");

      await runtime.enqueueInteractiveWrite("second", {
        commandId: "cmd-second",
        attribution: testAttribution,
        ops: [docWrite("op-second", "task-second", "note.md", "second")]
      });
      assert.equal(readFileSync(path.join(secondRoot, "harness/tasks/task-second/note.md"), "utf8"), "second");

      await runtime.stop();
      assert.equal(existsSync(path.join(firstRoot, ".harness/locks/global.lock")), false);
      assert.equal(existsSync(path.join(secondRoot, ".harness/locks/global.lock")), false);
    });
  });
});
