// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  compileTaskLifecycleWrite,
  makeTaskEventStore,
  reduceTaskEvent,
  REPLAY_TASK_GRAPH,
  runWalMaterializationRequest,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openPersistentWriterEpoch, withWriterEpochFenceDescriptor } from "../src/writer-epoch.ts";

function probeGit(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function probeRepo(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  probeGit(repo, "init", "-q");
  probeGit(repo, "config", "user.name", "W3A Probe");
  probeGit(repo, "config", "user.email", "w3a@example.invalid");
  probeGit(repo, "commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nname: probe\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  probeGit(repo, "add", "harness");
  probeGit(repo, "commit", "-qm", "harness");
  return repo;
}
const probeBinding = (
  assertWriterEpoch: () => void,
  writerEpochFence: {
    readonly schema: "harness-writer-epoch-fence/v1";
    readonly stateRoot: string;
    readonly repoId: string;
    readonly epoch: number;
    readonly holderId: string;
  },
) =>
  withRoleBinding(
    {
      actor: { principal: { personId: "writer" }, executor: { kind: "agent" as const, id: "probe" } },
      source: { kind: "assignment" as const, nodeId: "node", assignmentId: "assignment" },
      assertWriterEpoch,
      writerEpochFence,
    },
    "repo-write",
  );

function childEpoch(
  source: string,
  root: string,
  holderId: string,
  readyFile = "",
  repoId = "repo",
): Promise<{
  readonly code: number | null;
  readonly lease: { readonly epoch: number; readonly holderId: string } | null;
}> {
  const code = `import { writeFileSync } from "node:fs"; import { openPersistentWriterEpoch } from ${JSON.stringify(pathToFileURL(source).href)}; const [root, holder, ready, repo] = process.argv.slice(1); const authority = openPersistentWriterEpoch({ stateRoot: root, holderId: holder }); if (ready) writeFileSync(ready, "ready\\n"); console.log(JSON.stringify(authority.acquire(repo))); authority.close();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, root, holderId, readyFile, repoId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) return reject(new Error(stderr));
      resolve({ code: exitCode, lease: JSON.parse(stdout.trim()) });
    });
  });
}

test("persistent writer epochs allocate monotonically and fence a stale holder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-"));
  try {
    const first = openPersistentWriterEpoch({
      stateRoot: root,
      holderId: "center-a",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    const leaseA = first.acquire("repo");
    assert.equal(leaseA.epoch, 1);
    const second = openPersistentWriterEpoch({
      stateRoot: root,
      holderId: "center-b",
      now: () => "2026-08-19T00:00:01.000Z",
    });
    const leaseB = second.acquire("repo");
    assert.equal(leaseB.epoch, 2);
    let finalized = false;
    withWriterEpochFenceDescriptor(
      {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: root,
        repoId: "repo",
        epoch: leaseB.epoch,
        holderId: leaseB.holderId,
      },
      () => {
        finalized = true;
      },
    );
    assert.equal(finalized, true);
    assert.throws(
      () => first.assert("repo", leaseA.epoch),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale",
    );
    const staleWrite = path.join(root, "stale-write");
    assert.throws(
      () =>
        withWriterEpochFenceDescriptor(
          {
            schema: "harness-writer-epoch-fence/v1",
            stateRoot: root,
            repoId: "repo",
            epoch: leaseA.epoch,
            holderId: leaseA.holderId,
          },
          () => writeFileSync(staleWrite, "stale writer reached the operation\n"),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale",
    );
    assert.equal(existsSync(staleWrite), false);
    assert.deepEqual(second.current("repo"), leaseB);
    second.close();
    first.close();
    assert.throws(
      () => first.current("repo"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh authority starts at epoch zero and ignores legacy epoch files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-fresh-"));
  try {
    writeFileSync(
      path.join(root, "writer-epochs.json"),
      `${JSON.stringify({
        schema: "fleet-writer-epoch/v1",
        repos: {
          repo: { repoId: "repo", holderId: "legacy", epoch: 40, version: 40, issuedAt: "legacy" },
        },
      })}\n`,
    );
    writeFileSync(
      path.join(root, "writer-epochs.history"),
      `${JSON.stringify({ repoId: "repo", holderId: "legacy", epoch: 41, version: 41, issuedAt: "legacy" })}\n`,
    );
    writeFileSync(path.join(root, "writer-epochs.lock"), "");
    const authority = openPersistentWriterEpoch({ stateRoot: root, holderId: "sqlite" }),
      lease = authority.acquire("repo");
    assert.equal(lease.epoch, 1);
    assert.deepEqual(authority.current("repo"), lease);
    authority.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RepoWriterCell verifies the writer epoch inside Git ref finalization", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-worker-fence-")),
    repo = probeRepo(root),
    stateRoot = path.join(root, "state"),
    first = openPersistentWriterEpoch({ stateRoot, holderId: "center-a" }),
    second = openPersistentWriterEpoch({ stateRoot, holderId: "center-b" }),
    leaseA = first.acquire("probe-repo"),
    leaseB = second.acquire("probe-repo");
  let fence = {
    schema: "harness-writer-epoch-fence/v1" as const,
    stateRoot,
    repoId: "probe-repo",
    epoch: leaseA.epoch,
    holderId: leaseA.holderId,
  };
  let materializationAttempts = 0;
  const store = makeTaskEventStore({
    repoId: "probe-repo",
    rootDir: repo,
    walMaterialize: (config, request) => {
      materializationAttempts += 1;
      return runWalMaterializationRequest(config, request, {
        withFinalizeFence: (descriptor, operation) => withWriterEpochFenceDescriptor(descriptor, operation),
      });
    },
    walMaterializationFence: () => fence,
  });
  const baselineCommit = probeGit(repo, "rev-parse", "refs/ha/canonical");
  try {
    appendWorkerTask(store, 1);
    const startedAt = performance.now();
    await assert.rejects(
      store.settlePendingMaterialization!("writer epoch test"),
      (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
    );
    const latchElapsedMs = performance.now() - startedAt;
    assert.equal(materializationAttempts, 1);
    assert.equal(store.materializationHealth().reason, "deterministic_failure");
    console.info(`writer epoch deterministic latch attempts=1 elapsedMs=${latchElapsedMs.toFixed(1)}`);
    assert.equal(probeGit(repo, "rev-parse", "refs/ha/canonical"), baselineCommit);

    fence = { ...fence, epoch: leaseB.epoch, holderId: leaseB.holderId };
    assert.notEqual(store.recover().status, "indeterminate");
    assert.throws(
      () => appendWorkerTask(store, 2),
      (error: unknown) =>
        (error as { readonly diagnostic?: { readonly kind?: string } }).diagnostic?.kind === "materialization-retrying",
    );
    await store.settleRecoveryMaterialization!();
    appendWorkerTask(store, 2);
    await store.settlePendingMaterialization!("writer epoch test");
    assert.equal(JSON.parse(probeGit(repo, "show", "refs/ha/canonical:harness/events/head.json")).revision, 2);
  } finally {
    await store.drain();
    second.close();
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent processes take over monotonically after a prior holder exits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-race-"));
  try {
    const source = path.resolve("packages/daemon/src/writer-epoch.ts"),
      prior = await childEpoch(source, root, "dead-holder"),
      results = await Promise.all(
        Array.from({ length: 2 }, (_value, index) => childEpoch(source, root, `takeover-${index}`)),
      );
    const epochs = results.map((result) => result.lease!.epoch).sort((left, right) => left - right);
    assert.equal(prior.lease?.epoch, 1);
    assert.deepEqual(epochs, [2, 3]);
    assert.equal(new Set(results.map((result) => result.lease!.holderId)).size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function appendWorkerTask(store: ReturnType<typeof makeTaskEventStore>, revision: number): void {
  const event = workerTaskCreated(revision);
  store.append(
    compileTaskLifecycleWrite({
      event,
      snapshot: reduceTaskEvent(
        { revision: revision - 1, task: null, executions: [], reviews: [], edgesTaken: [], lease: null },
        event,
      ),
      packagePath: null,
      currentDocuments: [],
    }),
  );
}
function workerTaskCreated(revision: number): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-worker-fence-${revision}`,
    workspaceRevision: revision,
    opId: `op-worker-fence-${revision}`,
    taskId: `task-worker-fence-${revision}`,
    type: "task_created",
    actor: {
      principal: { personId: "writer" },
      executor: { kind: "agent", id: "worker-fence-test" },
    },
    source: "local",
    occurredAt: "2026-09-01T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId: `task-worker-fence-${revision}`,
        title: "Worker fence",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: {
          principal: { personId: "writer" },
          executor: { kind: "agent", id: "worker-fence-test" },
        },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
    },
  };
}

