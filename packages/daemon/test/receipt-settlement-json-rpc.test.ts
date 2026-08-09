// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import type { RepoWriteJsonObject } from "../src/runtime/repo-write-protocol.ts";
import {
  pendingCommandReceiptSettlement,
  withCommandReceiptSettlement
} from "../src/index.ts";
import {
  emptyLocalController,
  makeServer,
  readFixture,
  resultReceipt
} from "./json-rpc-protocol-fixtures.ts";

test("receipt settlement status returns the durable writer lookup state", async () => {
  const acceptedReceipt = withCommandReceiptSettlement({
    ok: true,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "accepted task create",
    next: [],
    details: {},
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  }, pendingCommandReceiptSettlement({
    receiptId: "repo-write:rpc-status",
    acceptedAt: "2026-08-09T10:00:01.000Z",
    sessionId: "session-rpc-status",
    acceptedCommitSha: "a".repeat(40)
  }));
  if (!acceptedReceipt.ok) throw new Error("fixture receipt reversed");
  const server = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      ReceiptSettlementService: {
        lookup: async () => ({
          state: "accepted",
          receipt: acceptedReceipt as unknown as RepoWriteJsonObject
        })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));
  const response = await server.handle({
    jsonrpc: "2.0",
    id: "receipt-status",
    method: "repo.write.receipt.status",
    params: {
      repo: { repoId: "canonical" },
      payload: { receiptId: "repo-write:rpc-status" }
    }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, "repo.write.receipt.status");
  assert.equal(receipt.details.data.state, "accepted");
  assert.equal(receipt.details.data.receipt.settlement.canonicalVisibility, "pending");
});
