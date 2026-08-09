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
import { recoverPendingSettlementMaterialization } from "../src/composition/receipt-settlement-runtime.ts";

test("a restarted writer recovers durable acceptance after a materializer crash", async () => {
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
