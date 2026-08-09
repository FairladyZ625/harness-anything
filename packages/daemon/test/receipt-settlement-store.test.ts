// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const durableSettlementStore = {
  skip: process.platform === "win32"
    ? "durable generation publication is unsupported on Windows"
    : false
};

test("durable acceptance survives a daemon generation restart", durableSettlementStore, () => {
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

test("concurrent receipts may settle out of acceptance order without crossing identity", durableSettlementStore, () => {
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

test("publication proof and evidence failures remain queryable after acceptance", durableSettlementStore, async () => {
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

test("a command failure after durable admission still returns a queryable receipt", durableSettlementStore, () => {
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

test("corrupt failure evidence is skipped with a warning while valid settlement truth remains queryable", durableSettlementStore, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-settlement-corrupt-"));
  const warnings: string[] = [];
  try {
    const receipts = new ReceiptSettlementStore({
      directory,
      repoId: "repo-settlement",
      workspaceId: "workspace-settlement",
      generation: 7,
      onWarning: (warning) => warnings.push(warning)
    });
    const accepted = acceptedReceipt("receipt-corrupt-failure", "session-corrupt", "a");
    receipts.accept(accepted);
    receipts.fail(failedReceipt(accepted, "valid failure", "2026-08-09T10:00:03.000Z"));
    const valid = readdirSync(directory).find((name) => name.includes(".failure."));
    assert.ok(valid);
    const corrupt = path.join(directory, valid.replace(/\.json$/u, ".corrupt.json"));
    writeFileSync(corrupt, "{broken\n", { mode: 0o600 });
    chmodSync(corrupt, 0o600);

    const current = receipts.lookup("receipt-corrupt-failure");

    assert.equal(current?.state, "failed");
    assert.match(warnings.join("\n"), /RECEIPT_SETTLEMENT_FAILURE_SKIPPED/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an in-process receipt with undefined values persists as parseable JSON", durableSettlementStore, () => {
  withStores(({ directory, first }) => {
    // Direct-mode receipts never cross a JSON round-trip, so undefined-valued
    // keys reach the sidecar writer verbatim. The serializer used to emit the
    // literal text `undefined`, corrupting the record on disk.
    const accepted = acceptedReceipt("receipt-undefined-values", "session-undefined", "a");
    const poisoned = {
      ...accepted,
      details: { report: { module: undefined, preset: "standard-task" } }
    } as unknown as CommandReceipt;
    first.accept(poisoned);

    for (const name of readdirSync(directory)) {
      const text = readFileSync(path.join(directory, name), "utf8");
      assert.doesNotThrow(() => JSON.parse(text), `sidecar ${name} must be valid JSON`);
    }
    assert.equal(first.lookup("receipt-undefined-values")?.state, "pending");
  });
});

test("a corrupt accepted sidecar is skipped by the recovery sweep and reported as typed corruption", durableSettlementStore, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-receipt-settlement-"));
  const warnings: string[] = [];
  try {
    const receipts = new ReceiptSettlementStore({
      directory,
      repoId: "repo-settlement",
      workspaceId: "workspace-settlement",
      generation: 7,
      onWarning: (warning) => warnings.push(warning)
    });
    const healthy = acceptedReceipt("receipt-healthy", "session-healthy", "a");
    receipts.accept(healthy);
    const corruptName = `receipt-settlement-v1.${"0".repeat(64)}.accepted.json`;
    writeFileSync(path.join(directory, corruptName), "{\"module\":undefined,\n", { mode: 0o600 });
    chmodSync(path.join(directory, corruptName), 0o600);

    // One unreadable acceptance must not halt settlement for every receipt.
    assert.deepEqual(
      receipts.listUnsettled().map((record) => record.receiptId),
      ["receipt-healthy"]
    );
    assert.match(warnings.join("\n"), /RECEIPT_SETTLEMENT_PENDING_SKIPPED/u);

    // A direct lookup of the broken record reports typed corruption, not a
    // raw JSON SyntaxError leaked through the daemon boundary.
    const key = createHash("sha256").update("receipt-healthy", "utf8").digest("hex");
    const target = path.join(directory, `receipt-settlement-v1.${key}.visible.json`);
    writeFileSync(target, "{\"module\":undefined,\n", { mode: 0o600 });
    chmodSync(target, 0o600);
    assert.throws(
      () => receipts.lookup("receipt-healthy"),
      /RECEIPT_SETTLEMENT_CORRUPT/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failure history is compacted to a bounded number of evidence files", durableSettlementStore, () => {
  withStores(({ directory, first }) => {
    const accepted = acceptedReceipt("receipt-bounded-failures", "session-bounded", "a");
    first.accept(accepted);
    for (let index = 0; index < 12; index += 1) {
      first.fail(failedReceipt(
        accepted,
        `failure ${index}`,
        `2026-08-09T10:00:${String(index).padStart(2, "0")}.000Z`
      ));
    }
    assert.ok(readdirSync(directory).filter((name) => name.includes(".failure.")).length <= 8);
    assert.equal(first.lookup("receipt-bounded-failures")?.state, "failed");
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
