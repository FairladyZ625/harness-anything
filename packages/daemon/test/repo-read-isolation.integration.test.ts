// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createDaemonHostRepositoryApi } from "../src/daemon-host/daemon-host-repository-api.ts";
import type { DaemonHostApiContext } from "../src/daemon-host/daemon-host-context.ts";
import type { RepoCell, RepoCellBinding } from "../src/daemon-host/repo-cell-types.ts";
import { openRepoCellProxy } from "../src/daemon-host/repo-cell-proxy.ts";
import { openRepoReadClient, REPO_READ_WORKERS, REPO_READ_QUEUE_LIMIT } from "../src/daemon-host/repo-read-pool.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { isJsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { serveJsonRpcStream } from "../src/daemon-host/transport/json-rpc-stream.ts";
import { initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo, openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

async function waitStarted(barrier: Int32Array, count: number): Promise<void> {
  for (let observed = Atomics.load(barrier, 1); observed < count; observed = Atomics.load(barrier, 1))
    await Atomics.waitAsync(barrier, 1, observed).value;
}

async function assertFullQueueAvailable(repoId: string, root: string): Promise<void> {
  const live = openRepoReadClient({ repoId: repoId as never, rootDir: root as never, ownerId: "queue-probe" });
  const admission = new AbortController();
  try {
    const probes = Array.from({ length: REPO_READ_QUEUE_LIMIT + 1 }, () =>
      live
        .request("read", ["repo.workspace.summary.read", {}], undefined, admission.signal)
        .catch((error: { readonly code?: string }) => error.code),
    );
    admission.abort();
    const codes = await Promise.all(probes);
    assert.equal(codes.filter((code) => code === "read_aborted").length, REPO_READ_QUEUE_LIMIT);
    assert.equal(codes.filter((code) => code === "read_overloaded").length, 1);
  } finally {
    await live.close();
  }
}

test(
  "slow reads occupy a bounded pool while status, hello and writes remain responsive",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-read-isolation-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "read-isolation",
      barrier = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    initIngressRepo(root, process.getuid?.() ?? 0);
    signInPolicyTestUser(userRoot, "owner", [repoId], "admin");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
    let workers = 0;
    let onReadIssued: (() => void) | undefined;
    let cellForFleet: RepoCell;
    const doctorInitial = Promise.withResolvers<void>(),
      doctorContinue = Promise.withResolvers<void>(),
      doctorConnection = new AbortController();
    const host = await openDaemonHost({
      daemonId: "read-isolation",
      userRoot,
      openCell: async (input) => {
        const cell = await openRepoCellProxy(input, {
          createReadWorker: (_url, options) => {
            workers++;
            return new Worker(new URL("./fixtures/read-barrier-worker.ts", import.meta.url), {
              ...options,
              workerData: { ...options.workerData, barrier: barrier.buffer },
            });
          },
        });
        cellForFleet = cell;
        const { read, run } = cell;
        const trackedRead: typeof read = (...args) => {
          const result = read(...args);
          onReadIssued?.();
          return result;
        };
        const trackedRun: typeof run = async (...args) => {
          const receipt = await run(...args);
          if (args[0].kind === "doctor-health") {
            doctorInitial.resolve();
            await doctorContinue.promise;
          }
          return receipt;
        };
        return Object.assign(cell, { read: trackedRead, run: trackedRun });
      },
    });
    const auth = { transportKind: "unix-socket" as const };
    const pending: Promise<unknown>[] = [];
    try {
      await host.attachmentsSettled();
      await rpc(host, auth, "repo.workspace.summary.read", { repo: { repoId } });
      const doctor = rpc(host, { ...auth, connectionSignal: doctorConnection.signal }, "repo.task.read", {
        repo: { repoId },
        payload: { action: { kind: "doctor-health" } },
      });
      pending.push(doctor);
      await Promise.race([doctorInitial.promise, doctor.then((reply) => assert.fail(JSON.stringify(reply)))]);
      Atomics.store(barrier, 0, 1);
      for (let index = 0; index < REPO_READ_WORKERS; index++)
        pending.push(rpc(host, auth, "repo.workspace.summary.read", { repo: { repoId } }));
      await waitStarted(barrier, REPO_READ_WORKERS);
      assert.equal(workers, REPO_READ_WORKERS);
      const status: number[] = [],
        hello: number[] = [],
        writes: number[] = [];
      for (let sample = 0; sample < 20; sample++) {
        let start = performance.now();
        const result = await rpc(host, auth, "daemon.status", {});
        assert.equal(result.pid, process.pid);
        status.push(performance.now() - start);
        start = performance.now();
        const server = createJsonRpcProtocolServer({
          host,
          build: { commit: null },
          authContext: auth,
          emit: async () => undefined,
        });
        const greeting = await server.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "protocol.hello",
          params: { protocolVersion: currentDaemonProtocolVersion },
        });
        assert.ok(greeting && !Array.isArray(greeting) && "result" in greeting);
        server.close();
        hello.push(performance.now() - start);
        start = performance.now();
        const written = await rpc(host, auth, "repo.task.create", {
          repo: { repoId },
          payload: { title: `During slow read ${sample}`, presetId: "standard-task" },
        });
        assert.equal(written.outcome, "applied", JSON.stringify(written));
        writes.push(performance.now() - start);
        assert.equal(Atomics.load(barrier, 2), 0, "all probes completed before releasing the readers");
      }
      const metrics = { statusP99: p99(status), helloP99: p99(hello), writeP99: p99(writes) };
      assert.ok(metrics.statusP99 < 1000 && metrics.helloP99 < 1000, JSON.stringify(metrics));
      t.diagnostic(JSON.stringify(metrics));
      await t.test("a disconnect cancels doctor health's queued settings read after its initial result", async () => {
        const issued = Promise.withResolvers<void>();
        onReadIssued = () => {
          doctorConnection.abort();
          issued.resolve();
        };
        doctorContinue.resolve();
        try {
          await Promise.race([issued.promise, doctor.then((reply) => assert.fail(JSON.stringify(reply)))]);
          await assertFullQueueAvailable(repoId, root);
          const result = await doctor;
          assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
          assert.equal(result.code, "read_aborted");
          assert.equal(Atomics.load(barrier, 1), REPO_READ_WORKERS);
        } finally {
          onReadIssued = undefined;
        }
      });
      await t.test("a disconnected home overview frees its three reads before a reader becomes idle", async () => {
        const disconnected = new AbortController(),
          issued = Promise.withResolvers<void>();
        let remaining = 3;
        onReadIssued = () => {
          if (--remaining === 0) issued.resolve();
        };
        try {
          pending.push(rpc(host, { ...auth, connectionSignal: disconnected.signal }, "daemon.gui.home.read", {}));
          await issued.promise;
          disconnected.abort();
          await assertFullQueueAvailable(repoId, root);
          assert.equal(Atomics.load(barrier, 1), REPO_READ_WORKERS);
        } finally {
          onReadIssued = undefined;
          disconnected.abort();
        }
      });
      await t.test("Fleet operational reads release queue slots on client disconnect", async () => {
        const realCell = cellForFleet!;
        const nodePrincipal = { personId: "person-owner", nodeId: "node-one" };
        const binding: RepoCellBinding = {
          actor: { principal: { personId: nodePrincipal.personId }, executor: null },
          source: { kind: "node", nodeId: nodePrincipal.nodeId },
        };
        for (const phase of ["settings", "lifecycle", "assignments", "dispatch"] as const) {
          const disconnected = new AbortController(),
            issued = Promise.withResolvers<void>();
          const fleetAuth = {
            transportKind: "fleet-tls" as const,
            nodePrincipal,
            connectionSignal: disconnected.signal,
          };
          const afterSubmitting = <T>(request: Promise<T>): Promise<T> => {
            disconnected.abort();
            issued.resolve();
            return request;
          };
          const cell = {
            ...realCell,
            read: (...args: Parameters<RepoCell["read"]>) =>
              phase === "settings" ? afterSubmitting(realCell.read(...args)) : Promise.resolve({}),
            readDispatchLifecycle: (...args: Parameters<RepoCell["readDispatchLifecycle"]>) =>
              afterSubmitting(realCell.readDispatchLifecycle(...args)),
            readNodeAutoClaimAssignments: (...args: Parameters<RepoCell["readNodeAutoClaimAssignments"]>) =>
              afterSubmitting(realCell.readNodeAutoClaimAssignments(...args)),
            readNodeAutoDispatchCandidates: (
              ...args: Parameters<NonNullable<RepoCell["readNodeAutoDispatchCandidates"]>>
            ) => afterSubmitting(realCell.readNodeAutoDispatchCandidates!(...args)),
          };
          const api = createDaemonHostRepositoryApi({
            cells: new Map([[repoId, cell]]),
            binding: async () => binding,
          } as unknown as DaemonHostApiContext);
          const request =
            phase === "dispatch"
              ? api.readNodeAutoDispatchCandidates(repoId, fleetAuth)
              : phase === "assignments"
                ? api.readNodeAutoClaimCandidates(repoId, fleetAuth)
                : api.readDispatchLifecycle(repoId, { by: "dispatch", dispatchIds: ["dispatch-fixture"] }, fleetAuth);
          const rejected = assert.rejects(request, { code: "read_aborted" }, phase);
          pending.push(rejected);
          await Promise.race([issued.promise, rejected]);
          await assertFullQueueAvailable(repoId, root);
          await rejected;
        }
      });
      await t.test("disconnect frees a full queue for a live client while every worker is still busy", async () => {
        const overload = Promise.withResolvers<void>(),
          input = new PassThrough(),
          output = new PassThrough(),
          hello = {
            jsonrpc: "2.0" as const,
            id: 0,
            method: "protocol.hello",
            params: { protocolVersion: currentDaemonProtocolVersion },
          },
          batch = Array.from({ length: REPO_READ_QUEUE_LIMIT + 1 }, (_, index) => ({
            jsonrpc: "2.0" as const,
            id: index + 1,
            method: "repo.workspace.summary.read",
            params: { repo: { repoId } },
          }));
        let written = "";
        output.setEncoding("utf8").on("data", (chunk: string) => {
          written += chunk;
        });
        const connection = serveJsonRpcStream({
          input,
          output,
          transportKind: "unix-socket",
          authContext: auth,
          createProtocolServer: (authContext, emit, connectionId, connectionSignal) =>
            createJsonRpcProtocolServer({
              host,
              build: { commit: null },
              authContext: { ...authContext, connectionSignal },
              emit,
              connectionId,
              recordTraffic: ({ code }) => {
                if (code === "read_overloaded") overload.resolve();
              },
            }),
        });
        const live = createJsonRpcProtocolServer({
          host,
          build: { commit: null },
          authContext: auth,
          emit: async () => undefined,
        });
        try {
          input.write(JSON.stringify(hello) + "\n" + JSON.stringify(batch) + "\n");
          await overload.promise;
          const queueProbe = openRepoReadClient({
            repoId: repoId as never,
            rootDir: root as never,
            ownerId: "queue-test",
          });
          try {
            await assert.rejects(queueProbe.request("read", ["repo.workspace.summary.read", {}]), {
              code: "read_overloaded",
              data: { retryable: true },
            });
          } finally {
            await queueProbe.close();
          }
          const disconnected = once(input, "close");
          input.destroy();
          await disconnected;
          await connection.close();
          assert.deepEqual(
            written
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line).id),
            [hello.id],
            "the transport drops the disconnected client's entire late reply",
          );
          await live.handle(hello);
          const issued = Promise.withResolvers<void>();
          let remaining = batch.length;
          onReadIssued = () => {
            if (--remaining === 0) issued.resolve();
          };
          const results = live.handle(batch);
          pending.push(results);
          await issued.promise;
          assert.equal(
            Atomics.load(barrier, 1),
            REPO_READ_WORKERS,
            "all four workers are still in their original reads",
          );
          Atomics.store(barrier, 2, 1);
          Atomics.notify(barrier, 2);
          const responses = await results;
          assert.ok(Array.isArray(responses));
          const replies = responses.map((response) => {
            assert.ok("result" in response && isJsonObject(response.result));
            return response.result;
          });
          const admitted = replies.filter((reply) => reply.ok === true);
          assert.equal(admitted.length, REPO_READ_QUEUE_LIMIT, "the live client can fill all newly free queue slots");
          const refused = replies.filter((reply) => reply.code === "read_overloaded");
          assert.equal(refused.length, 1);
          assert.match(String(refused[0]!.rejectionExplanation), /retry/u);
          assert.equal(
            Atomics.load(barrier, 1),
            REPO_READ_WORKERS + REPO_READ_QUEUE_LIMIT,
            "abandoned reads never start",
          );
          assert.equal(workers, REPO_READ_WORKERS);
          await Promise.all(pending);
        } finally {
          onReadIssued = undefined;
          Atomics.store(barrier, 2, 1);
          Atomics.notify(barrier, 2);
          live.close();
          await connection.close();
        }
      });
    } finally {
      doctorConnection.abort();
      doctorContinue.resolve();
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      await Promise.allSettled(pending);
      await host.close();
      removeTempRepository(parent);
    }
  },
);
function p99(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1]!;
}

