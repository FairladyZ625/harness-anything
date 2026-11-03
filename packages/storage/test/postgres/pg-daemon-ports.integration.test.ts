// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { taskLifecycleWritePlan, type CanonicalEventStore } from "@harness-anything/kernel";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { openPersistentWriterEpoch } from "../../src/writer-epoch.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";
import { execFileSync } from "node:child_process";
import { openReplicationSlots } from "../../src/fleet-replication-slot.ts";
import { openFleetStorage } from "../../src/storage-daemon-composition.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import type { TaskCreatedEvent } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { assertContentBlobRangeContract } from "../content-blob-range.assertions.ts";

test("daemon PG storage factories expose canonical lifecycle ports without local SQLite", async (t) => {
  const fixture = await pgRuntimeFixture(),
    rootDir = join(fixture.root, "workspace"),
    repoId = "pg-daemon-ports",
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      scope: { tenantId: "tenant", projectId: "project", readers: ["person-fixture"], policyEpoch: 1 },
    };
  let store: CanonicalEventStore | undefined, projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    store = makeTaskEventStore({ rootDir, repoId, storage });
    projection = makeTaskProjection({ rootDir, storage, eventStore: store });
    await t.test("canonical PostgreSQL store exposes bounded content blob reads", async (contentTest) => {
      const body = Buffer.from("canonical PG store range reads stay bounded"),
        sha256 = sha256Bytes(body);
      await withPostgresTransaction(
        fixture.pool,
        (client) =>
          client.query(
            "INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              storage.scope.tenantId,
              storage.scope.projectId,
              sha256,
              body.byteLength,
              body,
              storage.scope.readers,
              storage.scope.policyEpoch,
            ],
          ),
        storage.scope,
      );
      await assertContentBlobRangeContract(contentTest, store!, sha256, body);
    });
    const events = lifecycleFixture({ taskId: "task-pg-daemon", executionId: "execution-pg-daemon" }).events;
    for (const event of events) {
      store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      projection.apply(event, taskLifecycleWritePlan(event));
    }
    const snapshot = projection.read("task-pg-daemon").snapshot;
    assert.equal(snapshot.task?.status, "done");
    const reader = makeTaskProjectionReader({ repoId, storage });
    try {
      assert.deepEqual(
        reader.withSession((queries) => queries.read("task-pg-daemon").snapshot),
        snapshot,
      );
    } finally {
      reader.close();
    }
    await t.test("cold rebuild retains the canonical lifecycle", () => {
      projection!.rebuild();
      assert.deepEqual(projection!.read("task-pg-daemon").snapshot, snapshot);
    });
    const createdAt = (taskId: string, revision: number): TaskCreatedEvent => {
      const base = events[0] as TaskCreatedEvent;
      return {
        ...base,
        taskId,
        workspaceRevision: revision,
        opId: `op-${taskId}`,
        eventId: `event-${taskId}`,
        payload: { ...base.payload, task: { ...base.payload.task, taskId } },
      };
    };
    await t.test(
      "failed PG tree publication retries its durable cut without another append",
      { timeout: 5_000 },
      async () => {
        const retryRoot = join(fixture.root, "tree-follower-retry"),
          marker = join(retryRoot, ".harness", "fleet-materialized.json"),
          retryRepoId = "pg-tree-follower-retry";
        mkdirSync(join(retryRoot, ".harness"), { recursive: true });
        writeFileSync(marker, "{\n");
        let reportFailure!: () => void, reportRecovery!: () => void;
        const failureReported = new Promise<void>((resolve) => {
            reportFailure = resolve;
          }),
          recoveryReported = new Promise<void>((resolve) => {
            reportRecovery = resolve;
          }),
          retryStore = makeTaskEventStore({
            rootDir: retryRoot,
            repoId: retryRepoId,
            storage: {
              ...storage,
              scope: { ...storage.scope, tenantId: "tenant-tree-retry", projectId: "project-tree-retry" },
            },
            onMaterializationHealthChange: (health) => {
              if (health.state === "failed") reportFailure();
              else if (health.state === "ok") reportRecovery();
            },
          }),
          event = createdAt("task-pg-tree-follower-retry", 1);
        try {
          const receipt = retryStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
          assert.equal(receipt.status, "applied");
          await failureReported;
          unlinkSync(marker);
          await recoveryReported;
          assert.equal(retryStore.readHead()?.revision, 1);
          assert.equal(retryStore.materializationHealth().state, "ok");
          assert.equal(JSON.parse(readFileSync(marker, "utf8")).revision, 1);
        } finally {
          await retryStore.drain();
        }
      },
    );
    await t.test("two node transactions compete for the same canonical revision", async () => {
      const backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope: storage.scope }),
        before = store!.readHead()!.revision,
        fence = { repoId, holderId: "direct-store", epoch: 1 },
        results = await Promise.allSettled(
          ["node-one", "node-two"].map((node) => {
            const event = createdAt(`task-${node}`, before + 1);
            return backend.eventStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }, before, fence);
          }),
        );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason.code, "revision_conflict");
      const stream = store!.read();
      assert.equal(stream.revision, before + 1);
      assert.equal(stream.events.length, stream.revision);
      let cursor: string | null = null,
        done = false,
        count = 0;
      for (let pages = 0; pages < stream.revision + 1 && !done; pages++) {
        const page = store!.readBatch(cursor, 2);
        count += page.events.length;
        cursor = page.cursor;
        done = page.done;
      }
      assert.equal(done, true);
      assert.equal(count, stream.revision);
      assert.notEqual(cursor, null, "a nonempty tail cursor still terminates on done");
      console.log("PG_TWO_NODE_COMPETITION accepted=1 rejected=1 code=revision_conflict");
    });
    const paths = readdirSync(fixture.root, { recursive: true }).map(String);
    assert.deepEqual(
      paths.filter((name) => /\.sqlite(?:$|-)/u.test(name)),
      [],
    );
    console.log("PG_DAEMON_PORTS lifecycle=done SQLiteFiles=0");
    await t.test("durable node slots use PG and preserve ACK fencing", () => {
      const slots = openReplicationSlots(join(fixture.root, "slots.sqlite"), { [repoId]: storage }),
        source = openFleetStorage({ rootDir, repoId, storage });
      try {
        const position = source.replicationPosition(),
          prior = slots.claim({ repoId, nodeId: "node-one" }, position.history),
          lease = slots.claim({ repoId, nodeId: "node-one" }, position.history);
        assert.equal(slots.current(prior), false);
        slots.acknowledge(lease, { durable: position, applied: position }, position);
        assert.equal(slots.minimumAck(repoId, position.history), position.sequence);
        assert.throws(
          () => slots.acknowledge(prior, { durable: position, applied: position }, position),
          /replication session fenced/u,
        );
        assert.throws(
          () =>
            slots.acknowledge(
              lease,
              { durable: { ...position, sequence: position.sequence + 1 }, applied: position },
              position,
            ),
          /ACK exceeds/u,
        );
        slots.removeNode("node-one");
        assert.deepEqual(slots.list(), []);
        assert.equal(existsSync(join(fixture.root, "slots.sqlite")), false);
      } finally {
        source.close();
        slots.close();
      }
    });
    await t.test("slot and epoch runtime connections reject schema-owner credentials", () => {
      const unsafe = {
          ...storage,
          connectionString: fixture.managementConnectionString,
          authorityConnectionString: fixture.managementConnectionString,
        },
        slots = openReplicationSlots(join(fixture.root, "unsafe-slots.sqlite"), { [repoId]: unsafe }),
        authority = openPersistentWriterEpoch({ stateRoot: join(fixture.root, "unsafe-epochs"), storage: unsafe });
      try {
        const denied = (error: Error & { code?: string }) => error.code === "pg_runtime_role_unsafe";
        assert.throws(() => slots.claim({ repoId, nodeId: "unsafe" }, "history"), denied);
        assert.throws(() => authority.current(repoId), denied);
      } finally {
        slots.close();
        authority.close();
      }
    });
    await t.test("Git following is optional and shares the existing VCS publication port", async () => {
      assert.equal(store!.currentCommit(), null);
      initRepo(rootDir);
      const branch = execFileSync("git", ["-C", rootDir, "symbolic-ref", "--short", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        follower = makeTaskEventStore({ rootDir, repoId, storage: { ...storage, gitFollower: { branch } } });
      try {
        await follower.settlePendingMaterialization!("test Git follower");
        assert.match(follower.currentCommit()!.sha, /^[0-9a-f]{40}$/u);
        assert.equal(follower.followerStatus().git.status, "verified");
        assert.deepEqual(follower.currentCut(), store!.currentCut());
        assert.equal(
          execFileSync("git", ["-C", rootDir, "diff", "--name-only", "HEAD", "--", "harness"], {
            encoding: "utf8",
          }).trim(),
          "",
        );
      } finally {
        await follower.drain();
      }
    });
    await t.test(
      "failed PG Git publication retries its durable cut without another append",
      { timeout: 5_000 },
      async () => {
        const retryRoot = join(fixture.root, "follower-retry"),
          retryRepoId = "pg-follower-retry";
        mkdirSync(retryRoot, { recursive: true });
        initRepo(retryRoot);
        const branch = execFileSync("git", ["-C", retryRoot, "symbolic-ref", "--short", "HEAD"], {
          encoding: "utf8",
        }).trim();
        let rejectFirstPublication = true,
          reportFailure!: () => void,
          reportRecovery!: () => void;
        const failureReported = new Promise<void>((resolve) => {
            reportFailure = resolve;
          }),
          recoveryReported = new Promise<void>((resolve) => {
            reportRecovery = resolve;
          }),
          retryStore = makeTaskEventStore({
            rootDir: retryRoot,
            repoId: retryRepoId,
            storage: {
              ...storage,
              scope: { ...storage.scope, tenantId: "tenant-follower-retry", projectId: "project-follower-retry" },
              gitFollower: { branch },
            },
            killpoint: (point) => {
              if (rejectFirstPublication && point === "after_git_commit") {
                rejectFirstPublication = false;
                throw new Error("injected first PG Git publication failure");
              }
            },
            onMaterializationHealthChange: (health) => {
              if (health.state === "failed") reportFailure();
              else if (health.state === "ok") reportRecovery();
            },
          }),
          event = createdAt("task-pg-follower-retry", 1);
        try {
          const receipt = retryStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
          assert.equal(receipt.status, "applied", "post-commit follower failure must not replace PG acceptance");
          await failureReported;
          assert.equal(retryStore.readHead()?.revision, 1);
          assert.equal(retryStore.materializationHealth().state, "failed");
          assert.equal(retryStore.materializationHealth().pendingWalEvents, 1);

          await recoveryReported;
          assert.equal(retryStore.followerStatus().git.status, "verified");
          assert.equal(retryStore.followerStatus().git.cut?.revision, 1);
          assert.equal(retryStore.followerStatus().worktree.status, "verified");
          assert.equal(retryStore.followerStatus().worktree.cut?.revision, 1);
          assert.equal(retryStore.materializationHealth().state, "ok");
          assert.equal(retryStore.materializationHealth().pendingWalEvents, 0);
          assert.equal(
            JSON.parse(
              execFileSync("git", ["-C", retryRoot, "show", `${branch}:harness/events/segments/manifest.json`], {
                encoding: "utf8",
              }),
            ).cut.revision,
            1,
          );
        } finally {
          await retryStore.drain();
        }
      },
    );
    await t.test("Git following can advance its cut while authored tree materialization is disabled", async () => {
      const branch = execFileSync("git", ["-C", rootDir, "symbolic-ref", "--short", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        manifest = join(rootDir, "harness/events/segments/manifest.json"),
        before = readFileSync(manifest, "utf8"),
        follower = makeTaskEventStore({
          rootDir,
          repoId,
          storage: { ...storage, materialize: false, gitFollower: { branch } },
        });
      try {
        const event = createdAt("task-object-follower", store!.readHead()!.revision + 1);
        follower.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
        await follower.settlePendingMaterialization!("object-only Git follower");
        assert.match(follower.currentCommit()!.sha, /^[0-9a-f]{40}$/u);
        assert.equal(follower.followerStatus().git.status, "verified");
        assert.equal(follower.followerStatus().worktree.status, "pending");
        assert.equal(follower.materializationHealth().pendingWalEvents, 0);
        assert.equal(readFileSync(manifest, "utf8"), before);
        assert.throws(() => follower.materialize({ paths: ["harness.yaml"] }), /disabled/u);
      } finally {
        await follower.drain();
      }
    });
    await t.test("restart allocates a newer PG epoch and fences the former center", () => {
      const configuration = { ...storage, authorityConnectionString: fixture.managementConnectionString },
        first = openPersistentWriterEpoch({
          stateRoot: join(fixture.root, "epochs"),
          holderId: "center-one",
          storage: configuration,
        }),
        second = openPersistentWriterEpoch({
          stateRoot: join(fixture.root, "epochs"),
          holderId: "center-two",
          storage: configuration,
        });
      try {
        const old = first.acquire(repoId),
          next = second.acquire(repoId);
        assert.ok(next.epoch > old.epoch);
        assert.throws(
          () => first.assert(repoId, old.epoch),
          (error: Error & { code?: string }) => error.code === "writer_epoch_stale",
        );
        second.assert(repoId, next.epoch);
        assert.equal(existsSync(join(fixture.root, "epochs", "writer-epochs", `${repoId}.sqlite`)), false);
      } finally {
        first.close();
        second.close();
      }
    });
  } finally {
    projection?.close();
    await store?.drain();
    await fixture.pool.end();
    await fixture.close();
  }
});
