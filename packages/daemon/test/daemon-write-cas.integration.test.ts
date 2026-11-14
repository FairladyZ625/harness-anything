// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { bundle, eventAt } from "../../storage/test/store/task-event-store.fixtures.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoWriterRequestV1 } from "../src/repo-writer-protocol.ts";

for (const before of [true, false])
  test(
    `daemon C6${before ? "a" : "b"}: ${before ? "abort" : "commit"} wins across both real worker threads`,
    { timeout: 60_000 },
    async () => {
      const fixture = await pgRuntimeFixture(),
        repoId = workspaceId(`daemon-cas-${before}`),
        gate = new Int32Array(new SharedArrayBuffer(4)),
        reached = new Int32Array(new SharedArrayBuffer(4)),
        stats = new Int32Array(new SharedArrayBuffer(12)),
        storage = {
          backend: "postgres" as const,
          connectionString: fixture.connectionString,
          scope: { tenantId: "s3", projectId: "cas", policyEpoch: 1, readers: [] },
        };
      const requests: RepoWriterRequestV1[] = [];
      let terminateCalls = 0;
      const supervisor = await openWriterSupervisor(
        { repoId, rootDir: canonicalRoot(fixture.root), ownerId: "cas", storage },
        {
          createWorker: () => {
            const worker = new Worker(new URL("./fixtures/syncrep-cas-worker.ts", import.meta.url), {
              workerData: { storage, repoId, gate, reached, stats, before },
            });
            const post = worker.postMessage.bind(worker),
              terminate = worker.terminate.bind(worker);
            worker.postMessage = (request: RepoWriterRequestV1) => {
              if (request.schema === "harness-repo-writer-request/v1") requests.push(request);
              post(request);
            };
            worker.terminate = () => {
              terminateCalls++;
              return terminate();
            };
            return worker;
          },
        },
      );
      const append = (revision: number) => ({
        operation: "append",
        bundle: bundle(eventAt(revision)),
        expectedRevision: revision - 1,
        writerFence: { repoId, holderId: "direct-store", epoch: 1 },
      });
      let next: Promise<unknown> | undefined;
      try {
        const abort = new AbortController(),
          pending = supervisor.request("run", append(1), undefined, abort.signal);
        const outcome = before ? assert.rejects(pending, { name: "AbortError" }) : pending;
        await Atomics.waitAsync(reached, 0, 0).value;
        const state = requests[0]!.writeRequest!.state;
        assert.equal(Atomics.load(state, 1), before ? 0 : 1);
        abort.abort();
        assert.equal(Atomics.load(state, 1), before ? -1 : 1);
        if (!before) {
          const receipt = (await pending) as { outcome: string; opId: string };
          assert.equal(receipt.outcome, "indeterminate");
          assert.equal(receipt.opId, append(1).bundle.event.opId);
        }
        next = supervisor.request("run", append(before ? 1 : 2));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 1, "detach/abort cannot free the underlying slot");
        assert.equal(terminateCalls, 0);
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        await outcome;
        await next;
        assert.equal(Atomics.load(stats, 0), before ? 1 : 2); // next commits after the contested operation
        assert.equal(Atomics.load(stats, 1), before ? 1 : 0);
        assert.equal(Atomics.load(stats, 2), 0);
        assert.equal(terminateCalls, 0);
        const rows = await fixture.adminPool.query("SELECT revision FROM ha_repo_heads WHERE repo_id=$1", [repoId]);
        assert.equal(Number(rows.rows[0]!.revision), before ? 1 : 2);
        console.log(
          "S3_REAL_C6",
          JSON.stringify({
            before,
            contestedCommitCalls: Atomics.load(stats, 0) - 1,
            rollbackCalls: Atomics.load(stats, 1),
            terminateCalls,
            phase: state[1],
            finalRevision: rows.rows[0]!.revision,
          }),
        );
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        await next;
        await supervisor.close();
        await fixture.pool.end();
        await fixture.close();
      }
    },
  );
