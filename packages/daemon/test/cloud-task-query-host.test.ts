// harness-test-tier: contract
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createCloudQueryHost } from "../src/fleet-sync/cloud-query-host.ts";
import type { PgTaskQueryReader } from "../../storage/src/pg/pg-task-query-reader.ts";

test("task claimable fails closed when task-start authority is absent", async () => {
  const host = createCloudQueryHost({
    pool: {} as never,
    authorizer: {
      authorizeRepositoryRead: async () => ({ outcome: "allowed", personId: "person_owner" }),
    },
    repositories: new Map([["repo", { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 }]]),
    maxInFlight: 2,
  });
  try {
    const response = await host(
      new Request("http://cloud.local/v1/repositories/repo/task-claimable", {
        headers: { authorization: "Bearer token" },
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: "claim_authorization_unavailable" } });
  } finally {
    await host.close();
  }
});

test(
  "syncRoutes and readerRoutes do not block the main event loop and honor timeout/abort",
  { timeout: 20_000 },
  async () => {
    const sockets = new Set<net.Socket>();
    let accepted = 0;
    let resolveFirstConnection!: () => void;
    const firstConnection = new Promise<void>((resolve) => {
      resolveFirstConnection = resolve;
    });
    const server = net.createServer((socket) => {
      accepted++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      resolveFirstConnection();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const connectionString = `postgres://user:pass@127.0.0.1:${address.port}/cloud`;

    const repositories = new Map([["repo", { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 }]]);
    const authorizer = {
      authorizeRepositoryRead: async () => ({ outcome: "allowed" as const, personId: "person_owner" }),
    };

    const host = createCloudQueryHost({
      pool: { options: { connectionString } } as never,
      authorizer,
      repositories,
      maxInFlight: 4,
      timeoutMs: 15_000,
    });
    const shortTimeoutHost = createCloudQueryHost({
      pool: { options: { connectionString } } as never,
      authorizer,
      repositories,
      maxInFlight: 4,
      timeoutMs: 250,
    });

    try {
      // 1. Slow task-list (syncRoute) blocked on a stalled PG TCP socket must not freeze main-thread
      //    TCP accept, timers, concurrent requests, or AbortController cancellation.
      const controller = new AbortController();
      let taskListSettled = false;
      const slowTaskList = host(
        new Request("http://cloud.local/v1/repositories/repo/task-list", {
          headers: { authorization: "Bearer token" },
          signal: controller.signal,
        }),
      ).then((res) => {
        taskListSettled = true;
        return res;
      });

      await firstConnection;
      assert.ok(accepted >= 1, "main-thread TCP server must accept worker connection while query is in flight");

      let timerFiredWhileInFlight = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          timerFiredWhileInFlight = !taskListSettled;
          resolve();
        }, 15),
      );
      assert.equal(timerFiredWhileInFlight, true, "main-thread setTimeout must fire while syncRoute is blocked");

      const concurrent = await host(
        new Request("http://cloud.local/v1/repositories/repo/task-claimable", {
          headers: { authorization: "Bearer token" },
        }),
      );
      assert.equal(concurrent.status, 503);
      assert.equal(taskListSettled, false, "concurrent request must finish while slow task-list is still blocked");

      controller.abort();
      const cancelled = await slowTaskList;
      assert.equal(cancelled.status, 499);
      assert.deepEqual(await cancelled.json(), { error: { code: "request_cancelled" } });

      // 2. AbortSignal.timeout(timeoutMs) on doc-list (readerRoute) must fire promptly and return 504.
      let docListSettled = false;
      const slowDocList = shortTimeoutHost(
        new Request("http://cloud.local/v1/repositories/repo/doc-list", {
          headers: { authorization: "Bearer token" },
        }),
      ).then((res) => {
        docListSettled = true;
        return res;
      });
      let docTimerFired = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          docTimerFired = !docListSettled;
          resolve();
        }, 15),
      );
      assert.equal(docTimerFired, true, "main-thread setTimeout must fire while readerRoute is in flight");
      const timedOut = await slowDocList;
      assert.equal(timedOut.status, 504);
      assert.deepEqual(await timedOut.json(), { error: { code: "query_timeout" } });
    } finally {
      await host.close();
      await shortTimeoutHost.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("cloud query host evicts poisoned/closed readers, enforces LRU maxReaders, and closes cleanly", async () => {
  interface FakeReaderRecord {
    readonly repoId: string;
    closed: boolean;
    closeCalls: number;
    readonly reader: PgTaskQueryReader;
  }
  const opened: FakeReaderRecord[] = [];
  let failFirstRepoA = true;

  const makeFakeReader = (repoId: string): FakeReaderRecord => {
    const record: FakeReaderRecord = {
      repoId,
      closed: false,
      closeCalls: 0,
      reader: null as unknown as PgTaskQueryReader,
    };
    const queries = {
      readTaskIndex: () => {
        if (repoId === "repo-a" && failFirstRepoA) {
          failFirstRepoA = false;
          record.closed = true;
          throw Object.assign(new Error("PostgreSQL task query worker timed out"), {
            code: "pg_query_worker_timeout",
          });
        }
        return { status: "ready" as const, rows: [], warnings: [], watermark: 1, sourceRevision: 1 };
      },
      readTaskChildCounts: () => ({}),
      getEntity: () => null,
    };
    const reader = {
      path: `memory:${repoId}`,
      isClosed: () => record.closed,
      close: () => {
        record.closed = true;
        record.closeCalls++;
      },
      withSession: <A>(read: (q: never) => A): A => {
        if (record.closed) throw new Error("PostgreSQL task query reader is closed");
        return read(queries as never);
      },
    } as unknown as PgTaskQueryReader;
    (record as { reader: PgTaskQueryReader }).reader = reader;
    opened.push(record);
    return record;
  };

  const scope = { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 };
  const host = createCloudQueryHost({
    pool: {} as never,
    authorizer: {
      authorizeRepositoryRead: async () => ({ outcome: "allowed", personId: "person_owner" }),
    },
    repositories: new Map([
      ["repo-a", scope],
      ["repo-b", scope],
      ["repo-c", scope],
    ]),
    openQueryReader: ({ repoId }) => makeFakeReader(repoId).reader,
    maxInFlight: 4,
    maxReaders: 2,
  });

  const getList = (repoId: string) =>
    host(
      new Request(`http://cloud.local/v1/repositories/${repoId}/task-list`, {
        headers: { authorization: "Bearer token" },
      }),
    );

  // 1. First request poisons reader #1 via timeout -> must be evicted automatically.
  const firstRes = await getList("repo-a");
  assert.equal(firstRes.status, 504);
  assert.deepEqual(await firstRes.json(), { error: { code: "query_timeout" } });
  assert.equal(opened.length, 1);

  // 2. Second request for repo-a must open a fresh reader #2 and succeed with 200.
  const secondRes = await getList("repo-a");
  assert.equal(secondRes.status, 200);
  assert.equal(opened.length, 2);

  // 3. Externally marking reader #2 closed must trigger eviction before reuse -> reader #3 opens.
  opened[1]!.closed = true;
  const thirdRes = await getList("repo-a");
  assert.equal(thirdRes.status, 200);
  assert.equal(opened.length, 3);
  const repoAReader = opened[2]!;

  // 4. LRU cap (maxReaders: 2): open repo-b, touch repo-a (refresh LRU), then open repo-c -> evicts repo-b.
  assert.equal((await getList("repo-b")).status, 200);
  const repoBReader = opened[3]!;
  assert.equal((await getList("repo-a")).status, 200);
  assert.equal(opened.length, 4, "repo-a should hit LRU cache without reopening");
  assert.equal((await getList("repo-c")).status, 200);
  const repoCReader = opened[4]!;
  assert.equal(repoBReader.closeCalls, 1, "LRU eviction must close repo-b reader");
  assert.equal(repoAReader.closeCalls, 0, "recently used repo-a reader must stay warm");

  // 5. host.close() closes all remaining cached readers and rejects subsequent requests with 503.
  await host.close();
  assert.equal(repoAReader.closeCalls, 1);
  assert.equal(repoCReader.closeCalls, 1);

  const afterClose = await getList("repo-a");
  assert.equal(afterClose.status, 503);
  assert.deepEqual(await afterClose.json(), { error: { code: "query_store_unavailable" } });
});
