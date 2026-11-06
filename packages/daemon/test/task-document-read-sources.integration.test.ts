// harness-test-tier: integration
// dec_E610E1D99A39003886D1B5EE7C CH3: one document read must say which cut its bytes came from.
// canonical V1 (accepted projection) and worker V2 (live authored copy / execution workspace) may
// coexist; each read labels its own source, digest, size and media type, and an execution
// observation is only observable while the execution holds an effective lease.
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import threads, { type WorkerOptions } from "node:worker_threads";
import { sha256Text, type TaskProjection } from "@harness-anything/kernel";
import { makeTaskLifecycleService } from "@harness-anything/application/internal/task-lifecycle-service";
import { makeDaemonProjectionReader, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { readProjectedDocument } from "../src/doc-sync-reads.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCellBinding } from "../src/repo-cell.ts";
import { readTaskWorktreeExecutionBinding, taskWorktreeExecutionBindingPath } from "../src/task-worktree.ts";
import {
  fixtureFence,
  openBootstrappedRepoCell as openRepoCell,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

interface DocumentRead {
  readonly status: string;
  readonly source: string;
  readonly syncState: string;
  readonly body: string;
  readonly blobSha256: string | null;
  readonly contentKind: string;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly bytes: string | null;
  readonly repositoryPath: string;
  readonly worktreeBody: string | null;
  readonly uncommitted: boolean;
  readonly canonicalVersion: {
    readonly workspaceRevision: number;
    readonly blobSha256: string;
    readonly size: number;
  } | null;
  readonly execution: {
    readonly executionId: string;
    readonly leaseVersion: number;
    readonly leaseExpiresAt: string;
    readonly observedAt: string;
  } | null;
  readonly unobservableReason: string | null;
}

const taskId = "task-doc-sources",
  executionId = "execution-doc-sources",
  V1_APPENDIX = "Canonical V1 body.",
  V2_APPENDIX = "Worker V2 body.";

async function startTaskWithTwoCuts(
  options: { readonly startBinding?: RepoCellBinding; readonly beforeOpen?: (root: string) => void } = {},
) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sources-")),
    repoId = workspaceId("task-doc-sources");
  initRepo(rootDir);
  options.beforeOpen?.(rootDir);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: repoId }),
    binding: RepoCellBinding = withPolicyGroup({ actor, source: "local" }, "admin"),
    created = (await cell.run({ kind: "task-create", taskId, title: "Document sources" }, binding)) as {
      readonly outcome: string;
      readonly opId: string;
      readonly packagePath: string;
    };
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, binding);
  const packagePath = created.packagePath;
  await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  const planPath = path.join(rootDir, "harness", packagePath, "task_plan.md"),
    canonicalBody = readFileSync(planPath, "utf8");
  // The fixture submits the scaffold. Append the two distinct cuts so canonical V1 and the live
  // authored V2 cannot be confused by sharing their whole body.
  const v1Body = `${canonicalBody}\n## Worker Notes\n\n${V1_APPENDIX}\n`,
    v2Body = `${canonicalBody}\n## Worker Notes\n\n${V2_APPENDIX}\n`;
  writeFileSync(planPath, v1Body);
  const submitted = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  const started = await cell.run({ kind: "task-start", taskId, executionId }, options.startBinding ?? binding);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForFixturePublication(cell, started.opId, binding);
  writeFileSync(planPath, v2Body);
  // The execution observes its own materialized worktree when the task has one; write the same V2
  // there so the two cuts differ in the workspace the execution view is allowed to read.
  for (const worktree of worktreeRoots(rootDir)) {
    const workerPlan = path.join(worktree, "harness", packagePath, "task_plan.md");
    if (workerPlan !== planPath && existsSync(workerPlan)) writeFileSync(workerPlan, v2Body);
  }
  return { cell, binding, rootDir, packagePath, planPath, v1Body, v2Body };
}

