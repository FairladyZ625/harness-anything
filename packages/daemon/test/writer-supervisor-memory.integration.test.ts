// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { openWriterSupervisor, WRITER_IDLE_TIMEOUT_MS } from "../src/writer-supervisor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { fixtureFence, seedSettingsEvent } from "./repo-settings.fixture.ts";
import { initRepo, actor } from "./task-surface.fixtures.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";

test("five attached writers report comparable mount and post-write working sets", { timeout: 120_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retirements: Promise<unknown>[] = [];
  const parent = mkdtempSync(path.join(tmpdir(), "ha-writer-memory-")),
    supervisors: Awaited<ReturnType<typeof openWriterSupervisor>>[] = [],
    workers: Worker[] = [],
    bindings = [];
  const sample = async (phase: string) => {
    const isolates = await Promise.all(
      workers
        .filter((worker) => worker.threadId !== -1)
        .map(
          (worker) =>
            new Promise<Record<string, unknown>>((resolve) => {
              const listener = (message: Record<string, unknown>) => {
                if (message.schema !== "writer-memory-probe/v1") return;
                worker.off("message", listener);
                resolve(message);
              };
              worker.on("message", listener);
              worker.postMessage("memory-probe");
            }),
        ),
    );
    console.log("WRITER_MEMORY", JSON.stringify({ phase, memory: process.memoryUsage(), isolates }));
    return isolates;
  };
  const idle = async (phase: string) => {
    for (;;) {
      const firstAttempt = retirements.length;
      t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
      await Promise.all(retirements.slice(firstAttempt));
      if (workers.every((worker) => worker.threadId === -1) || retirements.length === firstAttempt) break;
      // A real background owner may veto the first idle deadline. Its receipt, followed by
      // another event turn and deadline, drives the test without a wall-clock sleep.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return sample(phase);
  };
  try {
    await sample("zero");
    for (let index = 0; index < 5; index++) {
      const directory = path.join(parent, String(index));
      mkdirSync(directory);
      const rootDir = canonicalRoot(directory),
        repoId = workspaceId(`memory-${index}`);
      initRepo(rootDir);
      provisionPolicyTestRepository(repoId);
      const fence = fixtureFence(repoId, rootDir, path.join(parent, "epochs"));
      await seedSettingsEvent({ repoId, rootDir, writerEpochFence: fence, keepOpen: true })!.drain();
      bindings.push(
        withPolicyGroup(
          { actor, source: "local" as const, writerEpoch: fence.epoch, writerEpochFence: fence },
          "contributor",
        ),
      );
      supervisors.push(
        await openWriterSupervisor(
          { repoId, rootDir, ownerId: "memory", defaultWriterEpochFence: fence, keycloakCenter: policyTestCenter },
          {
            createWorker: (url, options) => {
              const worker = new Worker(url, {
                ...options,
                execArgv: [
                  ...options.execArgv,
                  "--import",
                  new URL("./fixtures/writer-memory-probe.mjs", import.meta.url).href,
                ],
              });
              const post = worker.postMessage.bind(worker);
              worker.postMessage = (message: unknown, transferList) => {
                const control = message as { command?: string; requestId?: string };
                if (control.command === "hibernate")
                  retirements.push(
                    new Promise<void>((resolve) => {
                      const listener = (receipt: { requestId?: string; value?: unknown }) => {
                        if (receipt.requestId !== control.requestId) return;
                        worker.off("message", listener);
                        if (receipt.value === true) void once(worker, "exit").then(() => resolve());
                        else resolve();
                      };
                      worker.on("message", listener);
                    }),
                  );
                post(message, transferList);
              };
              workers.push(worker);
              return worker;
            },
          },
        ),
      );
    }
    const mounted = await sample("mounted-five");
    const generations = supervisors.map((supervisor) => supervisor.status().generation!);
    const idleMounted = await idle("idle-mounted-five");
    assert.equal(mounted.length, 5);
    // Source-bearing modules only: Node built-ins are excluded by the preload hook.
    for (const isolate of mounted) {
      assert.ok(Number(isolate.modules) <= 1_800, `writer import budget: ${String(isolate.modules)}`);
      assert.deepEqual(isolate.deliveryModules, [], "a writer cannot load a delivery application");
    }

    for (const [index, supervisor] of supervisors.entries()) {
      const receipt = await supervisor.request<{ outcome: string }>(
        "run",
        {
          action: {
            kind: "fact-record",
            statement: `memory write ${index}`,
            evidenceSource: "test:writer-memory",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
          },
        },
        bindings[index],
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }
    const written = await sample("written-five");
    assert.equal(written.length, 5);
    const idleWritten = await idle("idle-written-five");
    assert.equal(idleMounted.length, 0, "mounting does not permanently retain five isolates");
    assert.equal(idleWritten.length, 0, "completed writes do not permanently retain five isolates");
    for (const [index, supervisor] of supervisors.entries()) {
      assert.ok(supervisor.status().generation! > generations[index]!);
      assert.equal(supervisor.ledgerCut()?.revision, 2, "one accepted write per repository, no duplicates");
    }
  } finally {
    await Promise.all(supervisors.map((supervisor) => supervisor.close()));
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
