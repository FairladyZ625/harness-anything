// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommandReceiptEnvelope,
  DaemonHostCommand,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import { sha256Text } from "@harness-anything/kernel";
import type { RepoWriteJsonObject } from "../src/runtime/repo-write-protocol.ts";
import {
  defaultTaskCompleteSettlementTimeoutMs,
  dispatchTaskCompleteWithAutoMaterialization,
  verifyTaskCompleteMaterializationSnapshot,
  waitForTaskCompleteCanonicalSettlement
} from "../src/service/task-complete-auto-materialization.ts";

test("task-complete settlement state machine uses the 20s class with bounded backoff", async () => {
  let now = 0;
  const delays: number[] = [];
  const result = await waitForTaskCompleteCanonicalSettlement(
    pendingDocSyncResult(),
    async () => ({ state: "accepted", receipt: {} }),
    {
      timeoutMs: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      }
    }
  );

  assert.equal(defaultTaskCompleteSettlementTimeoutMs, 20_000);
  assert.equal(result.settled, false);
  if (result.settled) return;
  assert.equal(result.code, "task_complete_auto_materialization_settlement_pending");
  assert.equal(result.receiptId, "repo-write:pending");
  assert.equal(result.statusCommand, "ha receipt status repo-write:pending --json");
  assert.deepEqual(result.recoveryArgv, ["ha", "receipt", "status", "repo-write:pending", "--json"]);
  assert.match(result.fix, /Do not resubmit/u);
  assert.ok(delays.length > 1, JSON.stringify(delays));
  assert.deepEqual(delays, [25, 50, 25]);
  assert.equal(delays.reduce((total, delay) => total + delay, 0), 100);
});

test("task-complete settlement lookup failure preserves the known recovery handle", async () => {
  const result = await waitForTaskCompleteCanonicalSettlement(
    pendingDocSyncResult(),
    async () => { throw new Error("writer lookup connection closed"); }
  );

  assert.equal(result.settled, false);
  if (result.settled) return;
  assert.equal(result.code, "task_complete_auto_materialization_settlement_lookup_failed");
  assert.equal(result.reason, "Settlement lookup failed: writer lookup connection closed");
  assert.equal(result.receiptId, "repo-write:pending");
  assert.equal(result.statusCommand, "ha receipt status repo-write:pending --json");
  assert.deepEqual(result.recoveryArgv, ["ha", "receipt", "status", "repo-write:pending", "--json"]);
  assert.match(result.fix, /Do not resubmit/u);
});

test("task-complete settlement failure reports the writer root cause", async () => {
  const result = await waitForTaskCompleteCanonicalSettlement(
    pendingDocSyncResult(),
    async () => ({ state: "settlement-failed", receipt: failedSettlementReceipt() })
  );

  assert.equal(result.settled, false);
  if (result.settled) return;
  assert.equal(result.code, "task_complete_auto_materialization_settlement_failed");
  assert.equal(result.reason, "MATERIALIZER_APPLY_FAILED: canonical merge conflict");
  assert.equal(result.receiptId, "repo-write:pending");
  assert.equal(result.statusCommand, "ha receipt status repo-write:pending --json");
  assert.deepEqual(result.recoveryArgv, ["ha", "receipt", "status", "repo-write:pending", "--json"]);
});

test("task-complete revalidates after obtaining the automatic materialization flight", async () => {
  const target = "work-items/task_01ABC/artifacts/proof, (final).md";
  const receipts = [prepublishReceipt([{ path: target, reason: "missing from HEAD" }]), successReceipt()];
  let materializeCalls = 0;

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-single-flight",
    autoMaterialize: async () => {
      materializeCalls += 1;
      return { ok: true, paths: [target] };
    },
    dispatch: async () => receipts.shift() ?? successReceipt()
  });

  assert.equal(result.ok, true);
  assert.equal(materializeCalls, 0);
  assert.equal(receipts.length, 0);
});

test("task-complete revalidates a no-candidate result before failing", async () => {
  const target = "work-items/task_01ABC/closeout.md";
  const failure = prepublishReceipt([{ path: target, reason: "content differs from expected" }]);
  const receipts = [failure, failure, successReceipt()];

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-no-candidate",
    autoMaterialize: async () => ({
      ok: false,
      code: "task_complete_auto_materialization_no_candidate",
      hint: "no candidate",
      files: []
    }),
    dispatch: async () => receipts.shift() ?? successReceipt()
  });

  assert.equal(result.ok, true);
  assert.equal(receipts.length, 0);
});

