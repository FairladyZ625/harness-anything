// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskHolderService, taskHolderActor } from "@harness-anything/kernel";
import {
  DurableRepoWriteOutcomeStoreV1,
  createRepoWriteChildHost,
  encodeRepoWriteCommand,
  type RepoWriteChildMessage
} from "../src/index.ts";
import { daemonActorAttribution } from "../../cli/src/composition/actor-attribution.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture
} from "../../cli/test/helpers/production-authority-lifecycle-fixture.ts";
import {
  enableProgressOperationLease,
  installProgressOperationTask,
  newTaskOperationCommand,
  newTaskOperationDirectMessage,
  productionProgressOperationAxes,
  productionProgressOperationHost,
  progressOperationCommand,
  progressOperationDurabilityEvents,
  progressOperationProceedMessage,
  progressOperationSubmitMessage,
  progressOperationTaskId,
  slowFailedDirectAuthorityComponent,
  slowFailedProgressAuthorityComponent
} from "./support/production-progress-operation-fixture.ts";

const operationTest = process.platform === "win32" ? test.skip : test;

operationTest("child returns durable acceptance before deliberately slow failed canonical settlement", async (t) => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-progress-early-return-"));
  const events: string[] = [];
  const messages: Array<{ readonly frame: RepoWriteChildMessage; readonly at: number }> = [];
  const settlementDelayMs = 180;
  const settlementTiming: { startedAt?: number; finishedAt?: number } = {};
  try {
    enableProgressOperationLease(fixture.authoredRoot);
    installProgressOperationTask(fixture.authoredRoot);
    const actor = productionAuthorityActor();
    const attribution = daemonActorAttribution(actor, { kind: "agent", id: "codex" });
    await makeTaskHolderService({ rootInput: fixture.repoRoot }).claim({
      taskId: progressOperationTaskId,
      principal: taskHolderActor(attribution.taskHolderPrincipal, attribution.executor),
      ttlMs: 60_000
    });
    const store = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...productionProgressOperationAxes(),
      __testOnlyDurabilityHooks: progressOperationDurabilityEvents(events)
    });
    const operation = productionProgressOperationHost(
      store,
      slowFailedProgressAuthorityComponent(events, settlementDelayMs, settlementTiming),
      events,
      outcomeDirectory
    );
    let proceeding = false;
    const child = createRepoWriteChildHost({
      ...productionProgressOperationAxes(),
      artifactIdentity: `sha256:${"a".repeat(64)}`,
      transport: {
        send: async (frame) => {
          if (proceeding && frame.kind === "telemetry") {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
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
    await child.receive(progressOperationSubmitMessage(encodeRepoWriteCommand({
      command: progressOperationCommand(fixture.repoRoot) as unknown as Record<string, unknown>,
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-progress-early-return",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    })));
    const prepared = messages.find(({ frame }) => frame.kind === "prepared")?.frame;
    assert.equal(prepared?.kind, "prepared");
    if (prepared?.kind !== "prepared") return;

    proceeding = true;
    const startedAt = performance.now();
    await child.receive(progressOperationProceedMessage(prepared.requestId, prepared.opId));
    const accepted = messages.find(({ frame }) => frame.kind === "accepted");
    assert.equal(accepted?.frame.kind, "accepted");
    if (!accepted || accepted.frame.kind !== "accepted") return;
    const responseMs = accepted.at - startedAt;
    await operation.settlementIdle();
    const failed = await operation.lookup({
      ...productionProgressOperationAxes(),
      opId: prepared.opId
    });

    assert.equal(accepted.frame.receipt.settlement?.canonicalVisibility, "pending");
    assert.equal(typeof accepted.frame.receipt.settlement?.statusQuery, "object");
    assert.equal(failed.state, "settlement-failed");
    assert.equal(failed.state === "settlement-failed"
      ? failed.receipt.settlement?.canonicalVisibility
      : undefined, "failed");
    assert.equal(failed.state === "settlement-failed"
      ? failed.receipt.settlement?.statusQuery.command
      : undefined, accepted.frame.receipt.settlement?.statusQuery.command);
    assert.match(failed.state === "settlement-failed"
      && failed.receipt.settlement?.canonicalVisibility === "failed"
      ? failed.receipt.settlement.failure.message
      : "", /simulated slow canonical settlement failure/u);
    assert.ok(settlementTiming.startedAt !== undefined);
    assert.ok(settlementTiming.finishedAt !== undefined);
    assert.ok(
      accepted.at < settlementTiming.startedAt,
      `accepted response took ${responseMs.toFixed(1)}ms and followed slow settlement ${JSON.stringify(settlementTiming)}`
    );
    t.diagnostic(JSON.stringify({
      responseMs,
      settlementDelayMs,
      settlementStartedAfterMs: settlementTiming.startedAt - startedAt,
      settlementFinishedAfterMs: settlementTiming.finishedAt - startedAt
    }));
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

operationTest("direct task create returns pending before its deliberately slow failed settlement", async (t) => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-task-create-early-return-"));
  const events: string[] = [];
  const messages: Array<{ readonly frame: RepoWriteChildMessage; readonly at: number }> = [];
  const settlementDelayMs = 180;
  const settlementTiming: { startedAt?: number; finishedAt?: number } = {};
  try {
    const actor = productionAuthorityActor();
    const store = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...productionProgressOperationAxes()
    });
    const operation = productionProgressOperationHost(
      store,
      slowFailedDirectAuthorityComponent(events, settlementDelayMs, settlementTiming),
      events,
      outcomeDirectory,
      undefined,
      false
    );
    let executing = false;
    const child = createRepoWriteChildHost({
      ...productionProgressOperationAxes(),
      artifactIdentity: `sha256:${"a".repeat(64)}`,
      transport: {
        send: async (frame) => {
          if (executing && frame.kind === "telemetry") {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
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
    executing = true;
    const startedAt = performance.now();
    await child.receive(newTaskOperationDirectMessage(encodeRepoWriteCommand({
      command: newTaskOperationCommand(fixture.repoRoot) as unknown as Record<string, unknown>,
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-task-create-early-return",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    })));
    const response = messages.find(({ frame }) => frame.kind === "direct-result");
    assert.equal(response?.frame.kind, "direct-result");
    if (!response || response.frame.kind !== "direct-result") return;
    while (settlementTiming.finishedAt === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const settlement = response.frame.receipt.settlement;
    assert.equal(settlement?.canonicalVisibility, "pending");
    assert.equal(typeof settlement?.statusQuery, "object");
    if (!settlement) return;
    const failed = await operation.lookup({
      ...productionProgressOperationAxes(),
      opId: settlement.receiptId
    });

    assert.equal(events.filter((event) => event === "inner-submit").length, 1);
    assert.equal(failed.state, "settlement-failed");
    assert.equal(failed.state === "settlement-failed"
      ? failed.receipt.settlement?.canonicalVisibility
      : undefined, "failed");
    assert.equal(failed.state === "settlement-failed"
      ? failed.receipt.settlement?.statusQuery.command
      : undefined, settlement.statusQuery.command);
    assert.match(failed.state === "settlement-failed"
      && failed.receipt.settlement?.canonicalVisibility === "failed"
      ? failed.receipt.settlement.failure.message
      : "", /simulated slow direct canonical settlement failure/u);
    assert.ok(settlementTiming.startedAt !== undefined);
    assert.ok(response.at < settlementTiming.startedAt);
    t.diagnostic(JSON.stringify({
      responseMs: response.at - startedAt,
      settlementDelayMs,
      settlementStartedAfterMs: settlementTiming.startedAt - startedAt,
      settlementFinishedAfterMs: settlementTiming.finishedAt - startedAt
    }));
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