test("read clients without a physical worker context reuse workers across repository owners", async () => {
  let workers = 0;
  const factory = () => {
    workers++;
    return new Worker(
      `const {parentPort} = require('node:worker_threads');
      parentPort.postMessage({schema: 'harness-repo-writer-status/v1', protocolVersion: 1, kind: 'attach-progress'});
      parentPort.on('message', request => parentPort.postMessage({
        requestId: request.requestId, outcome: 'ok', value: request.payload.config.repoId
      }));`,
      { eval: true },
    );
  };
  const clients = ["one", "two"].map((repoId) =>
    openRepoReadClient({ repoId: repoId as never, rootDir: "/unused" as never, ownerId: repoId }, factory),
  );
  try {
    for (let n = 0; n < 6; n++) assert.equal(await clients[n % 2]!.request("probe", []), n % 2 === 0 ? "one" : "two");
    assert.equal(workers, 1, "alternating owners must not cold-start a worker for every read");
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

test("closing a real reader releases SQLite handles before reusing its isolate at the same root", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-reader-release-")),
    repoId = "reader-release",
    handles = new Int32Array(new SharedArrayBuffer(8)),
    workers: Worker[] = [],
    timings: number[] = [];
  initIngressRepo(root, process.getuid?.() ?? 0);
  const input = { repoId: repoId as never, rootDir: root as never, ownerId: "release-test" },
    factory: import("../src/daemon-host/repo-read-pool.ts").RepoReadWorkerFactory = (_url, options) => {
      const worker = new Worker(new URL("./fixtures/read-handle-worker.ts", import.meta.url), {
        ...options,
        workerData: { ...options.workerData, handles: handles.buffer },
      });
      workers.push(worker);
      return worker;
    };
  // The reader consumes a completed projection; seeding only the canonical event
  // store does not build it. Attach and drain the real writer before opening readers.
  await (await openBootstrappedRepoCell(input)).close();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = openRepoReadClient(input, factory);
      try {
        const started = performance.now();
        assert.ok(await client.request("readEventWitness", [1]));
        timings.push(performance.now() - started);
        await client.request("observeTail", [{ kind: "events", direction: "history" }]);
        assert.ok(Atomics.load(handles, 0) > Atomics.load(handles, 1), "the real read must open a connection");
      } finally {
        await client.close();
      }
      assert.equal(Atomics.load(handles, 0), Atomics.load(handles, 1), "close resolves after native handles close");
      assert.equal(workers.length, 1, "the next client at the same root reuses the isolate");
      assert.ok(workers[0]!.threadId > 0, "the worker remains alive after releasing its connections");
    }
    const first = openRepoReadClient(input, factory),
      second = openRepoReadClient(input, factory);
    try {
      assert.ok(await first.request("readEventWitness", [1]));
      const closedBeforeHandoff = Atomics.load(handles, 1);
      assert.ok(await second.request("readEventWitness", [1]));
      assert.ok(
        Atomics.load(handles, 1) > closedBeforeHandoff,
        "a different client at the same root must release the previous client's native handles",
      );
      await first.close();
      assert.equal(workers.length, 1, "same-root client handoff retains the compatible isolate");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    assert.equal(Atomics.load(handles, 0), Atomics.load(handles, 1), "both clients drain every native handle");
    removeTempRepository(root);
    t.diagnostic(`native reader handles opened=${Atomics.load(handles, 0)} closed=${Atomics.load(handles, 1)}`);
    t.diagnostic(`reader first-query ms: cold=${timings[0]!.toFixed(1)} warm=${timings[1]!.toFixed(1)}`);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    removeTempRepository(root);
  }
});
