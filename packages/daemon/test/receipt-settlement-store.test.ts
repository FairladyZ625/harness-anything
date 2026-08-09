// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CommandReceipt,
  CommandReceiptSettlement
} from "@harness-anything/application";
import {
  failedCommandReceiptSettlement,
  pendingCommandReceiptSettlement,
  ReceiptSettlementStore,
  settleDirectAuthorityCommandReceipt,
  visibleCommandReceiptSettlement,
  withCommandReceiptSettlement
} from "../src/index.ts";

test("durable acceptance survives a daemon generation restart", () => {
  withStores(({ directory, first }) => {
    const accepted = acceptedReceipt("receipt-crash", "session-crash", "a");
    first.accept(accepted);

    const restarted = store(directory, 8);
    assert.deepEqual(restarted.lookup("receipt-crash"), {
      schema: "receipt-settlement-record/v1",
      repoId: "repo-settlement",
      workspaceId: "workspace-settlement",
      generation: 7,
      receiptId: "receipt-crash",
      state: "pending",
      receipt: accepted
    });
    assert.deepEqual(
      restarted.listUnsettled().map((record) => record.receiptId),
      ["receipt-crash"]
    );
  });
});

test("concurrent receipts may settle out of acceptance order without crossing identity", () => {
  withStores(({ first }) => {
    const acceptedA = acceptedReceipt("receipt-A", "session-A", "a");
    const acceptedB = acceptedReceipt("receipt-B", "session-B", "b");
    first.accept(acceptedA);
    first.accept(acceptedB);

    first.visible(visibleReceipt(acceptedB, "c", "2026-08-09T10:00:02.000Z"));
    first.fail(failedReceipt(acceptedA, "merge conflict A", "2026-08-09T10:00:03.000Z"));

    assert.equal(first.lookup("receipt-B")?.state, "canonical-visible");
    const failedA = first.lookup("receipt-A");
    assert.equal(failedA?.state, "failed");
    assert.equal(
      failedA?.receipt.settlement?.canonicalVisibility === "failed"
        ? failedA.receipt.settlement.failure.message
        : undefined,
      "merge conflict A"
    );

    first.visible(visibleReceipt(acceptedA, "d", "2026-08-09T10:00:04.000Z"));
    assert.equal(first.lookup("receipt-A")?.state, "canonical-visible");
    assert.equal(first.lookup("receipt-B")?.receiptId, "receipt-B");
  });
});

test("publication proof and evidence failures remain queryable after acceptance", async () => {
  await withStoresAsync(async ({ first }) => {
    for (const [index, failure] of [
      ["proof", "PUBLICATION_PROOF_FAILED: immutable proof mismatch"],
      ["evidence", "EVENT_PUBLICATION_FAILED: evidence fsync failed"]
    ] as const) {
      const opId = `op-${index}`;
      const receiptId = `repo-write-direct:${opId}`;
      const accepted = settleDirectAuthorityCommandReceipt({
        receipt: baseReceipt(receiptId),
        submissions: [{
          acceptance: {
            sessionId: `session-${index}`,
            acceptedCommitSha: "a".repeat(40),
            flush: {
              reason: "explicit",
              opCount: 1,
              committed: true,
              watermark: opId
            }
          },
          settlement: Promise.resolve({
            tag: "INDETERMINATE",
            workspaceId: "workspace-settlement",
            opId,
            semanticDigest: "d".repeat(64),
            reason: failure
          })
        }],
        store: first,
        now: () => new Date("2026-08-09T10:00:05.000Z")
      });
      assert.equal(accepted.ok && accepted.settlement?.canonicalVisibility, "pending");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    const proof = first.lookup("repo-write-direct:op-proof");
    const evidence = first.lookup("repo-write-direct:op-evidence");
    assert.equal(proof?.state, "failed");
    assert.equal(evidence?.state, "failed");
    assert.equal(failureStage(proof), "publication-proof");
    assert.equal(failureStage(evidence), "evidence");
  });
});

test("a command failure after durable admission still returns a queryable receipt", () => {
  withStores(({ first }) => {
    const receipt = settleDirectAuthorityCommandReceipt({
      receipt: {
        ok: false,
        schema: "command-receipt/v2",
        command: "task create",
        action: "create",
        summary: "a later command phase failed",
        error: { code: "later_phase_failed", hint: "Query the durable settlement." },
        meta: {
          generatedAt: "2026-08-09T10:00:00.000Z",
          compatibility: { legacyReceipt: "CommandReceipt/v1" }
        }
      },
      submissions: [{
        acceptance: {
          sessionId: "session-partial-failure",
          acceptedCommitSha: "a".repeat(40),
          flush: {
            reason: "explicit",
            opCount: 1,
            committed: true,
            watermark: "op-partial-failure"
          }
        },
        settlement: new Promise(() => undefined)
      }],
      store: first,
      now: () => new Date("2026-08-09T10:00:05.000Z")
    });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.settlement?.canonicalVisibility, "pending");
    assert.equal(first.lookup("repo-write-direct:op-partial-failure")?.state, "pending");
  });
});

