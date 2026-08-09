// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeDaemonLogService, type DaemonLogEntryV1 } from "../../../application/src/index.ts";
import { Effect, type Exit } from "effect";
import { makeJournaledWriteCoordinator, taskEntityId } from "../../../kernel/src/index.ts";
import { testWriteAttribution } from "../../../kernel/test/test-attribution.ts";
import { createDaemonRetryBudgetSignalSink } from "../../src/observability/daemon-retry-budget-log.ts";

test("journal foreign-committer wait stays receipt-honest and visible after retry budget exhaustion", async () => {
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
      onLockConflictRetrySignal: createDaemonRetryBudgetSignalSink(logs, context)
    });
    Effect.runSync(coordinator.enqueue({
      opId: "op-journal-visible-retry",
      entityId: taskEntityId("task-journal-visible-retry"),
      kind: "doc_write",
      payload: { path: "receipt.md", body: "committed\n" }
    }));

    const release = setTimeout(() => rmSync(lockPath, { force: true }), 25);
    try {
      const report = await runEffect(coordinator.flush("explicit"));
      assert.equal(report.committed, true);
    } finally {
      clearTimeout(release);
      rmSync(lockPath, { force: true });
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const errors = await logs.list({ errorOnly: true }, context);
    assert.ok(errors.entries.some((entry) => entry.event === "retry-budget.exhausted"));
    assert.ok(errors.entries.some((entry) => entry.event === "retry-budget.still-retrying"));
    const all = await logs.list({}, context);
    assert.ok(all.entries.some((entry) => entry.event === "retry-budget.recovered"));
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
