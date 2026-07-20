// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CompoundOperationReceipt } from "@harness-anything/application";
import { renderCompoundCliExit } from "../src/receipt/exit.ts";

const golden = JSON.parse(readFileSync(new URL("../../daemon/test/fixtures/batch4-equivalence-golden.json", import.meta.url), "utf8")) as Record<string, string>;

test("compound INTERNAL_ERROR and terminal receipt retain origin/main bytes", () => {
  assert.equal(JSON.stringify(renderCompoundCliExit({ kind: "INTERNAL_ERROR" })), golden.compoundInternalError);
  const receipt = {
    workspaceId: "workspace-golden",
    viewId: "view-golden",
    opId: "op-golden",
    waiterId: "waiter-golden",
    resultToken: "token-golden",
    phase: "COMMITTED",
    authority: { tag: "REJECTED", workspaceId: "workspace-golden", opId: "op-golden", semanticDigest: "aa", reason: "golden rejection" },
    origin: null,
    delivery: "PENDING",
    currentLease: "NOT_REQUESTED",
    acknowledgement: null
  } as unknown as CompoundOperationReceipt;
  assert.equal(JSON.stringify(renderCompoundCliExit({ kind: "RECEIPT", receipt })), golden.compoundTerminalReceipt);
});
