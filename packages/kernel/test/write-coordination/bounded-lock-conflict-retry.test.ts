// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/index.ts";
import { docWrite, runEffect, withTempStoreAsync } from "../store/helpers.ts";
import { testWriteAttribution } from "../test-attribution.ts";

test("journal exhausts foreign lock retry without losing the durable write", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 10_000,
      hostname: `${hostname()}-foreign`,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "live-foreign-holder"
    }), "utf8");
    const blocked = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      lockTtlMs: 60_000,
      lockConflictRetry: { maxWaitMs: 1, initialDelayMs: 1, maxDelayMs: 1 }
    });
    Effect.runSync(blocked.enqueue(
      docWrite("op-budget-exhausted", "task-budget-exhausted", "recovered.md", "recovered\n")
    ));

    const result = await runEffect(Effect.either(blocked.flush("explicit")));

    if (result._tag !== "Left") throw new Error("expected retryable lock failure");
    assert.equal(result.left._tag, "GlobalWriteConflict");
    assert.match(result.left.owner ?? "", /automatic retry budget exhausted after 1ms/u);
    assert.match(result.left.owner ?? "", /wait briefly and retry/u);
    assert.match(result.left.owner ?? "", /inspect the current lock holder/u);
    assert.doesNotMatch(result.left.owner ?? "", /HARNESS_DAEMON_MODE=direct|ha daemon restart/u);

    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    assert.match(readFileSync(journalPath, "utf8"), /op-budget-exhausted/u);
    rmSync(lockPath);

    const recovered = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir
    });
    const recovery = await runEffect(recovered.recover);

    assert.equal(recovery.replayedOps, 1);
    assert.equal(recovery.recoveredWatermark, "op-budget-exhausted");
    assert.equal(readFileSync(
      path.join(rootDir, "harness/tasks/task-budget-exhausted/recovered.md"),
      "utf8"
    ), "recovered\n");
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 1);
  });
});
