// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
  openPersistentWriterEpoch,
  withWriterEpochFenceDescriptor,
  type WriterEpochFenceDescriptor,
} from "@harness-anything/storage";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { openPgCloudWriterRepository } from "../src/writer-cell/cloud-writer-pg-repository.ts";
import {
  createCloudWriterShard,
  type CloudOutboxRecord,
  type CloudWriterRepository,
} from "../src/writer-cell/cloud-writer-shard.ts";
import { initRepo } from "./migration-import.fixtures.ts";
import { allowOwner, cloudRequest, seedCloudTask } from "./fixtures/cloud-writer-shard.fixture.ts";

const repoId = "cloud-writer";
const source = { kind: "node", nodeId: "cloud-writer-a" } as const;
type Backend = "sqlite" | "pglite";

async function withCloudRepository(
  backend: Backend,
  run: (input: {
    readonly repository: (fence: WriterEpochFenceDescriptor) => CloudWriterRepository;
    readonly acquire: (holderId: string) => WriterEpochFenceDescriptor;
    readonly head: () => number;
    readonly taskIds: readonly [string, string];
  }) => Promise<void>,
): Promise<void> {
  await withTempStoreAsync(async (root) => {
    const rootDir = path.join(root, "seed"),
      stateRoot = path.join(root, "state");
    initRepo(rootDir);
    mkdirSync(stateRoot, { recursive: true });
    const storage =
        backend === "pglite"
          ? ({
              backend: "pglite",
              dataDir: path.join(root, "database"),
              materialize: false,
              scope: { tenantId: "tenant", projectId: "cloud", readers: [], policyEpoch: 0 },
            } as const)
          : undefined,
      store = makeTaskEventStore({ repoId, rootDir, ...(storage ? { storage } : {}) }),
      taskIds = ["task_cloud_one", "task_cloud_two"] as const;
    seedCloudTask(store, rootDir, taskIds[0], "Cloud task");
    // Work owners append progress without a lease, so the cloud progress route needs no edge-held execution.
    seedCloudTask(store, rootDir, taskIds[1], "Cloud work", "work");
    const projection = storage
      ? makeTaskProjection({ rootDir, storage, eventStore: store })
      : makeTaskProjection({ rootDir, eventStore: store });
    projection.rebuild();
    const authorities: { close: () => void }[] = [];
    try {
      await run({
        repository: (fence) => ({
          store,
          projection,
          withAppendFence: (operation) => withWriterEpochFenceDescriptor(fence, operation),
        }),
        acquire: (holderId) => {
          const authority = openPersistentWriterEpoch({ stateRoot, holderId });
          authorities.push(authority);
          const lease = authority.acquire(repoId);
          return {
            schema: "harness-writer-epoch-fence/v1",
            stateRoot,
            repoId,
            epoch: lease.epoch,
            holderId: lease.holderId,
          };
        },
        head: () => store.readHead()?.revision ?? 0,
        taskIds,
      });
    } finally {
      for (const authority of authorities) authority.close();
      projection.close();
      await store.drain();
    }
  });
}

function amend(taskId: string, title: string) {
  return { kind: "task-amend", taskId, patches: [{ field: "title", value: title }] };
}

