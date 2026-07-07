import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { createDaemonRuntime } from "../../src/store/daemon-runtime.ts";
import { docWrite, withTempStoreAsync } from "./helpers.ts";

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

    const direct = makeJournaledWriteCoordinator({ rootDir });
    const directFailure = Effect.runSync(Effect.either(direct.enqueue(docWrite("op-direct", "task-1", "direct.md", "direct"))));
    assert.equal(directFailure._tag, "Left");
    assert.equal(directFailure.left._tag, "GlobalWriteConflict");
    assert.match(directFailure.left.owner ?? "", /write through daemon/u);
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);

    const order: string[] = [];
    const firstBackground = runtime.enqueueBackgroundBatch({
      source: "test-background-1",
      priority: "background",
      run: async () => {
        order.push("background-1-start");
        await delay(25);
        order.push("background-1-end");
      }
    });
    const secondBackground = runtime.enqueueBackgroundBatch({
      source: "test-background-2",
      priority: "background",
      run: () => {
        order.push("background-2");
      }
    });
    await delay(5);
    const interactive = runtime.enqueueInteractiveWrite({
      commandId: "cmd-interactive",
      ops: [docWrite("op-interactive", "task-1", "interactive.md", "interactive")]
    }).then((receipt) => {
      order.push("interactive");
      return receipt;
    });

    const receipt = await interactive;
    await firstBackground;
    await secondBackground;
    assert.equal(receipt.durable, true);
    assert.equal(receipt.flush.watermark, "op-interactive");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/interactive.md"), "utf8"), "interactive");
    assert.ok(order.indexOf("interactive") < order.indexOf("background-2"), order.join(","));
    await runtime.stop();
    assert.equal(existsSync(path.join(rootDir, ".harness/locks/global.lock")), false);
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
    const sessionOne = makeJournaledWriteCoordinator({ rootDir, sessionId: "daemon-mat-1", autoMaterialize: false });
    Effect.runSync(sessionOne.enqueue(docWrite("op-mat-1", "task-mat-1", "note.md", "one\n")));
    Effect.runSync(sessionOne.flush("explicit"));
    const sessionTwo = makeJournaledWriteCoordinator({ rootDir, sessionId: "daemon-mat-2", autoMaterialize: false });
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

test("daemon interactive queue does not mix different git authors in one commit", async () => {
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
      actor: { kind: "human", id: "person_alice" },
      commitAuthor: { name: "Alice Owner", email: "alice@example.test" },
      ops: [docWrite("op-author-alice", "task-author-a", "note.md", "alice\n")]
    });
    const bob = runtime.enqueueInteractiveWrite({
      commandId: "cmd-bob",
      actor: { kind: "human", id: "person_bob" },
      commitAuthor: { name: "Bob Owner", email: "bob@example.test" },
      ops: [docWrite("op-author-bob", "task-author-b", "note.md", "bob\n")]
    });

    const [aliceReceipt, bobReceipt] = await Promise.all([alice, bob]);
    assert.equal(aliceReceipt.flush.opCount, 1);
    assert.equal(bobReceipt.flush.opCount, 1);
    assert.deepEqual(
      git(rootDir, "log", "-2", "--format=%an <%ae>|%s").split(/\r?\n/u),
      [
        "Bob Owner <bob@example.test>|task(doc): task-author-b note.md [op-author-bob]",
        "Alice Owner <alice@example.test>|task(doc): task-author-a note.md [op-author-alice]"
      ]
    );

    await runtime.stop();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnJournalOnlyDaemon(rootDir: string): Promise<void> {
  const childScript = `
    import { Effect } from "effect";
    import { makeJournaledWriteCoordinator } from "./packages/kernel/src/store/index.ts";
    import { acquireDaemonGlobalLock } from "./packages/kernel/src/store/write-journal-locks.ts";
    import { createHarnessRuntimeContext, resolveHarnessLayout, taskEntityId } from "./packages/kernel/src/index.ts";
    const rootDir = ${JSON.stringify(rootDir)};
    const runtimeContext = createHarnessRuntimeContext(rootDir);
    const layout = resolveHarnessLayout(runtimeContext);
    const lock = acquireDaemonGlobalLock(rootDir, runtimeContext, layout.journalPath, { kind: "system", id: "daemon-runtime" }, 60_000);
    const coordinator = makeJournaledWriteCoordinator({ rootDir, heldGlobalLock: lock, autoMaterialize: false });
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