test("canonical V1 and worker V2 reads each label the source that owns their bytes", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const canonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
    })) as DocumentRead;
    assert.equal(canonical.source, "canonical");
    assert.equal(canonical.syncState, "unsynced", "the live copy differs from the accepted cut");
    assert.equal(canonical.body, fixture.v1Body, "the default read still returns the accepted cut");
    assert.equal(canonical.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.size, Buffer.byteLength(fixture.v1Body));
    assert.equal(canonical.bytes, null, "a text document carries no byte channel");
    assert.equal(canonical.worktreeBody, fixture.v2Body, "the live authored copy stays visible");
    assert.equal(canonical.uncommitted, true);
    assert.equal(canonical.canonicalVersion?.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.canonicalVersion?.size, Buffer.byteLength(fixture.v1Body));

    const strictCanonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "canonical",
    })) as DocumentRead;
    assert.equal(strictCanonical.source, "canonical");
    assert.equal(strictCanonical.body, fixture.v1Body);
    assert.equal(strictCanonical.blobSha256, sha256Text(fixture.v1Body));

    const authored = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "authored-copy",
    })) as DocumentRead;
    assert.equal(authored.source, "authored-copy");
    assert.equal(authored.syncState, "unsynced");
    assert.equal(authored.body, fixture.v2Body);
    assert.equal(authored.blobSha256, sha256Text(fixture.v2Body), "the digest is the digest of the returned bytes");
    assert.equal(authored.size, Buffer.byteLength(fixture.v2Body));
    assert.equal(authored.canonicalVersion?.blobSha256, sha256Text(fixture.v1Body));

    const execution = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(execution.source, "execution");
    assert.equal(execution.syncState, "unsynced");
    assert.equal(execution.body, fixture.v2Body);
    assert.equal(execution.blobSha256, sha256Text(fixture.v2Body));
    assert.equal(execution.size, Buffer.byteLength(fixture.v2Body));
    assert.equal(execution.execution?.executionId, executionId);
    assert.ok(Number(execution.execution?.leaseVersion) > 0);
    assert.match(String(execution.execution?.leaseExpiresAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(String(execution.execution?.observedAt), /^\d{4}-\d{2}-\d{2}T/u);

    const reader = makeDaemonProjectionReader({ repoId: workspaceId("task-doc-sources"), rootDir: fixture.rootDir });
    try {
      const pinnedOnly = reader.withSession((projection) =>
        readProjectedDocument(
          {
            rootDir: fixture.rootDir,
            projection: projection as TaskProjection,
            store: { readContentBlob: () => null },
          },
          { taskId, path: "task_plan.md", view: "execution", executionId },
        ),
      );
      assert.equal(pinnedOnly.source, "unobservable", "a context without a fresh-session port cannot prove ownership");
      assert.equal(pinnedOnly.unobservableReason, "execution_workspace_unavailable");
      assert.equal(pinnedOnly.body, "");
      assert.equal(pinnedOnly.execution, null);
    } finally {
      reader.close();
    }
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("an execution observation without an effective lease is unobservable", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));

    const unobservable = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(unobservable.source, "unobservable");
    assert.equal(unobservable.syncState, "unobservable");
    assert.equal(unobservable.unobservableReason, "execution_not_leased");
    assert.equal(unobservable.blobSha256, null, "no digest may describe content this read did not observe");
    assert.equal(unobservable.size, null);
    assert.equal(unobservable.bytes, null);
    assert.equal(unobservable.body, "");
    assert.equal(unobservable.execution, null);

    const foreign = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId: "execution-somebody-else",
    })) as DocumentRead;
    assert.equal(foreign.source, "unobservable");
    assert.equal(foreign.syncState, "unobservable");
    assert.equal(foreign.unobservableReason, "execution_not_found");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a missing authored copy is unobservable, not a clean workspace", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    rmSync(fixture.planPath);
    const canonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
    })) as DocumentRead;
    assert.equal(canonical.source, "canonical");
    assert.equal(canonical.body, fixture.v1Body);
    assert.equal(canonical.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.worktreeBody, null);
    // The legacy boolean cannot tell "same bytes" from "no file to compare"; the explicit state can.
    assert.equal(canonical.uncommitted, false);
    assert.equal(canonical.syncState, "unobservable");
    assert.equal(canonical.unobservableReason, "authored_copy_not_observed");

    const authored = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "authored-copy",
    })) as DocumentRead;
    assert.equal(authored.source, "unobservable");
    assert.equal(authored.syncState, "unobservable");
    assert.equal(authored.unobservableReason, "authored_copy_not_observed");
    assert.equal(authored.blobSha256, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a remote lease never relabels the center's local worktree as its observation", async () => {
  const remoteBinding: RepoCellBinding = withPolicyGroup(
    { actor, source: { kind: "node" as const, nodeId: "edge-remote" } },
    "admin",
  );
  const fixture = await startTaskWithTwoCuts({ startBinding: remoteBinding });
  try {
    // The center still has a materialized worktree with a V2 copy from this fixture; the lease,
    // however, belongs to edge-remote. That local copy cannot be presented as edge-remote's view.
    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "unobservable");
    assert.equal(observed.syncState, "unobservable");
    assert.equal(observed.unobservableReason, "execution_owner_not_local");
    assert.equal(observed.body, "");
    assert.equal(observed.blobSha256, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a stale or missing worktree execution marker is unobservable", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const worktree = worktreeRoots(fixture.rootDir).find(
      (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
    );
    assert.ok(worktree, "the fixture must have a materialized execution worktree");
    assert.equal(readTaskWorktreeExecutionBinding(worktree, executionId).binding?.executionId, executionId);

    const markerPath = taskWorktreeExecutionBindingPath(worktree, executionId);
    writeFileSync(
      markerPath,
      JSON.stringify({
        schema: "task-worktree-execution-binding/v2",
        taskId,
        executionId,
        acquiredRevision: 0,
        boundAt: new Date().toISOString(),
      }),
    );
    const stale = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(stale.source, "unobservable");
    assert.equal(stale.unobservableReason, "execution_workspace_stale_marker");
    assert.equal(stale.body, "");

    // Old node-local markers cannot be reinterpreted as acquisition proof after an upgrade.
    const lease = (await fixture.cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)?.snapshot
      .lease;
    writeFileSync(
      markerPath,
      JSON.stringify({
        schema: "task-worktree-execution-binding/v1",
        taskId,
        executionId,
        leaseVersion: lease?.version,
        boundAt: new Date().toISOString(),
      }),
    );
    const legacy = await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    });
    assert.equal(legacy.source, "unobservable");
    assert.equal(legacy.unobservableReason, "execution_workspace_marker_invalid");

    writeFileSync(markerPath, '{"schema":"task-worktree-execution-binding/v1","taskId":');
    const corrupt = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(corrupt.source, "unobservable");
    assert.equal(corrupt.unobservableReason, "execution_workspace_marker_invalid");

    rmSync(markerPath);
    const missing = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(missing.source, "unobservable");
    assert.equal(missing.unobservableReason, "execution_workspace_unbound");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a rejected competing start cannot overwrite the holder's marker", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const rejected = await fixture.cell
      .run({ kind: "task-start", taskId, executionId: "execution-competing" }, fixture.binding)
      .catch((error: unknown) => ({ outcome: "threw", message: String(error) }) as const);
    assert.notEqual(rejected.outcome, "applied", "the second start must be rejected while A holds the lease");
    const worktree = worktreeRoots(fixture.rootDir).find(
      (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
    );
    assert.ok(worktree, "the fixture must have a materialized execution worktree");
    assert.equal(
      existsSync(taskWorktreeExecutionBindingPath(worktree, "execution-competing")),
      false,
      "a rejected start must not publish a marker for its execution id",
    );

    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "execution", "the rejected competing start must not unbind execution A");
    assert.equal(observed.body, fixture.v2Body);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

