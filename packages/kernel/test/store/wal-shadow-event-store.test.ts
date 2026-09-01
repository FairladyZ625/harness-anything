// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { contentObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import { localWalFileSystem } from "../../src/local/local-layout-file-system.ts";
import { resolveLedgerGitLayout } from "../../src/store/ledger-git-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { makeTaskEventStore as makeGitEventStore } from "../../src/store/task-event-store.ts";
import { makeWalShadowEventStore } from "../../src/store/wal-shadow-event-store.ts";
import { openWalEventLog } from "../../src/store/wal-event-log.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("ledger Git layout resolution reuses one normalized-root identity", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const before = localGitObjectRefStore.processCount(),
      first = resolveLedgerGitLayout(rootDir),
      afterFirst = localGitObjectRefStore.processCount(),
      second = resolveLedgerGitLayout(rootDir);
    assert.equal(first, second);
    assert.equal(afterFirst - before, 1, "the first layout resolution probes the Git top level");
    assert.equal(localGitObjectRefStore.processCount() - afterFirst, 0, "the cached layout starts no subprocess");
  });
});

test("S4 acknowledges the durable WAL cut with zero Git processes and immediate worktree visibility", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const bundle = taskBundle(1, "visible on return\n");
    assert.deepEqual(
      bundle.plan.targets.filter((target) => target.kind === "local_wal_file"),
      [
        { kind: "local_wal_file", path: ".harness/wal/seg-000000.log", operation: "append" },
        { kind: "local_wal_file", path: ".harness/wal/head.json", operation: "replace" },
        { kind: "local_wal_file", path: `.harness/wal/objects/${bundle.blobs[0]!.sha256}`, operation: "replace" },
      ],
    );
    const committedEvents = store.read().events;
    const branchBefore = git(rootDir, "rev-parse", "HEAD");
    const receipt = store.append(bundle);
    const wal = openWalEventLog(rootDir);
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.commitSha, null);
    assert.equal(receipt.cut.opId, bundle.event.opId);
    assert.deepEqual(
      { repoId: receipt.cut.repoId, revision: receipt.cut.revision, headDigest: receipt.cut.headDigest },
      store.currentCut(),
    );
    assert.equal(receipt.metrics.gitProcesses, 0);
    assert.equal(committedEvents.length, 0, "an already-returned Git stream remains immutable");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), branchBefore);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", "tasks", "task-1", "task.md"), "utf8"),
      "visible on return\n",
    );
    assert.equal(existsSync(path.join(rootDir, ".harness", "wal", "seg-000000.log")), true);
    assert.deepEqual(wal.readEvent(bundle.event.opId), bundle.event);
    assert.deepEqual(wal.audit(store.read().events, store.read().revision), {
      status: "equivalent",
      walRevision: 1,
      gitRevision: 1,
      compared: 1,
      divergence: null,
    });
    await store.drain();
  });
});

test("S4 batches a WAL suffix into one Git commit and garbage-collects local content", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const countBefore = Number(git(rootDir, "rev-list", "--count", "HEAD"));
    for (let revision = 1; revision <= 3; revision += 1)
      assert.equal(store.append(taskBundle(revision, `document ${revision}\n`)).commitSha, null);
    assert.deepEqual(
      openWalEventLog(rootDir)
        .records()
        .map((record) => record.revision),
      [1, 2, 3],
    );
    await store.drain();
    assert.equal(Number(git(rootDir, "rev-list", "--count", "HEAD")), countBefore + 1);
    assert.deepEqual(openWalEventLog(rootDir).records(), []);
    assert.deepEqual(readdirSync(path.join(rootDir, ".harness", "wal", "objects")), []);
    const reopened = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir });
    assert.deepEqual(
      reopened.read().events.map((event) => event.workspaceRevision),
      [1, 2, 3],
    );
    await reopened.drain();
  });
});

test("a verified WAL flush reuses the process-local Git content validation prefix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-validation-prefix",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
    });
    store.append(taskBundle(1, "validated once\n"));
    await store.drain();

    const trustedStarted = localGitObjectRefStore.processCount();
    assert.equal(store.read().revision, 1);
    const trustedProcesses = localGitObjectRefStore.processCount() - trustedStarted;

    const fresh = makeWalShadowEventStore({ repoId: "wal-validation-prefix", rootDir, walFlushMs: 60_000 });
    const freshStarted = localGitObjectRefStore.processCount();
    assert.equal(fresh.read().revision, 1);
    const freshProcesses = localGitObjectRefStore.processCount() - freshStarted;
    assert.equal(
      freshProcesses,
      trustedProcesses + 1,
      "a fresh process view performs the content batch that the validated prefix can omit",
    );
    await fresh.drain();
  });
});

