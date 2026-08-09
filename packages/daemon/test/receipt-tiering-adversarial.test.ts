// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthorityOperationReceipt,
  CommandFailureReceipt,
  CommandReceiptSettlement
} from "@harness-anything/application";
import { BoundedAuthorityBatcher } from "../../application/src/authority/authority-batcher.ts";
import type { DaemonAdmissionBudget } from "@harness-anything/kernel";
import { durableAuthoritySubmissionFromSettlement } from "../src/authority/authority-command-submission.ts";
import { createSerialPublicationExecutor } from "../src/authority/production/production-authority-lifecycle.ts";
import {
  reportCurrentAuthorityDurableAcceptance,
  runBeforeBackgroundAuthoritySettlement,
  waitForCurrentAuthoritySettlementRelease
} from "../src/runtime/authority-durable-acceptance-context.ts";
import { enqueueDaemonAuthorityPublication } from "../src/runtime/authority-publication.ts";
import { receiptSettlementVisibilityMatches } from "../src/runtime/repo-write-settlement-protocol.ts";
import { DaemonWriteQueue } from "../src/runtime/write-queue.ts";

test("durable acceptance survives enqueueing behind an already-running queue drain", async () => {
  const queue = new DaemonWriteQueue(1, 0, unlimitedAdmissionBudget());
  const blockerStarted = deferred<void>();
  const unblock = deferred<void>();
  const blocker = queue.enqueueBackground({
    source: "pre-existing-background-work",
    run: async () => {
      blockerStarted.resolve();
      await unblock.promise;
    }
  });
  await blockerStarted.promise;

  let materialized = false;
  const command = runBeforeBackgroundAuthoritySettlement(async () => {
    const durable = durableAuthoritySubmissionFromSettlement(() =>
      enqueueDaemonAuthorityPublication(
        queue,
        {
          sessionId: "session-queued",
          publish: async () => ({
            reason: "explicit",
            opCount: 1,
            committed: true,
            watermark: "op-queued"
          })
        },
        () => {
          materialized = true;
          return {
            dryRun: false,
            merged: 1,
            considered: 1,
            branches: [],
            warnings: [],
            projectionRebuilt: false,
            attributionEventsProjected: 0
          };
        },
        () => "a".repeat(40)
      ).then(() => committedReceipt())
    );
    return durable.admission;
  });

  unblock.resolve();
  await blocker;
  const result = await Promise.race([
    command.then(() => "completed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))
  ]);

  assert.equal(result, "completed");
  await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
  await queue.idle();
  assert.equal(materialized, true);
});

test("settlement status wire accepts a pending failure receipt with partial durable acceptance", () => {
  const pending: Extract<
    CommandReceiptSettlement,
    { readonly canonicalVisibility: "pending" }
  > = {
    schema: "command-receipt-settlement/v1",
    receiptId: "repo-write-direct:op-partial",
    durability: "session-durable",
    canonicalVisibility: "pending",
    acceptedAt: "2026-08-09T10:00:00.000Z",
    sessionId: "session-partial",
    acceptedCommitSha: "a".repeat(40),
    authorityOperationIds: ["op-partial"],
    statusQuery: {
      method: "repo.write.receipt.status",
      command: "ha receipt status repo-write-direct:op-partial --json",
      receiptId: "repo-write-direct:op-partial"
    }
  };
  const receipt: CommandFailureReceipt = {
    ok: false,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "later stage failed after durable acceptance",
    error: { code: "later_stage_failed", hint: "Inspect settlement before retrying." },
    settlement: pending,
    next: [],
    details: {},
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };

  assert.equal(
    receiptSettlementVisibilityMatches(
      receipt as unknown as import("../src/runtime/repo-write-protocol.ts").RepoWriteJsonObject,
      "$.receipt",
      "pending"
    ),
    true
  );
});

test("two batched publications in one command release the serial slot at durable acceptance", async () => {
  const executor = createSerialPublicationExecutor();
  const settled: string[] = [];
  const publications = new BoundedAuthorityBatcher<number, AuthorityOperationReceipt>(
    (indexes) => executor.run(async () => {
      const index = indexes[0]!;
      reportCurrentAuthorityDurableAcceptance(
        `session-${index}`,
        String(index).repeat(40),
        {
          reason: "explicit",
          opCount: 1,
          committed: true,
          watermark: `op-${index}`
        }
      );
      await waitForCurrentAuthoritySettlementRelease();
      settled.push(`op-${index}`);
      return [committedReceipt(`op-${index}`)];
    }),
    8,
    10,
    { allowOverlappingBatches: true }
  );
  const command = runBeforeBackgroundAuthoritySettlement(async () => {
    for (const index of [1, 2]) {
      const durable = durableAuthoritySubmissionFromSettlement(() =>
        publications.run(Promise.resolve(index))
      );
      const admission = await durable.admission;
      assert.equal(admission.kind, "accepted");
    }
    return "accepted" as const;
  });

  assert.equal(await Promise.race([
    command,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))
  ]), "accepted");
  await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(settled, ["op-1", "op-2"]);
});

function committedReceipt(opId = "op-queued"): AuthorityOperationReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: "workspace-adversarial",
    opId,
    semanticDigest: "d".repeat(64),
    revision: 1,
    commitSha: "b".repeat(40),
    previousCommit: null
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function unlimitedAdmissionBudget(): DaemonAdmissionBudget {
  return {
    reserve: () => ({ ok: true, reservation: { release: () => undefined } }),
    snapshot: () => ({
      limits: {
        maxOperations: 10,
        maxBytes: 100_000,
        reservedOperationsPerPlane: 0,
        reservedBytesPerPlane: 0
      },
      used: {
        operations: 0,
        bytes: 0,
        authorityOperations: 0,
        authorityBytes: 0,
        jsonRpcOperations: 0,
        jsonRpcBytes: 0
      },
      rejected: { authority: 0, "json-rpc": 0 }
    })
  };
}