// Close the RepoCell writer before calling the actual lifecycle renewal service, then reopen it.
// No renewal RPC exists; this exercises canonical lease_renewed acceptance/replay without a second writer.
async function renewFixtureLease(fixture: Awaited<ReturnType<typeof startTaskWithTwoCuts>>) {
  await fixture.cell.close();
  const repoId = workspaceId("task-doc-sources"),
    fence = fixtureFence(repoId, fixture.rootDir, path.join(fixture.rootDir, ".harness", "fixture-writer-epochs")),
    store = makeTaskEventStore({ repoId, rootDir: fixture.rootDir, writerFence: () => fence }),
    projection = makeTaskProjection({ rootDir: fixture.rootDir, eventStore: store });
  try {
    const service = makeTaskLifecycleService({ eventStore: store, projection }),
      before = projection.currentLease(taskId),
      beforeInterval = projection.readLeaseIntervals(taskId).at(-1);
    assert.ok(before, "renewal requires the started lease");
    const revision = store.read().revision + 1,
      renewed = await service.renewLease({
        taskId,
        executionId,
        actor,
        source: "local",
        expectedVersion: before.version,
        expiresAt: new Date(Date.now() + before.ttlMs).toISOString(),
        opId: "op-document-source-renew",
        eventId: "event-document-source-renew",
        workspaceRevision: revision,
        occurredAt: new Date().toISOString(),
      });
    assert.equal(renewed.version, before.version + 1);
    assert.equal(store.readTaskEvent("op-document-source-renew")?.type, "lease_renewed");
    const interval = projection.readLeaseIntervals(taskId).at(-1);
    assert.ok(interval);
    assert.equal(interval.releasedRevision, null);
    assert.equal(interval.acquiredRevision, beforeInterval?.acquiredRevision, "renewal preserves acquisition identity");
    return { before, renewed, acquiredRevision: interval.acquiredRevision };
  } finally {
    projection.close();
    await store.drain();
    fixture.cell = await openRepoCell({ repoId, rootDir: canonicalRoot(fixture.rootDir), ownerId: repoId });
  }
}