test("an unvalidated Git prefix is still checked after a WAL suffix flush", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const first = taskBundle(1, "valid history\n"),
      gitStore = makeGitEventStore({ repoId: "wal-unvalidated-prefix", rootDir });
    gitStore.append(first);
    writeFileSync(
      path.join(rootDir, "harness", contentObjectRelativePath(first.blobs[0]!.sha256)),
      "corrupt history\n",
    );
    git(rootDir, "add", "harness/objects");
    git(rootDir, "commit", "-qm", "corrupt historical content fixture");
    git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");

    const store = makeWalShadowEventStore({
      repoId: "wal-unvalidated-prefix",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
    });
    store.append(taskBundle(2, "verified suffix\n"));
    await store.drain();
    assert.throws(
      () => store.read(),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "invalid_store");
        return /content blob.*not reachable and exact/u.test(String(error));
      },
    );
  });
});

test("WAL materialization rechecks content bytes before trusting the flushed suffix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
        repoId: "wal-corrupt-object",
        rootDir,
        walFlushEvents: 64,
        walFlushMs: 60_000,
        walRetryLimit: 1,
      }),
      bundle = taskBundle(1, "durable bytes\n");
    store.append(bundle);
    writeFileSync(path.join(rootDir, ".harness", "wal", "objects", bundle.blobs[0]!.sha256), "corrupt\n");
    const warnings: string[] = [],
      originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await assert.rejects(store.drain(), /WAL drain exhausted 1 attempt/u);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(
      warnings.some((warning) => warning.includes("WAL content object") && warning.includes("corrupt")),
      true,
    );
    assert.equal(makeGitEventStore({ repoId: "wal-corrupt-object", rootDir }).read().revision, 0);
  });
});

test("bulk writes defer visibility and settle one Git cut", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-bulk", rootDir, walFlushMs: 1 });
    const bulk = store.beginBulkWrite!();
    const countBefore = Number(git(rootDir, "rev-list", "--count", "HEAD"));
    for (let revision = 1; revision <= 3; revision += 1)
      store.append(taskBundle(revision, `bulk document ${revision}\n`));
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-3/task.md")), false);
    await bulk.finish();
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-3/task.md"), "utf8"), "bulk document 3\n");
    assert.equal(Number(git(rootDir, "rev-list", "--count", "HEAD")), countBefore + 1);
    const eventPath = git(rootDir, "ls-tree", "-r", "--name-only", "HEAD")
      .split("\n")
      .find((target) => target.endsWith("/op-1.json"));
    assert.ok(eventPath, "bulk event remains committed in Git");
    assert.equal(existsSync(path.join(rootDir, eventPath)), false, "immutable bulk events stay out of the active tree");
    assert.equal(
      git(rootDir, "status", "--porcelain", "--untracked-files=no"),
      "",
      "skip-worktree keeps tracked compact objects clean",
    );
    await store.drain();
  });
});

test("byte threshold flushes a durable WAL batch independently of the event threshold", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-bytes",
      rootDir,
      walFlushEvents: 10_000,
      walFlushBytes: 1,
      walFlushMs: 60_000,
      walFlushAdaptive: false,
    });
    store.append(taskBundle(1));
    for (let attempt = 0; attempt < 100 && openWalEventLog(rootDir).records().length > 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(openWalEventLog(rootDir).records(), []);
    await store.drain();
  });
});

test("S4 discards a torn WAL tail without losing the acknowledged record", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const first = taskCreated(1);
    store.append({ event: first, plan: taskLifecycleWritePlan(first), blobs: [] });
    const segment = path.join(rootDir, ".harness", "wal", "seg-000000.log");
    appendFileSync(segment, '{"torn":');
    const reopened = openWalEventLog(rootDir);
    assert.deepEqual(
      reopened.records().map((record) => record.revision),
      [1],
    );
    assert.equal(readFileSync(segment, "utf8").endsWith("\n"), true);
    assert.equal(reopened.audit(store.read().events, store.read().revision).status, "equivalent");
    await store.drain();
  });
});

test("an authoritative WAL fsync failure rejects the write without changing Git or memory", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow-failure", rootDir });
    const before = git(rootDir, "rev-parse", "HEAD");
    const originalAppend = localWalFileSystem.append;
    localWalFileSystem.append = () => {
      throw new Error("simulated WAL I/O failure");
    };
    try {
      const event = taskCreated(1);
      assert.throws(
        () => store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }),
        /simulated WAL I\/O failure/u,
      );
    } finally {
      localWalFileSystem.append = originalAppend;
    }
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    assert.equal(store.read().revision, 0);
    assert.deepEqual(openWalEventLog(rootDir).records(), []);
    await store.drain();
  });
});