function shardSuite(backend: Backend): void {
  test(`${backend}: an idempotency key replays the accepted receipt without appending again`, async () => {
    await withCloudRepository(backend, async ({ repository, acquire, head, taskIds }) => {
      const published: CloudOutboxRecord[] = [];
      const shard = createCloudWriterShard({
        repositories: new Map([[repoId, repository(acquire("shard-a"))]]),
        authorizer: allowOwner,
        source,
        maxInFlight: 4,
        publish: async (record) => {
          published.push(record);
        },
      });
      const before = head();
      const first = await shard.handle(
        cloudRequest(repoId, amend(taskIds[0], "Cloud renamed"), { idempotencyKey: "k-1" }),
      );
      assert.equal(first.status, 200, await first.clone().text());
      const accepted = (await first.json()) as { receipt: { opId: string; revision: number }; replayed: boolean };
      assert.equal(accepted.replayed, false);
      assert.equal(head(), before + 1);
      assert.deepEqual(published, [], "the outbox publishes after the response, outside the write turn");

      const retry = await shard.handle(
        cloudRequest(repoId, amend(taskIds[0], "Cloud renamed"), { idempotencyKey: "k-1" }),
      );
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get("idempotent-replay"), "true");
      const replayed = (await retry.json()) as typeof accepted;
      assert.deepEqual(replayed.receipt, accepted.receipt);
      assert.equal(replayed.replayed, true);
      assert.equal(head(), before + 1, "a replay appends no event");

      const reused = await shard.handle(cloudRequest(repoId, amend(taskIds[1], "Other"), { idempotencyKey: "k-1" }));
      assert.equal(reused.status, 409);
      assert.deepEqual(await reused.json(), { error: { code: "idempotency_key_reused" } });
      assert.equal(head(), before + 1);

      await shard.drain();
      assert.deepEqual(
        published.map(({ repoId: repository, opId, revision }) => ({ repository, opId, revision })),
        [{ repository: repoId, opId: accepted.receipt.opId, revision: accepted.receipt.revision }],
      );
    });
  });

  test(`${backend}: a stale shard is refused once a successor raises the writer epoch`, async () => {
    await withCloudRepository(backend, async ({ repository, acquire, head, taskIds }) => {
      const stale = createCloudWriterShard({
        repositories: new Map([[repoId, repository(acquire("shard-a"))]]),
        authorizer: allowOwner,
        source,
        maxInFlight: 4,
      });
      const accepted = await stale.handle(
        cloudRequest(repoId, amend(taskIds[0], "Before takeover"), { idempotencyKey: "a-1" }),
      );
      assert.equal(accepted.status, 200, await accepted.clone().text());
      const successor = createCloudWriterShard({
        repositories: new Map([[repoId, repository(acquire("shard-b"))]]),
        authorizer: allowOwner,
        source: { kind: "node", nodeId: "cloud-writer-b" },
        maxInFlight: 4,
      });
      const before = head();
      const late = await stale.handle(cloudRequest(repoId, amend(taskIds[1], "Late write"), { idempotencyKey: "a-2" }));
      assert.equal(late.status, 409);
      assert.deepEqual(await late.json(), { error: { code: "writer_epoch_stale" } });
      assert.equal(head(), before, "the stale writer appended nothing");
      const fenced = await stale.handle(cloudRequest(repoId, amend(taskIds[1], "Retry"), { idempotencyKey: "a-3" }));
      assert.equal(fenced.status, 409, "a fenced shard keeps refusing without touching the ledger");
      const owned = await successor.handle(
        cloudRequest(repoId, amend(taskIds[1], "Successor write"), { idempotencyKey: "b-1" }),
      );
      assert.equal(owned.status, 200, await owned.clone().text());
      assert.equal(head(), before + 1);
    });
  });

  test(`${backend}: progress append, overload shedding and outbox failure isolation`, async () => {
    await withCloudRepository(backend, async ({ repository, acquire, head, taskIds }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        errors: unknown[] = [];
      const shard = createCloudWriterShard({
        repositories: new Map([[repoId, repository(acquire("shard-a"))]]),
        authorizer: {
          authorizeRepositoryWrite: async (input) => {
            if (input.token === "token-slow") await gate;
            return allowOwner.authorizeRepositoryWrite();
          },
        },
        source,
        maxInFlight: 1,
        publish: async () => {
          throw Object.assign(new Error("outbox offline"), { code: "outbox_unavailable" });
        },
        onError: (error) => errors.push(error),
      });
      const slow = shard.handle(
        cloudRequest(repoId, amend(taskIds[0], "Slow"), { idempotencyKey: "slow-1", token: "token-slow" }),
      );
      const shed = await shard.handle(cloudRequest(repoId, amend(taskIds[1], "Shed"), { idempotencyKey: "shed-1" }));
      assert.equal(shed.status, 429);
      assert.equal(shed.headers.get("retry-after"), "1");
      release();
      assert.equal((await slow).status, 200);

      const before = head();
      const progress = await shard.handle(
        cloudRequest(
          repoId,
          {
            kind: "task-progress-append",
            taskId: taskIds[1],
            text: "Cloud progress",
          },
          { idempotencyKey: "progress-1" },
        ),
      );
      assert.equal(
        progress.status,
        200,
        `${await progress.clone().text()} ${errors.map((error) => (error instanceof Error ? error.stack : String(error))).join("\n")}`,
      );
      const body = (await progress.json()) as { receipt: { eventType: string; taskId: string } };
      assert.equal(body.receipt.taskId, taskIds[1]);
      assert.equal(head(), before + 1);
      await shard.drain();
      assert.equal(errors.length, 2, "outbox failures are reported, never turned into write failures");

      const missing = await shard.handle(cloudRequest(repoId, amend(taskIds[0], "x")));
      assert.equal(missing.status, 400);
      const unsupported = await shard.handle(
        cloudRequest(repoId, { kind: "task-supersede", taskId: taskIds[0] }, { idempotencyKey: "u-1" }),
      );
      assert.equal(unsupported.status, 400);
    });
  });
}

shardSuite("sqlite");
pgliteIntegrationSuite("cloud writer shard on PGlite", () => shardSuite("pglite"));

