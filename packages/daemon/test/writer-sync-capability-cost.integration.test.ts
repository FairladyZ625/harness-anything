// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

const sabProbe = new URL("./fixtures/writer-sab-allocation-probe.mjs", import.meta.url).href;

test("sync capability round trips reuse one shared buffer pair for the writer's whole life", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-writer-sab-cost-")),
    repoId = workspaceId("writer-sab-cost"),
    stateRoot = path.join(parent, "writer-epochs"),
    sabAllocations: number[] = [],
    syncCalls: string[] = [];
  let clock = Date.parse("2026-09-13T00:00:00.000Z");
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
  try {
    mkdirSync(path.join(parent, "repo"));
    const rootDir = canonicalRoot(path.join(parent, "repo"));
    initRepo(rootDir);
    const authority = openPersistentWriterEpoch({ stateRoot, holderId: "writer-sab-cost" }),
      lease = authority.acquire(repoId);
    authority.close();
    const fence = {
      schema: "harness-writer-epoch-fence/v1" as const,
      stateRoot,
      repoId,
      epoch: lease.epoch,
      holderId: lease.holderId,
    };
    await (
      await openBootstrappedRepoCell({
        repoId,
        rootDir,
        ownerId: "writer-sab-seed",
        defaultWriterEpochFence: fence,
      })
    ).close();
    supervisor = await openWriterSupervisor(
      // An injected clock is what wires the sync capability: every event stamp crosses the fence
      // through syncCapability, so writes are the round trips this test counts allocations against.
      {
        repoId,
        rootDir,
        ownerId: "writer-sab-cost",
        defaultWriterEpochFence: fence,
        now: () => new Date((clock += 1_000)).toISOString(),
      },
      {
        createWorker: (url, options) => {
          const worker = new Worker(url, { ...options, execArgv: [...options.execArgv, "--import", sabProbe] });
          worker.on(
            "message",
            (message: {
              readonly schema?: string;
              readonly capability?: string;
              readonly byteLength?: number;
              sync?: unknown;
            }) => {
              if (message?.schema === "writer-sab-allocation-probe/v1") sabAllocations.push(Number(message.byteLength));
              else if (message?.schema === "harness-repo-writer-capability-call/v1" && message.sync)
                syncCalls.push(String(message.capability));
            },
          );
          return worker;
        },
      },
    );
    const binding = { actor, source: "local" as const, writerEpoch: fence.epoch, writerEpochFence: fence };
    for (const taskId of ["task_sab_a", "task_sab_b", "task_sab_c"]) {
      const receipt = await supervisor.request<{ readonly outcome: string }>(
        "run",
        { action: { kind: "task-create", taskId, title: "SAB reuse" } },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }
    assert.ok(
      syncCalls.length >= 3,
      `expected the injected clock to cross the fence per write, saw ${syncCalls.length}`,
    );
    // One 1 MiB response buffer serves every round trip: the writer thread blocks in Atomics.wait
    // while the supervisor overwrites the shared bytes, so calls never overlap. (The 8-byte state
    // cell is reused too, but 8-byte SABs are not uniquely attributable here — the kernel's local
    // VCS bridge allocates its own.)
    assert.equal(sabAllocations.filter((byteLength) => byteLength === 1024 * 1024).length, 1);
  } finally {
    await supervisor?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
