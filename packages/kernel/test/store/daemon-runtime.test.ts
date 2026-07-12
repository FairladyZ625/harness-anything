// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../src/layout/index.ts";
import { makeTaskHolderService, taskHolderActor } from "../../src/local/task-holder-state.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { createDaemonRuntime, createMultiRepoDaemonRuntime } from "../../src/store/daemon-runtime.ts";
import { acquireDaemonGlobalLock } from "../../src/store/write-journal-locks.ts";
import { docWrite, withTempStoreAsync } from "./helpers.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");

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

async function spawnJournalOnlyDaemon(rootDir: string): Promise<void> {
  const childScript = `
    import { Effect } from "effect";
    import { makeJournaledWriteCoordinator } from "./packages/kernel/src/store/index.ts";
    import { acquireDaemonGlobalLock } from "./packages/kernel/src/store/write-journal-locks.ts";
    import { createHarnessRuntimeContext, resolveHarnessLayout, taskEntityId } from "./packages/kernel/src/index.ts";
    const rootDir = ${JSON.stringify(rootDir)};
    const runtimeContext = createHarnessRuntimeContext(rootDir);
    const layout = resolveHarnessLayout(runtimeContext);
    const lock = acquireDaemonGlobalLock(rootDir, runtimeContext, layout.journalPath, { scope: "operational", kind: "system", id: "daemon-runtime" }, 60_000);
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      attribution: {
        actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "test" } },
        principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
        executorSource: "client-asserted"
      },
      heldGlobalLock: lock,
      autoMaterialize: false
    });
    Effect.runSync(coordinator.enqueue({
      opId: "op-crash-recovery",
      entityId: taskEntityId("task-crash"),
      kind: "doc_write",
      payload: { path: "recovered.md", body: "recovered" }
    }));
    console.log("journaled");
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 5);
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let sawJournaled = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("journaled")) sawJournaled = true;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (_code, signal) => {
      if (signal === "SIGKILL" && sawJournaled) {
        resolve();
        return;
      }
      reject(new Error(`journal child did not die as expected: signal=${signal ?? "none"} stderr=${stderr}`));
    });
  });
}

function daemonAttribution(personId: string, executorId: string, credentialFingerprint: string) {
  return {
    actor: {
      principal: { kind: "person" as const, personId },
      executor: { kind: "agent" as const, id: executorId }
    },
    principalSource: {
      kind: "daemon-authenticated" as const,
      providerId: "test-provider",
      credentialFingerprint
    },
    executorSource: "client-asserted" as const
  };
}

function initAuthoredGit(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function readGitFile(rootDir: string, relativePath: string): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), "show", `master:${relativePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