test("materialization failures warn, retry with a bound, and do not revoke the write receipt", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let failures = 0;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const store = makeWalShadowEventStore({
      repoId: "wal-retry",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 4,
      walRetryBaseMs: 1,
      killpoint: (point) => {
        if (point === "after_git_commit" && failures++ < 2) throw new Error("transient materializer failure");
      },
    });
    try {
      const receipt = store.append(taskBundle(1, "retry remains visible\n"));
      assert.equal(receipt.status, "applied");
      assert.equal(receipt.commitSha, null);
      await store.drain();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.filter((warning) => warning.includes("materialization failed")).length, 2);
    assert.deepEqual(openWalEventLog(rootDir).records(), []);
    assert.equal(makeGitEventStore({ repoId: "wal-retry", rootDir }).read().revision, 1);
  });
});

test("a master branch forked from canonical stops the materializer once until refs are repaired", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-diverged",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 1,
      walRetryBaseMs: 1,
    });
    const canonical = git(rootDir, "rev-parse", "refs/ha/canonical");
    const fork = git(rootDir, "commit-tree", `${canonical}^{tree}`, "-m", "worker direct fork");
    git(rootDir, "reset", "--hard", fork);
    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...args: unknown[]) => errors.push(args.join(" "));
      store.append(taskBundle(1, "diverged cut\n"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      const processesAfterDivergence = localGitObjectRefStore.processCount();
      store.append(taskBundle(2, "still queued\n"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(errors.filter((line) => line.includes("materializer stopped")).length, 1);
      assert.equal(
        localGitObjectRefStore.processCount(),
        processesAfterDivergence,
        "a stopped materializer must not spin Git calls",
      );
      const stopped = store.recover();
      assert.equal(stopped.status, "indeterminate");
      assert.match(stopped.error ?? "", new RegExp(`git -C ${rootDir} reset ${canonical}`, "u"));
      assert.equal(errors.filter((line) => line.includes("materializer stopped")).length, 1);
      git(rootDir, "reset", "--hard", canonical);
      const recovered = store.recover();
      assert.notEqual(recovered.status, "indeterminate");
      await store.drain();
    } finally {
      console.error = originalError;
    }
  });
});

test("restart recovery settles and checkpoints a WAL cut whose Git refs already advanced", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const first = makeWalShadowEventStore({
      repoId: "wal-recovery",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 1,
      walRetryBaseMs: 1,
      killpoint: (point) => {
        if (point === "after_git_ref_update") throw new Error("simulated process death after ref update");
      },
    });
    const receipt = first.append(taskBundle(1, "recover me\n"));
    assert.equal(receipt.commitSha, null);
    await assert.rejects(first.drain(), /WAL drain exhausted/u);
    const documentPath = path.join(rootDir, "harness", "tasks", "task-1", "task.md");
    rmSync(documentPath);
    assert.equal(openWalEventLog(rootDir).records().length, 1);
    const recovered = makeWalShadowEventStore({ repoId: "wal-recovery", rootDir, walFlushMs: 60_000 });
    recovered.recover();
    assert.equal(readFileSync(documentPath, "utf8"), "recover me\n");
    assert.deepEqual(openWalEventLog(rootDir).records(), []);
    assert.equal(recovered.read().revision, 1);
    await recovered.drain();
  });
});

test("a concurrent append burst remains contiguous and materializes as one cut", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-burst", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const receipts = await Promise.all(
      Array.from({ length: 24 }, (_, index) => Promise.resolve().then(() => store.append(taskBundle(index + 1)))),
    );
    assert.equal(
      receipts.every((receipt) => receipt.commitSha === null && receipt.metrics.gitProcesses === 0),
      true,
    );
    assert.deepEqual(
      store.read().events.map((event) => event.workspaceRevision),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    assert.equal(store.read().events, store.read().events, "repeated stream reads reuse the merged event array");
    await store.drain();
    assert.equal(git(rootDir, "log", "-1", "--format=%s"), "harness WAL flush 1-24");
  });
});

function taskCreated(revision: number): TaskCreatedEvent {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: `task-${revision}`,
    type: "task_created",
    actor: {
      principal: { personId: "person-1" },
      executor: { kind: "agent", id: "codex" },
    },
    source: "local",
    occurredAt: "2026-08-20T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId: `task-${revision}`,
        title: `Task ${revision}`,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: {
          principal: { personId: "person-1" },
          executor: { kind: "agent", id: "codex" },
        },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
    },
  };
}

function taskBundle(revision: number, document?: string) {
  const base = taskCreated(revision);
  if (document === undefined) return { event: base, plan: taskLifecycleWritePlan(base), blobs: [] };
  const claim = {
    path: `tasks/task-${revision}/task.md`,
    sha256: sha256Text(document),
    size: Buffer.byteLength(document),
    mediaType: "text/markdown" as const,
    policyId: "typed-machine-writer/v1",
  };
  const event = { ...base, payload: { ...base.payload, documentClaims: [claim] } };
  return {
    event,
    plan: taskLifecycleWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: document }],
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "WAL Shadow Test");
  git(rootDir, "config", "user.email", "wal-shadow@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