test("task-complete failure receipt has exact per-file recovery argv", async () => {
  const target = "work-items/task_01ABC/task plan (final).md";
  const failure = prepublishReceipt([{ path: target, reason: "content differs from expected" }]);
  const receipts = [failure, failure];

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-failure-schema",
    autoMaterialize: async () => ({
      ok: false,
      code: "task_complete_auto_materialization_submit_failed",
      hint: "rejected",
      files: [{
        path: target,
        reason: "SEMANTIC_DIFF_REQUIRED: managed heading changed",
        fix: `Run \`ha doc sync --submit --path '${target}'\`.`,
        fixArgv: ["ha", "doc", "sync", "--submit", "--path", target]
      }]
    }),
    dispatch: async () => receipts.shift() ?? failure
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error?.code, "task_complete_auto_materialization_submit_failed");
  assert.deepEqual(result.details?.data, {
    schema: "task-complete-auto-materialization-failure/v1",
    files: [{
      path: target,
      reason: "SEMANTIC_DIFF_REQUIRED: managed heading changed",
      fix: `Run \`ha doc sync --submit --path '${target}'\`.`,
      fixArgv: ["ha", "doc", "sync", "--submit", "--path", target]
    }]
  });
});

test("task-complete reports malformed structured prepublish details explicitly", async () => {
  const malformed = prepublishReceipt([], { schema: "wrong/v1", code: "wrong", files: "not-an-array" });
  const receipts = [malformed, malformed];
  let materializeCalls = 0;

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-malformed-prepublish",
    autoMaterialize: async () => {
      materializeCalls += 1;
      return { ok: true, paths: [] };
    },
    dispatch: async () => receipts.shift() ?? malformed
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(materializeCalls, 0);
  assert.equal(result.error?.code, "task_complete_auto_materialization_prepublish_details_invalid");
  assert.equal(result.details?.data?.schema, "task-complete-auto-materialization-failure/v1");
  assert.deepEqual(result.details?.data?.files, []);
  assert.match(String(result.details?.data?.reason), /structured prepublish details/u);
});

test("task-complete rejects a working-tree body changed after candidate capture", () => {
  const snapshot = [{
    path: "work-items/task_01ABC/closeout.md",
    baseBlobSha256: "base",
    body: "caller A body\n",
    bodySha256: sha256Text("caller A body\n"),
    mediaType: "text/markdown",
    size: 14,
    pathClass: "doc-sync-allowed"
  }];

  assert.deepEqual(
    verifyTaskCompleteMaterializationSnapshot(snapshot, () => "caller B body\n"),
    {
      path: "work-items/task_01ABC/closeout.md",
      expectedBodySha256: sha256Text("caller A body\n"),
      actualBodySha256: sha256Text("caller B body\n")
    }
  );
});

test("task-complete reports only the remaining files after partial materialization", async () => {
  const artifact = "work-items/task_01ABC/artifacts/proof.md";
  const prose = "work-items/task_01ABC/task plan (final).md";
  const both = prepublishReceipt([
    { path: artifact, reason: "missing from HEAD" },
    { path: prose, reason: "content differs from expected" }
  ]);
  const remaining = prepublishReceipt([{ path: prose, reason: "content differs from expected" }]);
  const receipts = [both, both, remaining];

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-partial",
    autoMaterialize: async () => ({ ok: true, paths: [artifact] }),
    dispatch: async () => receipts.shift() ?? remaining
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error?.code, "task_complete_auto_materialization_incomplete");
  const data = result.details?.data as {
    readonly schema?: unknown;
    readonly files?: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(data.schema, "task-complete-auto-materialization-failure/v1");
  assert.equal(data.files?.length, 1);
  assert.equal(data.files?.[0]?.path, prose);
  assert.equal(data.files?.[0]?.reason, "content differs from expected");
  assert.equal(
    data.files?.[0]?.fix,
    `Run \`ha doc sync --submit --path '${prose}'\` after repairing this file, then retry task completion.`
  );
  assert.deepEqual(data.files?.[0]?.fixArgv, ["ha", "doc", "sync", "--submit", "--path", prose]);
});

test("task-complete single-flight serializes materialization and lets the waiter revalidate", async () => {
  const target = "work-items/task_01ABC/closeout.md";
  const failure = prepublishReceipt([{ path: target, reason: "content differs from expected" }]);
  const firstReceipts = [failure, failure, successReceipt()];
  const secondReceipts = [failure, successReceipt()];
  let releaseMaterializer!: () => void;
  let announceMaterializer!: () => void;
  const materializerStarted = new Promise<void>((resolve) => { announceMaterializer = resolve; });
  const holdMaterializer = new Promise<void>((resolve) => { releaseMaterializer = resolve; });
  let materializeCalls = 0;
  const autoMaterialize = async () => {
    materializeCalls += 1;
    announceMaterializer();
    await holdMaterializer;
    return { ok: true as const, paths: [target] };
  };

  const first = dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-concurrent",
    autoMaterialize,
    dispatch: async () => firstReceipts.shift() ?? successReceipt()
  });
  await materializerStarted;
  const second = dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-concurrent",
    autoMaterialize,
    dispatch: async () => secondReceipts.shift() ?? successReceipt()
  });
  releaseMaterializer();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((entry) => entry.ok), [true, true]);
  assert.equal(materializeCalls, 1);
  assert.equal(firstReceipts.length, 0);
  assert.equal(secondReceipts.length, 0);
});