function withStores(
  run: (fixture: { readonly directory: string; readonly first: ReceiptSettlementStore }) => void
): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-settlement-"));
  try {
    run({ directory, first: store(directory, 7) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withStoresAsync(
  run: (fixture: { readonly directory: string; readonly first: ReceiptSettlementStore }) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-settlement-"));
  try {
    await run({ directory, first: store(directory, 7) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function failureStage(record: ReturnType<ReceiptSettlementStore["lookup"]>): string | undefined {
  return record?.receipt.settlement?.canonicalVisibility === "failed"
    ? record.receipt.settlement.failure.stage
    : undefined;
}

function store(directory: string, generation: number): ReceiptSettlementStore {
  return new ReceiptSettlementStore({
    directory,
    repoId: "repo-settlement",
    workspaceId: "workspace-settlement",
    generation
  });
}

function acceptedReceipt(
  receiptId: string,
  sessionId: string,
  shaCharacter: string
): CommandReceipt {
  const settlement = pendingCommandReceiptSettlement({
    receiptId,
    sessionId,
    acceptedAt: "2026-08-09T10:00:01.000Z",
    acceptedCommitSha: shaCharacter.repeat(40)
  });
  const receipt = withCommandReceiptSettlement(baseReceipt(receiptId), settlement);
  if (!receipt.ok) throw new Error("fixture receipt reversed");
  return receipt;
}

function visibleReceipt(
  accepted: CommandReceipt,
  shaCharacter: string,
  settledAt: string
): CommandReceipt {
  const pending = requirePending(accepted);
  const receipt = withCommandReceiptSettlement(
    accepted,
    visibleCommandReceiptSettlement(pending, shaCharacter.repeat(40), settledAt)
  );
  if (!receipt.ok) throw new Error("fixture receipt reversed");
  return receipt;
}

function failedReceipt(
  accepted: CommandReceipt,
  message: string,
  failedAt: string
): CommandReceipt {
  const receipt = withCommandReceiptSettlement(
    accepted,
    failedCommandReceiptSettlement(requirePending(accepted), {
      failedAt,
      stage: "materializer",
      code: "SETTLEMENT_MATERIALIZATION_FAILED",
      message
    })
  );
  if (!receipt.ok) throw new Error("fixture receipt reversed");
  return receipt;
}

function requirePending(receipt: CommandReceipt): Extract<
  CommandReceiptSettlement,
  { readonly canonicalVisibility: "pending" }
> {
  if (receipt.settlement?.canonicalVisibility !== "pending") {
    throw new Error("pending settlement required");
  }
  return receipt.settlement;
}

function baseReceipt(receiptId: string): CommandReceipt {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: `accepted ${receiptId}`,
    next: [],
    details: {},
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}
