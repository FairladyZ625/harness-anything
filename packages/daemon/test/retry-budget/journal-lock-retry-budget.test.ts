// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeDaemonLogService, type DaemonLogEntryV1 } from "../../../application/src/index.ts";
import { Effect, type Exit } from "effect";
import { isIndeterminateFlushReport, makeJournaledWriteCoordinator, taskEntityId } from "../../../kernel/src/index.ts";
import { testWriteAttribution } from "../../../kernel/test/test-attribution.ts";
import { createDaemonRetryBudgetSignalSink } from "../../src/observability/daemon-retry-budget-log.ts";

test("journal foreign-committer budget exhaustion returns indeterminate and leaves the WAL recoverable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-journal-visible-retry-"));
  try {
    const records: DaemonLogEntryV1[] = [];
    const logs = makeDaemonLogService({
      store: {
        append: async (entry) => { records.push(entry); },
        read: async () => ({ records, droppedCount: 0 })
      },
      cursorSecret: "journal-visible-retry-secret"
    });
    const context = { repo: { repoId: "repo-journal-visible", canonicalRoot: rootDir } };
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 10_000,
      hostname: `${hostname()}-foreign`,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "foreign-committer"
    }), "utf8");
    const retrySignalSink = createDaemonRetryBudgetSignalSink(logs, context);
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      lockTtlMs: 60_000,
      lockConflictRetry: {
        maxWaitMs: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        reminderEveryFailures: 1
      },
      onLockConflictRetrySignal: (signal) => {
        retrySignalSink(signal);
        // Old behavior continues retrying after exhaustion. Release the lock on
        // that obsolete phase so the pre-fix test fails promptly instead of
        // hanging forever.
        if (signal.phase === "still-retrying") rmSync(lockPath, { force: true });
      }
    });
    Effect.runSync(coordinator.enqueue({
      opId: "op-journal-visible-retry",
      entityId: taskEntityId("task-journal-visible-retry"),
      kind: "doc_write",
      payload: { path: "receipt.md", body: "committed\n" }
    }));

    const report = await runEffect(coordinator.flush("explicit"));
    assert.equal(isIndeterminateFlushReport(report), true);
    if (!isIndeterminateFlushReport(report)) assert.fail("expected an indeterminate flush report");
    assert.deepEqual(report.operationIds, ["op-journal-visible-retry"]);
    assert.equal(report.cause.kind, "foreign-committer");
    if (report.cause.kind !== "foreign-committer") assert.fail("expected foreign-committer coordinates");
    assert.equal(report.cause.lockHolder.status, "observed");
    assert.equal(report.cause.lockHolder.pid, process.pid + 10_000);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const errors = await logs.list({ errorOnly: true }, context);
    assert.ok(errors.entries.some((entry) => entry.event === "retry-budget.exhausted"));
    const all = await logs.list({}, context);
    assert.equal(all.entries.some((entry) => entry.event === "retry-budget.still-retrying"), false);
    assert.equal(all.entries.some((entry) => entry.event === "retry-budget.recovered"), false);

    rmSync(lockPath, { force: true });
    const committed = await runEffect(coordinator.flush("explicit"));
    assert.equal("status" in committed, false);
    if ("status" in committed) assert.fail("expected a determinate flush report");
    assert.equal(committed.committed, true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-journal-visible-retry/receipt.md"), "utf8"), "committed\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await new Promise<Exit.Exit<A, E>>((resolve) => {
    Effect.runCallback(effect, { onExit: resolve });
  });
  if (exit._tag === "Success") return exit.value;
  throw new Error(String(exit.cause));
}