test("task-complete legacy text fallback accepts layout-derived paths with punctuation", async () => {
  const target = "work-items/task_01ABC/artifacts/proof, (final).md";
  const legacy = legacyPrepublishReceipt(target, "missing from HEAD");
  const receipts = [legacy, legacy, successReceipt()];
  let observed: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [];

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-legacy-fallback",
    autoMaterialize: async (input) => {
      observed = input.prepublishFailures;
      return {
        ok: false,
        code: "task_complete_auto_materialization_no_candidate",
        hint: "already materialized",
        files: []
      };
    },
    dispatch: async () => receipts.shift() ?? successReceipt()
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [{ path: target, reason: "missing from HEAD" }]);
});

test("task-complete classifies an unexpected materializer exception as internal", async () => {
  const target = "work-items/task_01ABC/closeout.md";
  const failure = prepublishReceipt([{ path: target, reason: "content differs from expected" }]);
  const receipts = [failure, failure];

  const result = await dispatchTaskCompleteWithAutoMaterialization({
    ...dispatchContext(),
    repoId: "repo-internal-failure",
    autoMaterialize: async () => { throw new Error("unexpected programmer defect"); },
    dispatch: async () => receipts.shift() ?? failure
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error?.code, "task_complete_auto_materialization_internal");
  const data = result.details?.data as { readonly files?: ReadonlyArray<Record<string, unknown>> };
  assert.equal(data.files?.[0]?.path, target);
  assert.match(String(data.files?.[0]?.reason), /unexpected programmer defect/u);
  assert.deepEqual(data.files?.[0]?.fixArgv, ["ha", "daemon", "logs", "--json"]);
  assert.doesNotMatch(String(data.files?.[0]?.fix), /doc sync --submit/u);
});

function pendingDocSyncResult(): Extract<DocSyncSubmitResultV1, { readonly ok: true }> {
  return {
    ok: true,
    schema: "daemon.doc-sync-submit-result/v1",
    status: "accepted",
    intentId: "intent_pending",
    baseLedgerSha: "base",
    appliedLedgerSha: "accepted",
    appliedChanges: [],
    settlement: {
      schema: "command-receipt-settlement/v1",
      receiptId: "repo-write:pending",
      durability: "session-durable",
      canonicalVisibility: "pending",
      acceptedAt: "2026-08-10T00:00:00.000Z",
      sessionId: "session-pending",
      acceptedCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      statusQuery: {
        method: "repo.write.receipt.status",
        command: "ha receipt status repo-write:pending --json",
        receiptId: "repo-write:pending"
      }
    }
  };
}

function failedSettlementReceipt(): RepoWriteJsonObject {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "repo.doc.sync.submit",
    action: "submit",
    summary: "canonical settlement failed",
    error: { code: "repo_write_settlement_failed", hint: "inspect the settlement" },
    settlement: {
      schema: "command-receipt-settlement/v1",
      receiptId: "repo-write:pending",
      durability: "session-durable",
      canonicalVisibility: "failed",
      acceptedAt: "2026-08-10T00:00:00.000Z",
      sessionId: "session-pending",
      acceptedCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      failedAt: "2026-08-10T00:00:01.000Z",
      failure: {
        stage: "materializer",
        code: "MATERIALIZER_APPLY_FAILED",
        message: "canonical merge conflict",
        retryable: true,
        recoveryCommand: "ha materializer run --json"
      },
      statusQuery: {
        method: "repo.write.receipt.status",
        command: "ha receipt status repo-write:pending --json",
        receiptId: "repo-write:pending"
      }
    },
    meta: {
      generatedAt: "2026-08-10T00:00:01.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function dispatchContext() {
  return {
    command: {
      action: { kind: "task-complete", taskId: "task_01ABC", dryRun: false }
    } as unknown as DaemonHostCommand,
    currentSession: { source: "manual" as const },
    actor: { kind: "human", id: "actor-test" } as never,
    executor: null,
    authorityConnection: {
      available: true as const,
      context: {} as never,
      assertActive: () => undefined
    }
  };
}

function prepublishReceipt(
  files: ReadonlyArray<{ readonly path: string; readonly reason: string }>,
  data: unknown = {
    schema: "task-complete-prepublish-failure/v1",
    code: "task_complete_prepublish_not_materialized",
    files
  }
): CommandReceiptEnvelope {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "task-complete",
    action: "run",
    summary: "task completion prepublish rejected",
    error: { code: "task_complete_prepublish_not_materialized", hint: "structured details attached" },
    details: { data: data as never },
    meta: {
      generatedAt: "2026-08-10T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function successReceipt(): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "task-complete",
    action: "run",
    summary: "completed",
    next: [],
    meta: {
      generatedAt: "2026-08-10T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function legacyPrepublishReceipt(pathValue: string, reason: string): CommandReceiptEnvelope {
  const message = `AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${pathValue} (${reason})`;
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "task-complete",
    action: "run",
    summary: message,
    error: { code: "authority_ingress_rejected", hint: message },
    meta: {
      generatedAt: "2026-08-10T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}
