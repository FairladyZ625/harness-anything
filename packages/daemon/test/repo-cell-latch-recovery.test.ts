// harness-test-tier: integration
import assert from "node:assert/strict";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  commitRuntimeSessionBundle,
  type RuntimeSessionBundle,
} from "@harness-anything/application/internal/commands/entity-action-runtime-session.ts";
import {
  createImmutableLegacyGenerationSnapshot,
  legacyGenerationSnapshotPath,
  makeTaskEventReader,
  openSqliteEventStore,
} from "@harness-anything/storage";
import {
  bindWriterGenerationToken,
  serializePersistedCanonicalEvent,
  sha256Text,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type TaskProjection,
  type WriteReceipt,
} from "@harness-anything/kernel";
import {
  contentClaims,
  preflightConvertedGenerationActivation,
} from "../../storage/test/store/canonical-generation.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { causeClassOf, chainRepoCellWrite, type RepoCell } from "../src/daemon-host/repo-cell.ts";
import type { RepoCellQueueObservation } from "../src/daemon-host/repo-cell-types.ts";
import {
  fixtureFence,
  openBootstrappedRepoCell as openRepoCell,
  settleSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { openWriterSupervisor, type WriterSupervisor } from "../src/daemon-host/writer-supervisor.ts";
import type { RepoWriterStatusV1 } from "../src/daemon-host/repo-writer-protocol.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import { projectedTaskIds } from "../src/daemon-host/repo-cell-receipts.ts";
import { cellCodedError } from "../src/daemon-host/repo-cell-errors.ts";
import { recoveryCommandPolicy } from "../src/daemon-host/recovery-state.ts";
import { enqueueRuntimePublication } from "../src/daemon-host/runtime-publication-queue.ts";
import type { RepoCellApiContext } from "../src/daemon-host/repo-cell-types.ts";
import { appendRuntimeWorkerRecord } from "../src/daemon-host/dispatch-stream.ts";
import type { RuntimeLauncher } from "../src/daemon-host/runtime-spawn-types.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForArrival } from "../../../tools/fixtures/event-arrival.ts";

const actor = { principal: { personId: "person-latch" }, executor: null } as const;

test("runtime session commits reject denied authorization before touching the store", () => {
  let appends = 0;
  assert.throws(
    () =>
      commitRuntimeSessionBundle(
        { append: () => appends++ } as unknown as CanonicalEventStore,
        {} as TaskProjection,
        {} as RuntimeSessionBundle,
        { outcome: "denied" } as unknown as AuthorizationDecision,
        () => {},
      ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "actor_unauthorized",
  );
  assert.equal(appends, 0);
});

test("task identity lookup serves the projection's rows when it is caught up", () => {
  const reads = { count: 0 },
    cell = {
      knownTaskIds: null,
      projection: {
        list: () => {
          reads.count += 1;
          return { watermark: 4, sourceRevision: 4, rows: [{ taskId: "task-projected" }] };
        },
      },
      cellCodedError,
    };
  assert.deepEqual([...projectedTaskIds(cell)], ["task-projected"]);
  assert.deepEqual([...projectedTaskIds(cell)], ["task-projected"]);
  assert.equal(reads.count, 1);
});

test("task identity lookup fails closed while the projection lags", () => {
  const reads = { count: 0 },
    cell = {
      knownTaskIds: null,
      projection: {
        list: () => {
          reads.count += 1;
          return { watermark: 2, sourceRevision: 4, rows: [{ taskId: "task-projected" }] };
        },
      },
      cellCodedError,
    };
  // A lagging projection must not hand task_exists an under-populated (or empty) identity set.
  for (const attempt of [1, 2]) {
    assert.throws(
      () => projectedTaskIds(cell),
      (error: Error & { code?: string }) =>
        error.code === "content_not_ready" && /watermark 2, source revision 4/u.test(error.message),
      `attempt ${String(attempt)}`,
    );
  }
  assert.equal(cell.knownTaskIds, null);
  assert.equal(reads.count, 2);
});

test("projection recovery names and carries the reachable rebuild command", () => {
  assert.equal(causeClassOf(new Error("lifecycle document projection mismatch for INDEX.md")), "projection");
  assert.equal(
    causeClassOf(new Error("projection cache ledger identity mismatch; run daemon projection rebuild")),
    "projection",
  );
  assert.equal(causeClassOf(new Error("kernel projection schema 999 is newer than daemon schema 3")), "data-shape");
  assert.equal(causeClassOf(new TypeError("fetch failed")), "infrastructure");
  assert.deepEqual(recoveryCommandPolicy("projection-rebuild", "projection"), {
    causes: ["projection"],
    settlesLatch: true,
  });
  assert.equal(recoveryCommandPolicy("projection-rebuild", "data-shape"), null);
  assert.equal(recoveryCommandPolicy("projection-rebuild", "infrastructure"), null);
  assert.equal(recoveryCommandPolicy("ledger-migrate", "data-shape"), null);
  assert.deepEqual(recoveryCommandPolicy("migrate-import", "data-shape"), {
    causes: ["data-shape"],
    settlesLatch: true,
  });
  assert.equal(recoveryCommandPolicy("migrate-import", "projection"), null);
  assert.equal(recoveryCommandPolicy("migrate-import", "infrastructure"), null);
  assert.deepEqual(recoveryCommandPolicy("receipt-show", "infrastructure"), {
    causes: ["data-shape", "infrastructure"],
    settlesLatch: false,
  });
});

test("a runtime publication request names the queue head it waited behind", async () => {
  const repoId = "runtime-publication-queue-head",
    recoveryCalls = { count: 0 };
  provisionPolicyTestRepository(repoId);
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  const context = runtimePublicationContext({
    repoId,
    causeClass: "infrastructure",
    recoveryCalls,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
    revision: 7,
  });
  let releaseQueueHead!: () => void;
  const queueHeadGate = new Promise<void>((resolve) => {
      releaseQueueHead = resolve;
    }),
    headTurn = chainRepoCellWrite(context.tail, () => queueHeadGate, {
      queue: context.writeQueue,
      label: { command: "task-review-execution", requestId: "writer-request-head" },
    });
  context.tail = headTurn.then(
    () => undefined,
    () => undefined,
  );
  for (let turn = 0; turn < 20 && context.writeQueue.waiting[0]?.startedAtMs === undefined; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const runtimeObservation: RepoCellQueueObservation = {
      label: { command: "runtime-run", requestId: "writer-request-runtime" },
    },
    runtimePublication = enqueueRuntimePublication(
      context,
      "runtime-run",
      { kind: "runtime-spawn", taskId: null },
      binding,
      () => ({ runtimeSessionId: "runtime_queued" }),
      runtimeObservation,
    );
  assert.deepEqual(runtimeObservation.head, {
    requestId: "writer-request-head",
    command: "task-review-execution",
    executingMs: 0,
  });
  releaseQueueHead();
  await runtimePublication;
  assert.equal(context.writeQueue.waiting.length, 0, "the runtime turn drains its queue entry");
});

test("an infrastructure latch admits only a local unbound runtime rescue on a complete cut", async () => {
  const repoId = "latched-runtime-rescue",
    recoveryCalls = { count: 0 },
    launches: string[] = [];
  provisionPolicyTestRepository(repoId);
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    context = runtimePublicationContext({
      repoId,
      causeClass: "infrastructure",
      recoveryCalls,
      cut: { status: "ready", watermark: 7, sourceRevision: 7 },
      revision: 7,
    });
  const receipt = await enqueueRuntimePublication(
    context,
    "runtime-run",
    { kind: "runtime-spawn", taskId: null },
    binding,
    (authorized) => {
      assert.equal(authorized.authorizationDecision?.outcome, "allowed");
      launches.push("runtime-session-recorded");
      return { runtimeSessionId: "runtime_rescue" };
    },
  );
  assert.equal(receipt.runtimeSessionId, "runtime_rescue");
  assert.deepEqual(launches, ["runtime-session-recorded"]);
  assert.equal(recoveryCalls.count, 0, "the rescue turn must not close the current writer/projection handles");

  const taskBound = runtimePublicationContext({
    repoId,
    causeClass: "infrastructure",
    recoveryCalls,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
    revision: 7,
  });
  await assert.rejects(
    enqueueRuntimePublication(
      taskBound,
      "runtime-run",
      { kind: "runtime-spawn", taskId: "task_bound" },
      binding,
      () => {
        launches.push("task-bound-should-not-launch");
        return {};
      },
    ),
    (error: Error & { code?: string }) => error.code === "repo_unavailable",
  );
  assert.equal(launches.length, 1);
  assert.equal(recoveryCalls.count, 1, "task-bound dispatch stays on the normal recovery path");

  const projectionLatch = runtimePublicationContext({
    repoId,
    causeClass: "projection",
    recoveryCalls,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
    revision: 7,
  });
  await assert.rejects(
    enqueueRuntimePublication(projectionLatch, "runtime-run", { kind: "runtime-spawn", taskId: null }, binding, () => {
      launches.push("projection-should-not-launch");
      return {};
    }),
    (error: Error & { code?: string }) => error.code === "repo_unavailable",
  );
  assert.equal(launches.length, 1);

  const laggingProjection = runtimePublicationContext({
    repoId,
    causeClass: "infrastructure",
    recoveryCalls,
    cut: { status: "ready", watermark: 6, sourceRevision: 7 },
    revision: 7,
  });
  await assert.rejects(
    enqueueRuntimePublication(
      laggingProjection,
      "runtime-run",
      { kind: "runtime-spawn", taskId: null },
      binding,
      () => {
        launches.push("lagging-projection-should-not-launch");
        return {};
      },
    ),
    (error: Error & { code?: string }) => error.code === "repo_unavailable",
  );
  assert.equal(launches.length, 1);
  assert.equal(recoveryCalls.count, 3, "an incomplete cut cannot use the rescue path");

  const uncertainRecovery = runtimePublicationContext({
    repoId,
    causeClass: "infrastructure",
    recoveryCalls,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
    revision: 7,
    recoveryUncertain: true,
  });
  await assert.rejects(
    enqueueRuntimePublication(
      uncertainRecovery,
      "runtime-run",
      { kind: "runtime-spawn", taskId: null },
      binding,
      () => {
        launches.push("uncertain-recovery-should-not-launch");
        return {};
      },
    ),
    (error: Error & { code?: string }) => error.code === "repo_unavailable",
  );
  assert.equal(launches.length, 1);
});

test("Git event-layout corruption cannot revoke SQLite acceptance or reads", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-ignores-git-layout-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const repoId = workspaceId("sqlite-ignores-git-layout"),
      binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-git-one" });
    const accepted = await cell.run(
      { kind: "task-create", taskId: "task_sqlite_truth", title: "SQLite truth" },
      binding,
    );
    assert.equal(accepted.outcome, "applied");
    await cell.close();
    cell = undefined;
    mkdirSync(path.join(rootDir, "harness/events"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/events/legacy-flat.json"), "{}\n");
    git(rootDir, "add", "harness/events/legacy-flat.json");
    git(rootDir, "commit", "-qm", "corrupt retired Git event layout");
    git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-git-two" });
    assert.equal(cell.status().state, "attached");
    const listed = await cell.run({ kind: "task-list" }, binding);
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.match(String(listed.evidence), /task_sqlite_truth/u);
    const receipt = await cell.run({ kind: "receipt-show", opId: accepted.opId }, binding);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("SQLite malformed canonical rows fail closed during operator activation validation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-invalid-activation-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const repoId = workspaceId("sqlite-invalid-activation"),
      binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-invalid-one" });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_before_corruption", title: "Before" }, binding)).outcome,
      "applied",
    );
    await cell.close();
    cell = undefined;
    const source = makeTaskEventReader({ repoId, rootDir, generation: 3 });
    const legacy = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 1 });
    for (const event of source.read().events) {
      const blobs = contentClaims(event).map((claim) => ({
        ...claim,
        body: source.readContentBlob(claim.sha256)!,
      }));
      legacy.appendCommand({
        fence: { repoId, holder: "malformed-fixture", epoch: 1 },
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
          summary: event.type,
        },
        events: [event],
        blobs,
      });
    }
    await source.drain();
    const snapshotPath = legacyGenerationSnapshotPath(rootDir);
    const snapshotSource = {
      read: () => ({
        schema: "canonical-event-stream/v1" as const,
        revision: legacy.revision(),
        events: legacy.events(),
      }),
      readBatch: (cursor: string | null, maxItems: number) => {
        const all = legacy.events();
        const start = cursor === null ? 0 : Number(cursor);
        const slice = all.slice(start, start + maxItems);
        const next = start + slice.length;
        return {
          sourceRevision: all.length,
          events: slice,
          cursor: slice.length > 0 ? String(next) : cursor,
          done: next >= all.length,
          accessedItems: slice.length,
          prefetchContent: () => new Map(),
        };
      },
      readContentBlob: (sha256: string) => legacy.readContentObject(sha256),
    } as unknown as Parameters<typeof createImmutableLegacyGenerationSnapshot>[0]["source"];
    const snapshot = createImmutableLegacyGenerationSnapshot({ repoId, source: snapshotSource, snapshotPath });
    const databasePath = path.join(rootDir, ".harness/store/generations/1/ledger.sqlite");
    writeFileSync(
      `${databasePath}.import-source.json`,
      `${JSON.stringify({ schema: "generation-import-source/v1", sourceDigest: snapshot.sourceDigest })}\n`,
    );
    legacy.close();
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE event SET event_json = ? WHERE revision = 1").run("{}");
    db.close();
    assert.throws(
      () =>
        preflightConvertedGenerationActivation({
          repoId,
          rootDir,
          snapshotPath: legacyGenerationSnapshotPath(rootDir),
          databasePath,
        }),
      /event|canonical|invalid|schema/iu,
    );
    // The cached projection can serve a previously validated event cut without replaying old
    // event_json rows. Damage the active store itself to exercise attach's mandatory store probe.
    writeFileSync(path.join(rootDir, ".harness/store/generations/3/ledger.sqlite"), "not a SQLite database");
    await assert.rejects(
      () => openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-invalid-reopen" }),
      /database|sqlite/iu,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("projection rebuild is executable from a projection latch and settles it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-latch-projection-rebuild-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-one",
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_projection_rebuild", title: "Projection rebuild" }, binding))
        .outcome,
      "applied",
    );
    await cell.close();
    cell = undefined;
    const cache = path.join(rootDir, ".harness/cache/task.sqlite"),
      db = new DatabaseSync(cache),
      original = String(
        (
          db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get("task_projection_rebuild") as {
            readonly snapshot_json: string;
          }
        ).snapshot_json,
      );
    const corrupted = JSON.parse(original) as { task: { schema: string } };
    corrupted.task.schema = "task/broken";
    db.prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?").run(
      JSON.stringify(corrupted),
      "task_projection_rebuild",
    );
    db.close();
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-two",
    });
    const latched = await cell.run({ kind: "task-list" }, binding);
    assert.equal(latched.outcome, "op_rejected");
    assert.equal(cell.status().state, "unavailable");
    assert.equal(cell.status().causeClass, "projection");
    assert.equal(cell.status().projectionReadable, false);
    const blocked = await cell.run({ kind: "task-list" }, binding);
    assert.equal(blocked.code, "repo_unavailable");
    assert.deepEqual(blocked.diagnostic, { kind: "failure", code: "repo_unavailable" });
    const rebuilt = await cell.run({ kind: "projection-rebuild" }, binding);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
    assert.equal(cell.status().state, "attached");
    await cell.close();
    cell = undefined;
    const repaired = new DatabaseSync(cache),
      rebuiltSnapshot = repaired
        .prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?")
        .get("task_projection_rebuild") as { readonly snapshot_json: string };
    assert.equal(rebuiltSnapshot.snapshot_json, original);
    repaired.close();
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-three",
    });
    assert.equal((await cell.run({ kind: "task-list" }, binding)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const surface of ["cell", "writer"] as const)
  test(`${surface} publishes the replacement store cut after in-place latch recovery`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${surface}-recovered-cut-`)),
      repoId = workspaceId(`${surface}-recovered-cut`),
      binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      statuses: RepoWriterStatusV1[] = [];
    let cell: RepoCell | undefined,
      writer: WriterSupervisor | undefined,
      failAfterCommit = false,
      workerCount = 0;
    try {
      initRepo(rootDir);
      provisionPolicyTestRepository(repoId);
      await settleSettingsEvent({ repoId, rootDir });
      const input = {
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: `${surface}-recovered-cut`,
        keycloakCenter: policyTestCenter,
        defaultWriterEpochFence: fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs")),
        killpoint: (point: string) => {
          if (point === "after_store_commit" && failAfterCommit) {
            failAfterCommit = false;
            throw new Error("lose response after SQLite acceptance");
          }
        },
      };
      if (surface === "cell") cell = await openRepoWriterCell(input, { close: async () => undefined } as never);
      else
        writer = await openWriterSupervisor(input, {
          createWorker: (url, options) => {
            workerCount += 1;
            const worker = new Worker(url, options);
            worker.on("message", (message: RepoWriterStatusV1) => {
              if (message.schema === "harness-repo-writer-status/v1") statuses.push(message);
            });
            return worker;
          },
        });
      const originalReplica = cell?.replica,
        cut = () => (cell ? cell.replica.ledgerCut() : writer!.ledgerCut()),
        status = () => (cell ? cell.status() : writer!.status()),
        run: RepoCell["run"] = (action, auth) =>
          cell ? cell.run(action, auth) : writer!.request<WriteReceipt>("run", { action }, auth),
        before = cut()!;
      failAfterCommit = true;
      const lost = await run(
        { kind: "task-create", taskId: "task_recovered_cut", title: "Accepted before latch" },
        binding,
      );
      assert.equal(lost.code, "publication_indeterminate", JSON.stringify(lost));
      assert.equal(status().state, "unavailable");
      const reader = makeTaskEventReader({ repoId, rootDir });
      let accepted: NonNullable<ReturnType<typeof reader.currentCut>>;
      try {
        accepted = reader.currentCut()!;
      } finally {
        await reader.drain();
      }
      assert.equal(accepted.revision, before.revision + 1, "the failed response still committed exactly one event");
      assert.notEqual(accepted.headDigest, before.headDigest);
      // This read recovers in place and has no receipt cut for the writer to reuse.
      const listed = await run({ kind: "task-list" }, binding);
      assert.equal(listed.outcome, "applied", JSON.stringify(listed));
      assert.equal("cut" in listed, false);
      assert.match(String(listed.evidence), /task_recovered_cut/u);
      assert.equal(status().state, "attached");
      assert.equal(status().ledgerRevision, accepted.revision);
      assert.deepEqual(cut(), accepted, "the public cut follows the replacement SQLite owner");
      if (cell) assert.notEqual(cell.replica, originalReplica);
      else {
        assert.equal(workerCount, 1, "recovery retains the writer process");
        assert.ok(statuses.some((message) => message.status?.state === "unavailable"));
        assert.ok(
          statuses.some((message) => message.kind === "cut" && message.ledgerCut?.headDigest === accepted.headDigest),
        );
      }
      t.diagnostic(JSON.stringify({ surface, before, accepted, recovered: cut(), workerCount }));
    } finally {
      await cell?.close();
      await writer?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

test("a queued write rechecks Cell state after close begins", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cell-close-queue-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("cell-close-queue"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "cell-close-queue",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    const headBeforeClose = makeTaskEventReader({ repoId: "cell-close-queue", rootDir }).readHead();
    const pending = cell.run(
        { kind: "task-create", taskId: "task_must_not_publish", title: "Must not publish" },
        binding,
      ),
      closing = cell.close();
    const receipt = await pending;
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "repo_unavailable");
    await closing;
    cell = undefined;
    assert.deepEqual(makeTaskEventReader({ repoId: "cell-close-queue", rootDir }).readHead(), headBeforeClose);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test(
  "squad coordinator routes reads, spawns, and schedule settlements to replacement handles after in-place latch recovery",
  { timeout: 90_000 },
  async (t) => {
    type StubProvider = {
      readonly dispatchId: string;
      readonly sessionId: string;
      readonly process: ReturnType<typeof spawn>;
      output?: (chunk: string) => void;
      exit?: (code: number | null) => void;
    };
    const parent = mkdtempSync(path.join(tmpdir(), "ha-cell-squad-latch-recovery-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      bare = path.join(parent, "remote.git"),
      repoId = workspaceId("cell-squad-latch-recovery"),
      taskId = "task_squad_after_latch",
      scheduleId = "schedule-squad-after-latch",
      binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      providers: StubProvider[] = [],
      activityWaiters = new Set<() => void>(),
      wakeActivity = () => {
        for (const wake of activityWaiters) wake();
      },
      onActivity = (arrive: () => void) => {
        activityWaiters.add(arrive);
        return () => activityWaiters.delete(arrive);
      },
      stopStubProcess = async (child: ReturnType<typeof spawn>): Promise<void> => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        } else {
          child.kill("SIGKILL");
        }
        await closed;
      };
    let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | undefined,
      failAfterCommit = false;
    try {
      mkdirSync(rootDir);
      git(rootDir, "init", "-q", "-b", "main");
      git(rootDir, "config", "user.name", "Latch Recovery Test");
      git(rootDir, "config", "user.email", "latch-recovery@example.invalid");
      git(rootDir, "commit", "--allow-empty", "-qm", "base");
      git(parent, "init", "--bare", bare);
      git(rootDir, "remote", "add", "origin", bare);
      mkdirSync(path.join(rootDir, "harness"));
      writeFileSync(
        path.join(rootDir, "harness/harness.yaml"),
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n",
      );
      writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
      git(rootDir, "add", ".gitignore");
      git(rootDir, "commit", "-qm", "test: fixture gitignore");

      provisionPolicyTestRepository(repoId);
      const runtimeInstances = () => [
          {
            schemaVersion: 2 as const,
            instanceId: "stub",
            name: "Stub",
            kindId: "codex" as const,
            installationId: "installation-stub",
            providerId: "openai" as const,
            models: ["stub-model"],
            defaultModel: "stub-model",
            enabled: true,
            permissionMode: "workspace-write" as const,
            codex: {},
            authMode: "subscription" as const,
            authState: "configured" as const,
            authReadiness: { status: "ready" as const, code: null, hint: null },
            isolationState: "enforced" as const,
          },
        ],
        fence = fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs"));
      await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence, runtimeInstances: runtimeInstances() });

      const runtimeLaunch: RuntimeLauncher = (prepared, persistence) => {
        const child = spawn("git", ["hash-object", "--stdin"], {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
        });
        if (!child.pid) throw new Error("stub runtime child did not expose a pid");
        child.unref();
        const provider: StubProvider = {
          dispatchId: persistence.dispatchId,
          sessionId: prepared.args[0] ?? `provider-${persistence.dispatchId}`,
          process: child,
        };
        providers.push(provider);
        queueMicrotask(wakeActivity);
        return {
          pid: child.pid,
          onOutput: (listener) => {
            provider.output = listener;
            queueMicrotask(() =>
              listener(JSON.stringify({ type: "thread.started", thread_id: provider.sessionId }) + "\n"),
            );
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            provider.exit = listener;
          },
          terminate: () => {
            void stopStubProcess(child);
          },
          terminateTree: () => stopStubProcess(child),
        };
      };

      cell = await openRepoWriterCell(
        {
          repoId,
          rootDir: canonicalRoot(rootDir),
          ownerId: "cell-squad-latch-recovery",
          keycloakSession: async () => binding.keycloakAuthorization.session,
          keycloakCenter: policyTestCenter,
          defaultWriterEpochFence: fence,
          runtimeDaemonRoute: {
            userRoot,
            daemonId: "test",
            endpoint: path.join(parent, "socket"),
          },
          runtimeInstances,
          prepareRuntimeLaunch: async (instanceId, request) => ({
            definition: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId,
              installationId: "installation-stub",
              kindId: "codex",
              providerId: "openai",
              model: "stub-model",
              reasoningEffort: null,
              endpointKind: "official",
              baseUrlHash: null,
              authMode: "subscription",
            },
            installation: {
              installationId: "installation-stub",
              kindId: "codex",
              executablePath: "/fixture/stub",
              version: "1.0.0",
              observedAt: "2026-11-20T00:00:00.000Z",
            },
            executablePath: "/fixture/stub",
            args: request.providerSessionId ? [request.providerSessionId] : [],
            env: process.env,
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          runtimeLaunch,
          onRuntimeOutcome: () => {
            wakeActivity();
          },
          killpoint: (point: string) => {
            if (point === "after_store_commit" && failAfterCommit) {
              failAfterCommit = false;
              throw new Error("lose response after SQLite acceptance");
            }
          },
        },
        { close: async () => undefined } as never,
      );

      const finishProvider = async (dispatchId: string, text: string) => {
        const provider = await waitForArrival(
          () => providers.find((entry) => entry.dispatchId === dispatchId && entry.output && entry.exit) ?? null,
          onActivity,
        );
        const events = [
          { type: "item.completed", item: { id: "result", type: "agent_message", text } },
          { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
        ];
        provider.output!(events.map((event) => JSON.stringify(event) + "\n").join(""));
        await stopStubProcess(provider.process);
        appendRuntimeWorkerRecord(rootDir, dispatchId, {
          kind: "process_exit",
          occurredAt: new Date().toISOString(),
          exitCode: 0,
          signal: null,
        });
        provider.exit!(0);
      };
      const until = <T>(read: () => T | null | Promise<T | null>, label: string): Promise<T> =>
        waitForArrival(async () => {
          await cell!.settlePendingMaterialization(label);
          return read();
        }, onActivity);

      for (const [id, role] of [
        ["leader", "commander"],
        ["one", "worker"],
      ] as const) {
        const receipt = await cell.run(
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id,
              name: id,
              role,
              instructions: "Perform the assigned role.",
              runtimes: [{ type: "codex" }],
            },
          },
          binding,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      }
      const squadInstalled = await cell.run(
        {
          kind: "squad-install",
          declaration: {
            schema: "squad-declaration/v1",
            id: "squad",
            name: "Squad",
            leader: "leader",
            workers: ["one"],
            leaderTurnBudget: 4,
            roster: "Leader coordinates worker one and writes artifacts/reports/{squadRunId}.md.",
          },
        },
        binding,
      );
      assert.equal(squadInstalled.outcome, "applied", JSON.stringify(squadInstalled));

      // Start a scheduled Squad occurrence before the latch so its post-recovery terminal
      // settlement must execute against the replacement entityActionExecutor/store/projection.
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId,
              name: "Scheduled Squad Before Latch",
              mode: "detect",
              everyMs: 300_000,
              squadId: "squad",
              mission: "Verify schedule settlement after in-place latch recovery.",
              idempotencyKey: "create-schedule-before-latch",
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      const scheduled = await cell.run(
        { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-schedule-before-latch" },
        binding,
      );
      assert.equal(scheduled.outcome, "applied", JSON.stringify(scheduled));
      const scheduledDispatchId = providers.at(-1)?.dispatchId;
      assert.ok(
        scheduledDispatchId,
        `the schedule launched a durable leader runtime: ${JSON.stringify({ scheduled, dispatchIds: providers.map(({ dispatchId }) => dispatchId) })}`,
      );

      const createdTask = await cell.run(
        { kind: "task-create", taskId, title: "Squad run after latch recovery", presetId: "docs-task" },
        binding,
      );
      assert.equal(createdTask.outcome, "applied", JSON.stringify(createdTask));
      await waitForFixturePublication(cell as unknown as RepoCell, createdTask.opId, binding);
      await realizeTaskPlanFixture(rootDir, String((createdTask as Record<string, unknown>).packagePath), (planPath) =>
        cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );

      const originalReplica = cell.replica;
      failAfterCommit = true;
      const lost = await cell.run(
        { kind: "task-create", taskId: "task_latch_before_squad", title: "Triggers in-place latch" },
        binding,
      );
      assert.equal(lost.code, "publication_indeterminate", JSON.stringify(lost));
      assert.equal(cell.status().state, "unavailable");

      // Directly invoke squad-run on the latched cell: attemptRecovery closes the initial SQLite
      // handles in place and rebinds the replacement core before SquadCoordinator starts.
      const started = await cell.run(
        {
          kind: "squad-run",
          squadId: "squad",
          taskId,
          runtimeInstanceId: "stub",
          cwd: { scope: "repo-root" },
        },
        binding,
      );
      assert.equal(cell.status().state, "attached");
      assert.notEqual(cell.replica, originalReplica, "in-place recovery replaced the initial ledger core");
      assert.equal(started.outcome, "completed", JSON.stringify(started));
      const squadRunId = String((started as { readonly squadRunId?: string }).squadRunId);
      assert.match(squadRunId, /^squad_[a-f0-9]{24}$/u);

      // Settle the pre-latch scheduled Squad occurrence through the replacement entityActionExecutor.
      await finishProvider(
        scheduledDispatchId,
        JSON.stringify({
          schema: "squad-decision/v1",
          action: "converged",
          report: "# Scheduled Squad\nSettled after recovery.",
        }),
      );
      const settledSchedule = await until(async () => {
        const shown = (await cell!.run({ kind: "schedule-show", scheduleId }, binding)) as unknown as {
          readonly schedule?: {
            readonly status: {
              readonly activeRun: unknown;
              readonly lastRun?: { readonly outcome: string } | null;
            };
          };
        };
        return shown.schedule?.status.activeRun === null ? shown.schedule.status : null;
      }, "scheduled squad occurrence settlement");
      assert.equal(settledSchedule.lastRun?.outcome, "succeeded");

      // Drive the post-recovery task Squad run through worker fan-out, ownership check, and convergence.
      type SquadStatusView = {
        readonly status: string;
        readonly error: string | null;
        readonly leaderTurns: readonly { readonly dispatchId: string }[];
        readonly workerAttempts: readonly { readonly dispatchId: string | null; readonly taskId: string | null }[];
      };
      const readSquadStatus = async (): Promise<SquadStatusView> => {
        const receipt = await cell!.run({ kind: "squad-status", squadRunId }, binding);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        return JSON.parse(String(receipt.evidence)) as SquadStatusView;
      };

      const initialStatus = await readSquadStatus();
      assert.equal(initialStatus.leaderTurns.length, 1);
      await finishProvider(
        initialStatus.leaderTurns[0]!.dispatchId,
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            {
              to: "one",
              prompt: realizedTaskPlan("Worker mission on replacement handles"),
              ownedPaths: ["recovered.txt"],
            },
          ],
        }),
      );

      const fannedOut = await until(async () => {
        const current = await readSquadStatus();
        if (current.status === "failed") throw new Error(JSON.stringify(current));
        return current.workerAttempts[0]?.dispatchId ? current : null;
      }, "squad worker fan-out after recovery");
      await finishProvider(fannedOut.workerAttempts[0]!.dispatchId!, "Worker completed on replacement handles.");

      const callbackTurn = await until(async () => {
        const current = await readSquadStatus();
        if (current.status === "failed") throw new Error(JSON.stringify(current));
        return current.leaderTurns.length === 2 ? current : null;
      }, "squad leader callback after recovery");
      await finishProvider(
        callbackTurn.leaderTurns[1]!.dispatchId,
        JSON.stringify({
          schema: "squad-decision/v1",
          action: "converged",
          report: "# Recovered Squad Synthesis\nAll handles routed to live core.",
        }),
      );

      const converged = await until(async () => {
        const current = await readSquadStatus();
        if (current.status === "failed") throw new Error(JSON.stringify(current));
        return current.status === "converged" ? current : null;
      }, "squad convergence after recovery");
      assert.equal(converged.error, null);

      const canonicalRun = await cell.read("repo.squad.run.read", { squadRunId }, binding);
      assert.equal(canonicalRun.run.phase, "converged");
      t.diagnostic(JSON.stringify({ squadRunId, settledSchedule, phase: canonicalRun.run.phase }));
    } finally {
      await Promise.all(providers.map((provider) => stopStubProcess(provider.process)));
      await cell?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Latch Recovery Test");
  git(rootDir, "config", "user.email", "latch-recovery@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}

function runtimePublicationContext(input: {
  readonly repoId: string;
  readonly causeClass: "infrastructure" | "projection";
  readonly recoveryCalls: { count: number };
  readonly cut: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number };
  readonly revision: number;
  readonly recoveryUncertain?: boolean;
}): RepoCellApiContext {
  const activeWriter = { workspaceId: input.repoId, generation: 1, ownerId: "latch-rescue-test" };
  return {
    mode: "local",
    state: "unavailable",
    recoveryUncertain: input.recoveryUncertain ?? false,
    causeClass: input.causeClass,
    queueDepth: 0,
    tail: Promise.resolve(),
    writeQueue: { waiting: [], nowMs: () => 0 },
    activeWriter,
    writerToken: bindWriterGenerationToken(activeWriter),
    activeWriterEpochFence: null,
    activeWriterEpochFenceDescriptor: null,
    input: { repoId: input.repoId },
    projection: { readCut: () => input.cut },
    store: { readHead: () => ({ revision: input.revision }) },
    replica: { kick: () => undefined },
    now: () => "2026-10-21T00:00:00.000Z",
    operationId: () => "runtime-rescue-operation",
    attemptRecovery: async () => {
      input.recoveryCalls.count += 1;
    },
    cellCodedError,
    latched: () => "fixture is latched",
  } as unknown as RepoCellApiContext;
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