test("deleting the current row cannot reuse an issued historical epoch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-floor-"));
  try {
    const first = openPersistentWriterEpoch({ stateRoot: root, holderId: "center" }),
      leaseOne = first.acquire("repo"),
      leaseTwo = first.acquire("repo");
    first.close();
    const database = new DatabaseSync(path.join(root, "writer-epochs.sqlite"));
    database.prepare("DELETE FROM writer_epochs WHERE repo_id=?").run("repo");
    database.close();
    const replacement = openPersistentWriterEpoch({ stateRoot: root, holderId: "center" }),
      leaseThree = replacement.acquire("repo");
    assert.equal(leaseOne.epoch, 1);
    assert.equal(leaseTwo.epoch, 2);
    assert.equal(leaseThree.epoch, 3);
    assert.throws(
      () => replacement.assert("repo", leaseTwo.epoch, leaseTwo.holderId),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale",
    );
    replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append transaction serializes takeover before rejecting the next stale write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-append-gap-")),
    repo = probeRepo(root),
    stateRoot = path.join(root, "state");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const oldAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" }),
      oldLease = oldAuthority.acquire("probe-repo"),
      source = path.resolve("packages/daemon/src/writer-epoch.ts");
    let successor: ReturnType<typeof childEpoch> | null = null,
      triggered = false;
    cell = await openRepoCell({
      repoId: "probe-repo" as never,
      rootDir: repo as never,
      ownerId: "probe-cell",
      mode: "remote-center",
      killpoint: (point) => {
        if (point === "before_event_write" && !triggered) {
          triggered = true;
          successor = childEpoch(source, stateRoot, "new-center", "", "probe-repo");
        }
      },
    });
    const before = Number(probeGit(repo, "rev-list", "--count", "refs/ha/canonical"));
    const receipt = await cell.run(
      { kind: "task-create", taskId: "task_probe_epoch", title: "stale append window" },
      probeBinding(() => oldAuthority.assert("probe-repo", oldLease.epoch, oldLease.holderId), {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId: "probe-repo",
        epoch: oldLease.epoch,
        holderId: oldLease.holderId,
      }),
    );
    assert.equal(receipt.outcome, "applied");
    assert.ok(successor);
    const successorLease = (await successor).lease;
    assert.equal(successorLease?.epoch, 2);
    assert.equal(successorLease?.holderId, "new-center");
    const beforeStale = Number(probeGit(repo, "rev-list", "--count", "refs/ha/canonical"));
    await assert.rejects(
      cell.run(
        { kind: "task-progress-append", taskId: "task_probe_epoch", text: "stale writer must not append" },
        probeBinding(() => oldAuthority.assert("probe-repo", oldLease.epoch, oldLease.holderId), {
          schema: "harness-writer-epoch-fence/v1",
          stateRoot,
          repoId: "probe-repo",
          epoch: oldLease.epoch,
          holderId: oldLease.holderId,
        }),
      ),
      (error: unknown) => (error as { readonly code?: string }).code === "writer_epoch_stale",
    );
    assert.equal(Number(probeGit(repo, "rev-list", "--count", "refs/ha/canonical")), beforeStale);
    assert.ok(beforeStale >= before);
    oldAuthority.close();
  } finally {
    await cell
      ?.close()
      .catch((error: unknown) => assert.equal((error as { readonly code?: string }).code, "materialization_failed"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote-center recovery leaves no legacy prepared publication after fencing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-prepared-")),
    repo = probeRepo(root),
    stateRoot = path.join(root, "state");
  let oldCell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    recoveryCell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const oldAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" }),
      newAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "new-center" }),
      oldLease = oldAuthority.acquire("probe-repo");
    let triggered = false;
    oldCell = await openRepoCell({
      repoId: "probe-repo" as never,
      rootDir: repo as never,
      ownerId: "old-cell",
      mode: "remote-center",
      killpoint: (point) => {
        if (point === "after_head_write" && !triggered) {
          triggered = true;
          throw new Error("simulated process death after prepared event");
        }
      },
    });
    const failed = await oldCell.run(
      { kind: "task-create", taskId: "task_probe_prepared", title: "prepared stale recovery" },
      probeBinding(() => oldAuthority.assert("probe-repo", oldLease.epoch, oldLease.holderId), {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId: "probe-repo",
        epoch: oldLease.epoch,
        holderId: oldLease.holderId,
      }),
    );
    assert.equal(failed.outcome, "op_rejected");
    assert.equal(failed.code, "service_rejected");
    assert.equal(probeGit(repo, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/").trim(), "");
    newAuthority.acquire("probe-repo");
    await assert.rejects(
      oldCell.close(),
      (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
    );
    oldCell = undefined;
    recoveryCell = await openRepoCell({
      repoId: "probe-repo" as never,
      rootDir: repo as never,
      ownerId: "new-cell",
      mode: "remote-center",
    });
    assert.equal(recoveryCell.status().state, "attached");
    assert.equal(probeGit(repo, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/").trim(), "");
    assert.equal(probeGit(repo, "rev-parse", "refs/ha/canonical"), probeGit(repo, "rev-parse", "HEAD"));
    newAuthority.close();
    oldAuthority.close();
  } finally {
    await recoveryCell?.close();
    await oldCell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
