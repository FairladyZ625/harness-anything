// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

const openProbe = new URL("./fixtures/writer-epoch-open-probe.mjs", import.meta.url).href;

test("production writer requests open the epoch database once and never block on the host clock", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-writer-request-cost-")),
    repoId = workspaceId("writer-request-cost"),
    stateRoot = path.join(parent, "writer-epochs"),
    epochOpens: unknown[] = [],
    blockingCalls: string[] = [];
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
  try {
    mkdirSync(path.join(parent, "repo"));
    const rootDir = canonicalRoot(path.join(parent, "repo"));
    initRepo(rootDir);
    const authority = openPersistentWriterEpoch({ stateRoot, holderId: "writer-request-cost" }),
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
        ownerId: "writer-request-seed",
        defaultWriterEpochFence: fence,
      })
    ).close();
    supervisor = await openWriterSupervisor(
      // Production configuration: no injected clock, so the writer must read its own.
      { repoId, rootDir, ownerId: "writer-request-cost", defaultWriterEpochFence: fence },
      {
        createWorker: (url, options) => {
          const worker = new Worker(url, { ...options, execArgv: [...options.execArgv, "--import", openProbe] });
          worker.on(
            "message",
            (message: { readonly schema?: string; readonly capability?: string; sync?: unknown }) => {
              if (message?.schema === "writer-epoch-open-probe/v1") epochOpens.push(message);
              else if (message?.schema === "harness-repo-writer-capability-call/v1" && message.sync)
                blockingCalls.push(String(message.capability));
            },
          );
          return worker;
        },
      },
    );
    const binding = { actor, source: "local" as const, writerEpoch: fence.epoch, writerEpochFence: fence },
      opIds: string[] = [],
      startedAt = Date.now();
    for (const taskId of ["task_request_cost_a", "task_request_cost_b"]) {
      const receipt = await supervisor.request<{ readonly outcome: string; readonly opId: string }>(
        "run",
        { action: { kind: "task-create", taskId, title: "Writer request cost" } },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      opIds.push(receipt.opId);
    }
    assert.equal(epochOpens.length, 1, "per-request and append-fence checks must share one epoch handle");
    assert.deepEqual(blockingCalls, [], "a write must not block the writer thread on a host round trip");
    const ledger = makeTaskEventReader({ repoId, rootDir });
    try {
      for (const opId of opIds) {
        const occurredAt = Date.parse(String(ledger.readEvent(opId)?.occurredAt));
        assert.ok(
          occurredAt >= startedAt - 1_000 && occurredAt <= Date.now(),
          "the writer stamps events with its own clock",
        );
      }
    } finally {
      await ledger.drain();
    }
  } finally {
    await supervisor?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