test("same-holder renewal preserves execution document observation without republishing its marker", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const markerPath = taskWorktreeExecutionBindingPath(executionWorktree(fixture), executionId),
      marker = readFileSync(markerPath, "utf8"),
      initial = await fixture.cell.read("repo.tasks.document.read", {
        taskId,
        path: "task_plan.md",
        view: "execution",
        executionId,
      });
    assert.equal(initial.source, "execution");
    const { renewed } = await renewFixtureLease(fixture);
    assert.equal(readFileSync(markerPath, "utf8"), marker, "renewal must keep the original workspace proof");
    const observed = await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    });
    assert.equal(observed.source, "execution", "an effective same-holder renewal must remain observable");
    assert.equal(observed.body, fixture.v2Body);
    assert.equal(observed.blobSha256, sha256Text(fixture.v2Body));
    assert.equal(observed.execution?.leaseVersion, renewed.version, "the response still reports current CAS version");
    assert.equal(observed.execution?.leaseExpiresAt, renewed.expiresAt);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("renewal followed by release and failed same-execution re-entry rejects the old marker", async (t) => {
  const fixture = await startFaultFixture(t);
  try {
    const worktree = executionWorktree(fixture),
      markerPath = taskWorktreeExecutionBindingPath(worktree, executionId),
      marker = readFileSync(markerPath, "utf8");
    await renewFixtureLease(fixture);
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    writeFileSync(fixture.control, JSON.stringify({ kind: "checkout", target: worktree }));
    const restarted = await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding);
    rmSync(fixture.control);
    assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
    assert.equal(readFileSync(fixture.hit, "utf8"), "checkout");
    assert.equal(readFileSync(markerPath, "utf8"), marker);
    const observed = await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    });
    assert.equal(observed.source, "unobservable");
    assert.equal(observed.unobservableReason, "execution_workspace_stale_marker");
    assert.equal(observed.body, "");
    assert.equal(observed.execution, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a same-execution re-entry publishes a marker for the new lease generation", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const before = (await fixture.cell.read("repo.tasks.list")).rows.find((candidate) => candidate.taskId === taskId);
    const firstLease = before?.snapshot.lease,
      firstMarker = readTaskWorktreeExecutionBinding(executionWorktree(fixture), executionId).binding;
    assert.ok(firstLease, "the fixture must hold a lease");
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const restarted = await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding);
    assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
    const after = (await fixture.cell.read("repo.tasks.list")).rows.find((candidate) => candidate.taskId === taskId);
    assert.notEqual(after?.snapshot.lease?.version, firstLease.version, "the new lease must have a new generation");

    const worktree = worktreeRoots(fixture.rootDir).find(
      (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
    );
    assert.ok(worktree, "the fixture must have a materialized execution worktree");
    const marker = readTaskWorktreeExecutionBinding(worktree, executionId).binding;
    assert.ok(marker);
    assert.ok(firstMarker);
    assert.ok(marker.acquiredRevision > firstMarker.acquiredRevision, "re-entry changes the acquisition revision");

    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "execution");
    assert.equal(observed.execution?.leaseVersion, after?.snapshot.lease?.version);
    assert.equal(observed.body, fixture.v2Body);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("public execution read rejects re-entry after reading A marker and before reading B bytes", async (t) => {
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const fixture = await startTaskWithTwoCuts({
    beforeOpen() {
      // Pause only real reader workers, after readFileSync has copied marker A. The SQLite A
      // session stays open while the independent writer releases A and accepts re-entry B.
      const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";
const barrier = new Int32Array(workerData.documentReadBarrier);
const nativeRead = fs.readFileSync;
fs.readFileSync = function(...args) {
  const bytes = nativeRead(...args);
  if (String(args[0]).endsWith(${JSON.stringify(`${Buffer.from(executionId).toString("base64url")}.json`)}) &&
      Atomics.compareExchange(barrier, 0, 1, 2) === 1) {
    Atomics.notify(barrier, 0);
    while (Atomics.load(barrier, 0) === 2) Atomics.wait(barrier, 0, 2);
  }
  return bytes;
};
syncBuiltinESMExports();
`;
      const NativeWorker = threads.Worker;
      t.mock.method(
        threads,
        "Worker",
        class extends NativeWorker {
          constructor(filename: string | URL, options: WorkerOptions = {}) {
            const reader = String(filename).includes("repo-writer-worker.") && options.workerData?.role === "reader";
            super(
              filename,
              reader
                ? {
                    ...options,
                    workerData: { ...options.workerData, documentReadBarrier: barrier.buffer },
                    execArgv: [
                      ...(options.execArgv ?? []),
                      "--import",
                      `data:text/javascript,${encodeURIComponent(preload)}`,
                    ],
                  }
                : options,
            );
          }
        },
      );
      syncBuiltinESMExports();
    },
  });
  let pending: ReturnType<typeof fixture.cell.read> | undefined;
  try {
    const worktree = executionWorktree(fixture),
      markerA = readTaskWorktreeExecutionBinding(worktree, executionId).binding,
      leaseA = (await fixture.cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)?.snapshot.lease;
    assert.ok(markerA);
    assert.ok(leaseA);
    Atomics.store(barrier, 0, 1);
    pending = fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    });
    await Promise.race([
      (async () => {
        while (Atomics.load(barrier, 0) === 1) await Atomics.waitAsync(barrier, 0, 1).value;
        assert.equal(Atomics.load(barrier, 0), 2, "public reader must pause with A marker copied");
      })(),
      pending.then(() => assert.fail("public read finished without reaching marker A pause")),
    ]);
    assert.equal((await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding)).outcome, "applied");
    const restarted = await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding);
    assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
    const markerB = readTaskWorktreeExecutionBinding(worktree, executionId).binding,
      leaseB = (await fixture.cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)?.snapshot.lease,
      bodyB = `${fixture.v2Body}\nNew acquisition B.\n`;
    assert.ok(markerB);
    assert.ok(leaseB);
    assert.notEqual(leaseB.version, leaseA.version);
    assert.ok(markerB.acquiredRevision > markerA.acquiredRevision, "re-entry must advance the acquisition");
    writeFileSync(path.join(worktree, "harness", fixture.packagePath, "task_plan.md"), bodyB);
    Atomics.store(barrier, 0, 3);
    Atomics.notify(barrier, 0);
    const observed = (await pending) as DocumentRead;
    assert.equal(observed.source, "unobservable", "B bytes must never carry A's released lease");
    assert.equal(observed.unobservableReason, "execution_workspace_stale_marker");
    assert.equal(observed.body, "");
    assert.equal(observed.execution, null);
    assert.equal(observed.blobSha256, null);
    assert.equal(observed.bytes, null);
    assert.equal(observed.size, null);

    const fresh = await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    });
    assert.equal(fresh.source, "execution");
    assert.equal(fresh.body, bodyB);
    assert.equal(fresh.blobSha256, sha256Text(bodyB));
    assert.equal(fresh.execution?.executionId, executionId);
    assert.equal(fresh.execution?.leaseVersion, leaseB.version);
    assert.equal(fresh.execution?.leaseExpiresAt, leaseB.expiresAt);
  } finally {
    Atomics.store(barrier, 0, 3);
    Atomics.notify(barrier, 0);
    await pending;
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a same-execution checkout failure cannot reuse the previous lease's marker", async (t) => {
  const fixture = await startFaultFixture(t);
  try {
    const worktree = executionWorktree(fixture),
      markerPath = taskWorktreeExecutionBindingPath(worktree, executionId),
      previousMarker = readFileSync(markerPath, "utf8");
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    writeFileSync(fixture.control, JSON.stringify({ kind: "checkout", target: worktree }));
    const restarted = await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding);
    rmSync(fixture.control);
    assert.equal(readFileSync(fixture.hit, "utf8"), "checkout", "the writer must hit the real checkout failure");
    assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
    assert.match(String(restarted.warnings?.join("\n")), /injected checkout failure/u);
    assert.equal(readFileSync(markerPath, "utf8"), previousMarker, "the old proof is still on disk");
    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "unobservable");
    assert.equal(observed.unobservableReason, "execution_workspace_stale_marker");
    assert.equal(observed.body, "");
    assert.equal(observed.blobSha256, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a failed marker write cannot publish even complete new bytes over the old proof", async (t) => {
  const fixture = await startFaultFixture(t);
  try {
    const worktree = executionWorktree(fixture),
      markerPath = taskWorktreeExecutionBindingPath(worktree, executionId),
      previousMarker = readFileSync(markerPath, "utf8"),
      markerDirectory = path.dirname(markerPath);
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    // A failed write can have written all bytes. Only a separate successful rename may publish proof.
    writeFileSync(fixture.control, JSON.stringify({ kind: "write", target: markerDirectory }));
    const restarted = await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding);
    rmSync(fixture.control);
    assert.equal(readFileSync(fixture.hit, "utf8"), "write", "the writer must hit the marker write failure");
    assert.equal(restarted.outcome, "applied", "the committed start must not be reported as rejected");
    assert.match(String(restarted.warnings?.join("\n")), /execution marker was not written/u);
    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "unobservable", "failed marker publication cannot be trusted");
    assert.equal(observed.unobservableReason, "execution_workspace_stale_marker");
    assert.equal(observed.body, "");
    assert.equal(observed.execution, null);
    assert.equal(readFileSync(markerPath, "utf8"), previousMarker, "the previous generation stays intact");
    assert.deepEqual(readdirSync(markerDirectory), [path.basename(markerPath)], "temporary proof is cleaned up");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

/** Inject inside the real RepoCell writer, as runtime-observation-fault's worker preload does. */
async function startFaultFixture(t: TestContext) {
  let control = "",
    hit = "";
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const fixture = await startTaskWithTwoCuts({
    beforeOpen(root) {
      control = path.join(root, ".harness", "marker-test-fault.json");
      hit = path.join(root, ".harness", "marker-test-fault-hit");
      const preload = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const nativeExists = fs.existsSync, nativeWrite = fs.writeFileSync;
function fail(kind, target) {
  if (!nativeExists(${JSON.stringify(control)})) return;
  const fault = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
  if (fault.kind === kind && String(target) === fault.target) {
    nativeWrite(${JSON.stringify(hit)}, kind);
    throw new Error("injected " + kind + " failure");
  }
}
fs.existsSync = function(target) { fail("checkout", target); return nativeExists(target); };
fs.writeFileSync = function(...args) {
  nativeWrite(...args);
  fail("write", path.dirname(String(args[0])));
};
syncBuiltinESMExports();
`;
      const NativeWorker = threads.Worker;
      t.mock.method(
        threads,
        "Worker",
        class extends NativeWorker {
          constructor(filename: string | URL, options: WorkerOptions = {}) {
            const writer = String(filename).includes("repo-writer-worker.") && options.workerData?.role !== "reader";
            super(
              filename,
              writer
                ? {
                    ...options,
                    execArgv: [
                      ...(options.execArgv ?? []),
                      "--import",
                      `data:text/javascript,${encodeURIComponent(preload)}`,
                    ],
                  }
                : options,
            );
          }
        },
      );
      syncBuiltinESMExports();
    },
  });
  return { ...fixture, control, hit };
}

function executionWorktree(fixture: { readonly rootDir: string; readonly packagePath: string }): string {
  const worktree = worktreeRoots(fixture.rootDir).find(
    (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
  );
  assert.ok(worktree, "the fixture must have a materialized execution worktree");
  return worktree;
}

test("a marker write failure keeps the applied start and leaves observation unobservable", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const worktree = worktreeRoots(fixture.rootDir).find(
      (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
    );
    assert.ok(worktree, "the fixture must have a materialized execution worktree");
    const markerPath = taskWorktreeExecutionBindingPath(worktree, executionId);
    rmSync(markerPath);
    mkdirSync(markerPath);

    // Rejoin the same execution after release: the lifecycle start applies, but the marker write fails.
    const outcome = (await fixture.cell.run({ kind: "task-start", taskId, executionId }, fixture.binding)) as {
      readonly outcome: string;
      readonly warnings?: readonly string[];
    };
    assert.equal(outcome.outcome, "applied", "the committed start must not be reported as rejected");
    assert.match(
      String(outcome.warnings?.join("\n") ?? ""),
      /execution marker was not written/iu,
      "the receipt must carry the marker failure as a warning",
    );
    const row = (await fixture.cell.read("repo.tasks.list")).rows.find((candidate) => candidate.taskId === taskId);
    assert.notEqual(row?.snapshot.lease, null, "the applied start keeps its lease");

    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "unobservable");
    assert.equal(observed.body, "");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Task Doc Sources Test");
  git(rootDir, "config", "user.email", "task-doc-sources@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function worktreeRoots(rootDir: string): readonly string[] {
  return execFileSync("git", ["-C", rootDir, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}
