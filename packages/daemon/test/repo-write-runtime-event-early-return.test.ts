// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  createRepoWriteChildHost,
  encodeRepoWriteCommand,
  type RepoWriteChildMessage
} from "../src/index.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture
} from "../../cli/test/helpers/production-authority-lifecycle-fixture.ts";
import {
  newTaskOperationCommand,
  newTaskOperationDirectMessage,
  productionProgressOperationAxes,
  productionProgressOperationHost,
  slowFailedDirectAuthorityComponent
} from "./support/production-progress-operation-fixture.ts";

const operationTest = process.platform === "win32" ? test.skip : test;

operationTest("task create responds before its auto runtime-event append and attached materializer tail", async (t) => {
  const fast = await runTaskCreate(0);
  const slow = await runTaskCreate(180);

  assert.equal(fast.response.settlement?.canonicalVisibility, "pending");
  assert.equal(slow.response.settlement?.canonicalVisibility, "pending");
  assert.equal(typeof slow.response.settlement?.statusQuery, "object");
  assert.deepEqual(
    slow.events.filter((event) => event === "runtime-event-write"),
    ["runtime-event-write"]
  );
  assert.ok(slow.runtimeEventTiming.startedAt !== undefined);
  assert.ok(slow.runtimeEventTiming.finishedAt !== undefined);
  assert.ok(
    slow.responseAt < slow.runtimeEventTiming.startedAt,
    `response at ${slow.responseMs.toFixed(1)}ms followed runtime-event append at ${(slow.runtimeEventTiming.startedAt - slow.startedAt).toFixed(1)}ms`
  );
  assert.ok(
    Math.abs(slow.responseMs - fast.responseMs) < 90,
    `180ms runtime-event materializer changed acceptance latency from ${fast.responseMs.toFixed(1)}ms to ${slow.responseMs.toFixed(1)}ms`
  );
  t.diagnostic(JSON.stringify({
    fastResponseMs: fast.responseMs,
    slowResponseMs: slow.responseMs,
    runtimeEventStartedAfterMs: slow.runtimeEventTiming.startedAt - slow.startedAt,
    runtimeEventFinishedAfterMs: slow.runtimeEventTiming.finishedAt - slow.startedAt
  }));
});

operationTest("a post-response runtime-event append failure is surfaced and drained", async () => {
  const run = await runTaskCreate(20, "simulated runtime-event append failure");

  assert.equal(run.response.settlement?.canonicalVisibility, "pending");
  assert.ok(run.runtimeEventTiming.startedAt !== undefined);
  assert.ok(run.responseAt < run.runtimeEventTiming.startedAt);
  assert.equal(run.failures.length, 1);
  assert.equal(run.failures[0]?.requestId, "request-task-create-early-return");
  assert.equal(run.failures[0]?.command, "new-task");
  assert.match(run.failures[0]?.reason ?? "", /simulated runtime-event append failure/u);
});

async function runTaskCreate(materializerDelayMs: number, failReason?: string) {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-task-create-runtime-tail-"));
  const events: string[] = [];
  const messages: Array<{ readonly frame: RepoWriteChildMessage; readonly at: number }> = [];
  const settlementTiming: { startedAt?: number; finishedAt?: number } = {};
  const runtimeEventTiming: { startedAt?: number; finishedAt?: number } = {};
  const failures: Array<{ readonly requestId: string; readonly command: string; readonly reason: string }> = [];
  try {
    const actor = productionAuthorityActor();
    const store = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...productionProgressOperationAxes()
    });
    const operation = productionProgressOperationHost(
      store,
      slowFailedDirectAuthorityComponent(events, 0, settlementTiming),
      events,
      outcomeDirectory,
      undefined,
      false,
      { materializerDelayMs, timing: runtimeEventTiming, failures, ...(failReason ? { failReason } : {}) }
    );
    const child = createRepoWriteChildHost({
      ...productionProgressOperationAxes(),
      artifactIdentity: `sha256:${"a".repeat(64)}`,
      transport: {
        send: async (frame) => {
          messages.push({ frame, at: performance.now() });
        }
      },
      hooks: {
        prepare: (input) => operation.prepare(input),
        direct: (input) => operation.direct(input),
        lookup: (input) => operation.lookup(input),
        shutdown: async () => operation.settlementIdle()
      }
    });
    await child.start();
    const startedAt = performance.now();
    await child.receive(newTaskOperationDirectMessage(encodeRepoWriteCommand({
      command: newTaskOperationCommand(fixture.repoRoot) as unknown as Record<string, unknown>,
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: `session-task-create-runtime-tail-${materializerDelayMs}`,
          source: "manual",
          detectedAt: "2026-08-10T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    })));
    const delivered = messages.find(({ frame }) => frame.kind === "direct-result");
    assert.equal(delivered?.frame.kind, "direct-result");
    if (!delivered || delivered.frame.kind !== "direct-result") {
      throw new Error("task create did not return a direct result");
    }
    await operation.settlementIdle();
    while (settlementTiming.finishedAt === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return {
      events: [...events],
      response: delivered.frame.receipt,
      responseAt: delivered.at,
      responseMs: delivered.at - startedAt,
      runtimeEventTiming,
      failures,
      startedAt
    };
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
