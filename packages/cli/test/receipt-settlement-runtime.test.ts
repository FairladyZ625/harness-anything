// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  ReceiptSettlementStore,
  pendingCommandReceiptSettlement,
  withCommandReceiptSettlement,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import {
  createReceiptSettlementRecoveryLoop,
  recoverPendingSettlementMaterialization
} from "../src/composition/receipt-settlement-runtime.ts";
import { createRepoWriteChildPostReadyRecovery } from "../src/composition/repo-write-child-post-ready-recovery.ts";

const durableSettlementStore = {
  skip: process.platform === "win32"
    ? "durable generation publication is unsupported on Windows"
    : false
};

test("a restarted writer recovers durable acceptance after a materializer crash", durableSettlementStore, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-recovery-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot);
    git(authoredRoot, "init");
    git(authoredRoot, "config", "user.name", "Receipt Recovery");
    git(authoredRoot, "config", "user.email", "receipt-recovery@example.test");
    writeFileSync(path.join(authoredRoot, "README.md"), "canonical\n");
    git(authoredRoot, "add", "README.md");
    git(authoredRoot, "commit", "-m", "canonical base");
    const acceptedCommitSha = git(authoredRoot, "rev-parse", "HEAD");
    const directory = path.join(root, "settlements");
    const first = settlementStore(directory, 1);
    const pending = pendingCommandReceiptSettlement({
      receiptId: "repo-write-direct:op-crash",
      acceptedAt: "2026-08-09T10:00:00.000Z",
      sessionId: "session-crash",
      acceptedCommitSha,
      authorityOperationIds: ["op-crash"]
    });
    const accepted = withCommandReceiptSettlement({
      ok: true,
      schema: "command-receipt/v2",
      command: "task create",
      action: "create",
      summary: "accepted before crash",
      next: [],
      details: {},
      meta: {
        generatedAt: "2026-08-09T10:00:00.000Z",
        compatibility: { legacyReceipt: "CommandReceipt/v1" }
      }
    }, pending);
    if (!accepted.ok) throw new Error("fixture receipt reversed");
    first.accept(accepted);

    const restarted = settlementStore(directory, 2);
    let materializerAttempts = 0;
    const runtime = {
      enqueueMaterializerBatch: async () => {
        materializerAttempts += 1;
        if (materializerAttempts === 1) throw new Error("merge conflict after daemon crash");
        return {
          ok: true,
          schema: "command-receipt/v2",
          command: "materializer run",
          action: "run",
          summary: "materialized",
          next: [],
          details: {},
          meta: {
            generatedAt: "2026-08-09T10:00:01.000Z",
            compatibility: { legacyReceipt: "CommandReceipt/v1" }
          }
        };
      }
    } as unknown as HarnessDaemonRuntime;
    const outcomes = new DurableRepoWriteOutcomeStoreV1({
      directory: path.join(root, "outcomes"),
      repoId: "canonical",
      workspaceId: "workspace-recovery",
      generation: 2
    });
    const recover = () => recoverPendingSettlementMaterialization({
      settlements: restarted,
      outcomes,
      runtime,
      authoredRoot,
      deadlineAt: Date.now() + 10_000,
      recoverCommittedReceipt: async (opId) => ({
        tag: "COMMITTED",
        workspaceId: "workspace-recovery",
        opId,
        semanticDigest: "d".repeat(64),
        revision: 1,
        commitSha: acceptedCommitSha,
        previousCommit: null
      })
    });

    await recover();
    const failed = restarted.lookup(pending.receiptId);
    assert.equal(failed?.state, "failed");
    assert.equal(
      failed?.receipt.settlement?.canonicalVisibility === "failed"
        ? failed.receipt.settlement.failure.stage
        : undefined,
      "materializer"
    );

    await recover();
    assert.equal(restarted.lookup(pending.receiptId)?.state, "canonical-visible");
    assert.equal(materializerAttempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("continuous settlement recovery keeps sweeping after READY until backlog clears", async () => {
  let remaining = 2;
  const loop = createReceiptSettlementRecoveryLoop({
    intervalMs: 5,
    recover: async () => {
      remaining = Math.max(0, remaining - 1);
    }
  });
  try {
    const deadline = Date.now() + 500;
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(remaining, 0);
  } finally {
    loop.stop();
  }
});

test("generic authority pending is promoted from canonical ancestry even before outer terminal repair", durableSettlementStore, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generic-receipt-recovery-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot);
    git(authoredRoot, "init");
    git(authoredRoot, "config", "user.name", "Receipt Recovery");
    git(authoredRoot, "config", "user.email", "receipt-recovery@example.test");
    writeFileSync(path.join(authoredRoot, "README.md"), "canonical\n");
    git(authoredRoot, "add", "README.md");
    git(authoredRoot, "commit", "-m", "canonical base");
    const acceptedCommitSha = git(authoredRoot, "rev-parse", "HEAD");
    const settlements = settlementStore(path.join(root, "settlements"), 2);
    const pending = pendingCommandReceiptSettlement({
      receiptId: "repo-write:generic-pending",
      acceptedAt: "2026-08-09T10:00:00.000Z",
      sessionId: "session-generic",
      acceptedCommitSha,
      authorityOperationIds: ["op-generic"]
    });
    settlements.accept(withCommandReceiptSettlement({
      ok: true,
      schema: "command-receipt/v2",
      command: "task create",
      action: "create",
      summary: "accepted",
      next: [],
      meta: {
        generatedAt: "2026-08-09T10:00:00.000Z",
        compatibility: { legacyReceipt: "CommandReceipt/v1" }
      }
    }, pending));
    const outcomes = new DurableRepoWriteOutcomeStoreV1({
      directory: path.join(root, "outcomes"),
      repoId: "canonical",
      workspaceId: "workspace-recovery",
      generation: 2
    });
    const runtime = {
      enqueueMaterializerBatch: async () => ({ branches: [] })
    } as unknown as HarnessDaemonRuntime;

    await recoverPendingSettlementMaterialization({
      settlements,
      outcomes,
      runtime,
      authoredRoot,
      deadlineAt: Date.now() + 10_000,
      recoverCommittedReceipt: async () => { throw new Error("not needed"); }
    });

    assert.equal(settlements.lookup(pending.receiptId)?.state, "canonical-visible");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a poisoned receipt times out without blocking later settlement recovery", durableSettlementStore, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-poison-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot);
    git(authoredRoot, "init");
    git(authoredRoot, "config", "user.name", "Receipt Recovery");
    git(authoredRoot, "config", "user.email", "receipt-recovery@example.test");
    writeFileSync(path.join(authoredRoot, "README.md"), "canonical\n");
    git(authoredRoot, "add", "README.md");
    git(authoredRoot, "commit", "-m", "canonical base");
    const acceptedCommitSha = git(authoredRoot, "rev-parse", "HEAD");
    const settlements = settlementStore(path.join(root, "settlements"), 2);
    const poisonReceiptId = "repo-write-direct:00-poison";
    const healthyReceiptId = "repo-write:01-healthy";
    acceptPending(settlements, {
      receiptId: poisonReceiptId,
      sessionId: "session-poison",
      acceptedCommitSha,
      authorityOperationIds: ["op-poison"]
    });
    acceptPending(settlements, {
      receiptId: healthyReceiptId,
      sessionId: "session-healthy",
      acceptedCommitSha,
      authorityOperationIds: ["op-healthy"]
    });
    const outcomes = new DurableRepoWriteOutcomeStoreV1({
      directory: path.join(root, "outcomes"),
      repoId: "canonical",
      workspaceId: "workspace-recovery",
      generation: 2
    });
    const runtime = {
      enqueueMaterializerBatch: async () => ({ branches: [] })
    } as unknown as HarnessDaemonRuntime;
    const progress: Array<{
      readonly receiptId: string;
      readonly phase: string;
      readonly status: string;
    }> = [];

    await Promise.race([
      recoverPendingSettlementMaterialization({
        settlements,
        outcomes,
        runtime,
        authoredRoot,
        deadlineAt: Date.now() + 1_000,
        perReceiptTimeoutMs: 25,
        onReceiptProgress: (event) => progress.push(event),
        recoverCommittedReceipt: async (opId) => {
          if (opId === "op-poison") return new Promise(() => undefined);
          throw new Error(`unexpected authority recovery: ${opId}`);
        }
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("settlement sweep did not skip poison receipt")), 250);
      })
    ]);

    assert.equal(settlements.lookup(poisonReceiptId)?.state, "pending");
    assert.equal(settlements.lookup(healthyReceiptId)?.state, "canonical-visible");
    const timeout = progress.find((event) =>
      event.receiptId === poisonReceiptId && event.status === "timed-out");
    assert.deepEqual(timeout, {
      receiptId: poisonReceiptId,
      phase: "authority-receipt",
      status: "timed-out"
    });
    assert.ok(progress.findIndex((event) => event === timeout)
      < progress.findIndex((event) =>
        event.receiptId === healthyReceiptId && event.status === "visible"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-READY recovery backs off a poisoned receipt for the rest of the writer generation", durableSettlementStore, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-generation-backoff-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot);
    git(authoredRoot, "init");
    git(authoredRoot, "config", "user.name", "Receipt Recovery");
    git(authoredRoot, "config", "user.email", "receipt-recovery@example.test");
    writeFileSync(path.join(authoredRoot, "README.md"), "canonical\n");
    git(authoredRoot, "add", "README.md");
    git(authoredRoot, "commit", "-m", "canonical base");
    const acceptedCommitSha = git(authoredRoot, "rev-parse", "HEAD");
    const settlements = settlementStore(path.join(root, "settlements"), 7);
    acceptPending(settlements, {
      receiptId: "repo-write-direct:poison-generation",
      sessionId: "session-poison-generation",
      acceptedCommitSha,
      authorityOperationIds: ["op-poison-generation"]
    });
    const outcomes = new DurableRepoWriteOutcomeStoreV1({
      directory: path.join(root, "outcomes"),
      repoId: "canonical",
      workspaceId: "workspace-recovery",
      generation: 7
    });
    let authorityAttempts = 0;
    const recovery = createRepoWriteChildPostReadyRecovery({
      repoId: "canonical",
      generation: 7,
      transport: { send: async () => undefined } as never,
      settlements,
      outcomes,
      runtime: {
        enqueueMaterializerBatch: async () => ({ branches: [] })
      } as unknown as HarnessDaemonRuntime,
      authoredRoot,
      recoveryGate: {
        recoverHistoricalProceeding: async () => ({ disposition: "deferred" })
      } as never,
      recoverCommittedReceipt: async () => {
        authorityAttempts += 1;
        return new Promise(() => undefined);
      },
      recoverCanonicalPublication: async () => "blocked",
      totalBudgetMs: 100,
      perReceiptTimeoutMs: 10
    });

    await recovery.recoverSettlements();
    await recovery.recoverSettlements();

    assert.equal(authorityAttempts, 1);
    assert.equal(settlements.lookup("repo-write-direct:poison-generation")?.state, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-READY recovery leaves a receipt with a live settlement owner alone", durableSettlementStore, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-live-owner-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot);
    git(authoredRoot, "init");
    git(authoredRoot, "config", "user.name", "Receipt Recovery");
    git(authoredRoot, "config", "user.email", "receipt-recovery@example.test");
    writeFileSync(path.join(authoredRoot, "README.md"), "canonical\n");
    git(authoredRoot, "add", "README.md");
    git(authoredRoot, "commit", "-m", "canonical base");
    const acceptedCommitSha = git(authoredRoot, "rev-parse", "HEAD");
    const settlements = settlementStore(path.join(root, "settlements"), 8);
    const receiptId = "repo-write-direct:live-owner";
    acceptPending(settlements, {
      receiptId,
      sessionId: "session-live-owner",
      acceptedCommitSha,
      authorityOperationIds: ["op-live-owner"]
    });
    const outcomes = new DurableRepoWriteOutcomeStoreV1({
      directory: path.join(root, "outcomes"),
      repoId: "canonical",
      workspaceId: "workspace-recovery",
      generation: 8
    });
    let live = true;
    let authorityAttempts = 0;
    const recovery = createRepoWriteChildPostReadyRecovery({
      repoId: "canonical",
      generation: 8,
      transport: { send: async () => undefined } as never,
      settlements,
      outcomes,
      runtime: {
        enqueueMaterializerBatch: async () => ({ branches: [] })
      } as unknown as HarnessDaemonRuntime,
      authoredRoot,
      recoveryGate: {
        recoverHistoricalProceeding: async () => ({ disposition: "deferred" })
      } as never,
      isSettlementActive: (candidate) => live && candidate === receiptId,
      recoverCommittedReceipt: async (opId) => {
        authorityAttempts += 1;
        return {
          tag: "COMMITTED",
          workspaceId: "workspace-recovery",
          opId,
          semanticDigest: "d".repeat(64),
          revision: 1,
          commitSha: acceptedCommitSha,
          previousCommit: null
        };
      },
      recoverCanonicalPublication: async () => "blocked"
    });

    await recovery.recoverSettlements();
    assert.equal(authorityAttempts, 0);
    assert.equal(settlements.lookup(receiptId)?.state, "pending");

    live = false;
    await recovery.recoverSettlements();
    assert.equal(authorityAttempts, 1);
    assert.equal(settlements.lookup(receiptId)?.state, "canonical-visible");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function acceptPending(
  settlements: ReceiptSettlementStore,
  input: {
    readonly receiptId: string;
    readonly sessionId: string;
    readonly acceptedCommitSha: string;
    readonly authorityOperationIds: ReadonlyArray<string>;
  }
): void {
  const pending = pendingCommandReceiptSettlement({
    receiptId: input.receiptId,
    acceptedAt: "2026-08-09T10:00:00.000Z",
    sessionId: input.sessionId,
    acceptedCommitSha: input.acceptedCommitSha,
    authorityOperationIds: input.authorityOperationIds
  });
  settlements.accept(withCommandReceiptSettlement({
    ok: true,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "accepted",
    next: [],
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  }, pending));
}

function settlementStore(directory: string, generation: number): ReceiptSettlementStore {
  return new ReceiptSettlementStore({
    directory,
    repoId: "canonical",
    workspaceId: "workspace-recovery",
    generation
  });
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
