// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeDaemonLogService, type DaemonLogEntryV1 } from "../../../application/src/index.ts";
import { createDaemonRetryBudgetSignalSink } from "../../src/observability/daemon-retry-budget-log.ts";
import { createRepoWriteRetryBudgetSignalSink } from "../../src/observability/repo-write-retry-budget-log.ts";

test("daemon error log retains entry and periodic retry-budget escalation while recovery continues", async () => {
  const records: DaemonLogEntryV1[] = [];
  const logs = makeDaemonLogService({
    store: {
      append: async (entry) => { records.push(entry); },
      read: async () => ({ records, droppedCount: 0 })
    },
    cursorSecret: "retry-budget-test-secret"
  });
  const context = { repo: { repoId: "repo-visible", canonicalRoot: "/repo/visible" } };
  const sink = createDaemonRetryBudgetSignalSink(logs, context);
  const event = {
    operation: "remote-read-down-recovery",
    cause: new Error("authority unavailable"),
    failures: 6,
    retriesUsed: 5,
    elapsedMs: 50,
    remainingMs: undefined
  };

  sink({ phase: "exhausted", event });
  sink({ phase: "still-retrying", event: { ...event, failures: 11, retriesUsed: 10, elapsedMs: 100 } });
  sink({ phase: "recovered", event: { ...event, failures: 12, retriesUsed: 11, elapsedMs: 110 } });

  const errors = await logs.list({ errorOnly: true }, context);
  assert.deepEqual(
    errors.entries.map((entry) => entry.event).sort(),
    ["retry-budget.exhausted", "retry-budget.still-retrying"]
  );
  assert.ok(errors.entries.every((entry) => entry.level === "error"));
  const all = await logs.list({}, context);
  assert.ok(all.entries.some((entry) => entry.event === "retry-budget.recovered" && entry.level === "info"));
});

test("repo-write IPC retry-budget frames retain production error-log visibility", async () => {
  const records: DaemonLogEntryV1[] = [];
  const logs = makeDaemonLogService({
    store: {
      append: async (entry) => { records.push(entry); },
      read: async () => ({ records, droppedCount: 0 })
    },
    cursorSecret: "repo-write-retry-budget-test-secret"
  });
  const context = { repo: { repoId: "repo-writer", canonicalRoot: "/repo/writer" } };
  const sink = createRepoWriteRetryBudgetSignalSink(logs, context);

  sink({
    protocol: "harness-repo-write-ipc/v1",
    repoId: "repo-writer",
    generation: 3,
    kind: "retry-budget-signal",
    phase: "exhausted",
    operation: "publication-git-object-batch",
    cause: "GitObjectBatchValidationError: batch response was offset",
    failures: 2,
    retriesUsed: 1,
    elapsedMs: 14
  });

  const errors = await logs.list({ errorOnly: true }, context);
  assert.deepEqual(errors.entries.map((entry) => ({
    event: entry.event,
    component: entry.component,
    errorCode: entry.errorCode
  })), [{
    event: "retry-budget.exhausted",
    component: "retry-budget",
    errorCode: "RETRY_BUDGET_EXHAUSTED"
  }]);
});
