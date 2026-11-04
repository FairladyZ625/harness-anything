// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openRepoCellProxy } from "../src/repo-cell-proxy.ts";
import { REPO_READ_WORKERS, REPO_READ_QUEUE_LIMIT } from "../src/repo-read-pool.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

async function waitStarted(barrier: Int32Array, count: number): Promise<void> {
  for (let observed = Atomics.load(barrier, 1); observed < count; observed = Atomics.load(barrier, 1))
    await Atomics.waitAsync(barrier, 1, observed).value;
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
    const host = await openDaemonHost({
      daemonId: "read-isolation",
      userRoot,
      openCell: (input) =>
        openRepoCellProxy(input, {
          createReadWorker: (_url, options) => {
            workers++;
            return new Worker(new URL("./fixtures/read-barrier-worker.ts", import.meta.url), {
              ...options,
              workerData: { ...options.workerData, barrier: barrier.buffer },
            });
          },
        }),
    });
    const auth = { transportKind: "unix-socket" as const };
    const pending: Promise<unknown>[] = [];
    try {
      await host.attachmentsSettled();
      await rpc(host, auth, "repo.workspace.summary.read", { repo: { repoId } });
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
      // Queue admission is tested through the same production pool, independent of transport auth.
      const cell = await openRepoCellProxyForQueue();
      try {
        const reads = Array.from({ length: REPO_READ_QUEUE_LIMIT }, () => cell.read("repo.workspace.summary.read"));
        pending.push(...reads);
        await assert.rejects(
          cell.read("repo.workspace.summary.read"),
          (error: unknown) =>
            (error as { code: string; data: { retryable: boolean } }).code === "read_overloaded" &&
            (error as { data: { retryable: boolean } }).data.retryable,
        );
        const overloaded = await rpc(host, auth, "repo.workspace.summary.read", { repo: { repoId } });
        assert.equal(overloaded.code, "read_overloaded");
        assert.match(String(overloaded.rejectionExplanation), /retry/u);
        assert.equal(workers, REPO_READ_WORKERS);
      } finally {
        Atomics.store(barrier, 0, 0);
        Atomics.store(barrier, 2, 1);
        Atomics.notify(barrier, 2);
        await Promise.all(pending);
        await cell.close();
      }
    } finally {
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      await Promise.allSettled(pending);
      await host.close();
      rmSync(parent, { recursive: true, force: true });
    }
    async function openRepoCellProxyForQueue() {
      // Reuse the already attached cell through the public openCell seam without a second writer.
      const { openRepoReadClient } = await import("../src/repo-read-pool.ts");
      const client = openRepoReadClient({ repoId: repoId as never, rootDir: root as never, ownerId: "queue-test" });
      return { read: (method: string) => client.request("read", [method, {}]), close: client.close };
    }
  },
);
function p99(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1]!;
}
