// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createJournaledBatch, isIndeterminateFlushReport, makeJournaledWriteCoordinator } from "../../src/index.ts";
import { docWrite, runEffect, withTempStoreAsync } from "./helpers.ts";

test("exact authority batch queues behind a transient global lock without changing its witness set", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      lockConflictRetry: { maxWaitMs: 500, initialDelayMs: 10, maxDelayMs: 20 }
    });
    const entry = Effect.runSync(coordinator.enqueue(
      docWrite("op-exact-queued", "task-exact-queued", "queued.md", "queued exact\n")
    ));
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "short-lived-exact-holder"
    }), "utf8");
    setTimeout(() => rmSync(lockPath, { force: true }), 50);

    const report = await runEffect(coordinator.commitExact(
      "explicit",
      createJournaledBatch([entry])
    ));

    assert.equal(report.watermark, "op-exact-queued");
    assert.equal(report.publicationMode, "exact-batch");
    assert.equal(readFileSync(
      path.join(rootDir, "harness/tasks/task-exact-queued/queued.md"),
      "utf8"
    ), "queued exact\n");
  });
});

test("exact authority batch keeps its authorization after an indeterminate budget exhaustion", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      lockConflictRetry: { maxWaitMs: 1, initialDelayMs: 1, maxDelayMs: 1 }
    });
    const entry = Effect.runSync(coordinator.enqueue(
      docWrite("op-exact-indeterminate", "task-exact-indeterminate", "pending.md", "recoverable exact\n")
    ));
    const batch = createJournaledBatch([entry]);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 10_000,
      hostname: `${hostname()}-foreign`,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "foreign-exact-holder"
    }), "utf8");

    const indeterminate = await runEffect(coordinator.commitExact("explicit", batch));
    assert.equal(isIndeterminateFlushReport(indeterminate), true);
    if (!isIndeterminateFlushReport(indeterminate)) assert.fail("expected an indeterminate exact flush");
    assert.deepEqual(indeterminate.operationIds, ["op-exact-indeterminate"]);

    rmSync(lockPath, { force: true });
    const committed = await runEffect(coordinator.commitExact("explicit", batch));
    assert.equal(isIndeterminateFlushReport(committed), false);
    if (isIndeterminateFlushReport(committed)) assert.fail("expected the preserved authorization to commit");
    assert.equal(committed.watermark, "op-exact-indeterminate");
    assert.equal(committed.publicationMode, "exact-batch");
    assert.equal(readFileSync(
      path.join(rootDir, "harness/tasks/task-exact-indeterminate/pending.md"),
      "utf8"
    ), "recoverable exact\n");
  });
});