test("postgres: openPgCloudWriterRepository enforces PG writer-epoch preemption, idempotency, progress and outbox without SQLite", async () => {
  const fixture = await pgRuntimeFixture();
  const seedDir = path.join(fixture.root, "seed");
  const stateRoot = path.join(fixture.root, "state");
  initRepo(seedDir);
  mkdirSync(stateRoot, { recursive: true });
  const storage = {
    backend: "postgres" as const,
    connectionString: fixture.connectionString,
    authorityConnectionString: fixture.managementConnectionString,
    scope: { tenantId: "tenant", projectId: "cloud-writer-pg", readers: [], policyEpoch: 1 },
  };
  let repoA: ReturnType<typeof openPgCloudWriterRepository> | undefined;
  let repoB: ReturnType<typeof openPgCloudWriterRepository> | undefined;
  try {
    repoA = openPgCloudWriterRepository({ repoId, storage, stateRoot, holderId: "pg-shard-a" });
    const taskIds = ["task_pg_one", "task_pg_two"] as const;
    repoA.withAppendFence(() => {
      seedCloudTask(repoA!.store, seedDir, taskIds[0], "PG cloud task");
      seedCloudTask(repoA!.store, seedDir, taskIds[1], "PG cloud work", "work");
    });
    repoA.projection.catchUp?.();

    const published: CloudOutboxRecord[] = [];
    const shardA = createCloudWriterShard({
      repositories: new Map([[repoId, repoA]]),
      authorizer: allowOwner,
      source,
      maxInFlight: 2,
      publish: async (record) => {
        published.push(record);
      },
    });

    const before = repoA.store.readHead()?.revision ?? 0;
    const first = await shardA.handle(
      cloudRequest(repoId, amend(taskIds[0], "PG renamed"), { idempotencyKey: "pg-k1" }),
    );
    assert.equal(first.status, 200, await first.clone().text());
    const accepted = (await first.json()) as { receipt: { opId: string; revision: number }; replayed: boolean };
    assert.equal(accepted.replayed, false);
    assert.equal(repoA.store.readHead()?.revision ?? 0, before + 1);
    assert.deepEqual(published, []);

    const replay = await shardA.handle(
      cloudRequest(repoId, amend(taskIds[0], "PG renamed"), { idempotencyKey: "pg-k1" }),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.deepEqual(((await replay.json()) as typeof accepted).receipt, accepted.receipt);
    assert.equal(repoA.store.readHead()?.revision ?? 0, before + 1);

    const conflict = await shardA.handle(cloudRequest(repoId, amend(taskIds[1], "Other"), { idempotencyKey: "pg-k1" }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: { code: "idempotency_key_reused" } });

    const progress = await shardA.handle(
      cloudRequest(
        repoId,
        { kind: "task-progress-append", taskId: taskIds[1], text: "PG progress" },
        { idempotencyKey: "pg-p1" },
      ),
    );
    assert.equal(progress.status, 200, await progress.clone().text());
    assert.equal(repoA.store.readHead()?.revision ?? 0, before + 2);

    await shardA.drain();
    assert.equal(published.length, 2);

    // A successor shard opens the same repository on PostgreSQL and raises the writer epoch.
    repoB = openPgCloudWriterRepository({ repoId, storage, stateRoot, holderId: "pg-shard-b" });
    assert.ok(repoB.fence.epoch > repoA.fence.epoch, "successor must hold a strictly higher PG writer epoch");
    const shardB = createCloudWriterShard({
      repositories: new Map([[repoId, repoB]]),
      authorizer: allowOwner,
      source: { kind: "node", nodeId: "cloud-writer-b" },
      maxInFlight: 2,
    });

    const headBeforePreempt = repoB.store.readHead()?.revision ?? 0;
    const staleWrite = await shardA.handle(
      cloudRequest(repoId, amend(taskIds[0], "Stale PG write"), { idempotencyKey: "pg-stale-1" }),
    );
    assert.equal(staleWrite.status, 409);
    assert.deepEqual(await staleWrite.json(), { error: { code: "writer_epoch_stale" } });
    assert.equal(repoB.store.readHead()?.revision ?? 0, headBeforePreempt);

    const fencedWrite = await shardA.handle(
      cloudRequest(repoId, amend(taskIds[0], "Fenced PG retry"), { idempotencyKey: "pg-stale-2" }),
    );
    assert.equal(fencedWrite.status, 409);
    assert.deepEqual(await fencedWrite.json(), { error: { code: "writer_epoch_stale" } });

    const successorWrite = await shardB.handle(
      cloudRequest(repoId, amend(taskIds[0], "Successor PG write"), { idempotencyKey: "pg-b-1" }),
    );
    assert.equal(successorWrite.status, 200, await successorWrite.clone().text());
    assert.equal(repoB.store.readHead()?.revision ?? 0, headBeforePreempt + 1);

    assert.deepEqual(
      readdirSync(stateRoot, { recursive: true })
        .map(String)
        .filter((name) => /\.sqlite(?:$|-)/u.test(name)),
      [],
      "PG cloud writer shard must not create SQLite epoch or ledger files",
    );
  } finally {
    await repoA?.close();
    await repoB?.close();
    await fixture.pool.end();
    await fixture.close();
  }
});
