// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { assertCommandSuccessNextContracts } from "../src/cli/receipt-contracts.ts";

test("every command and receipt variant explicitly declares success next-step guidance", () => {
  assert.doesNotThrow(() => assertCommandSuccessNextContracts(commandDescriptors));
});

test("success next-step contract rejects a new command that omits the declaration", () => {
  assert.throws(
    () => assertCommandSuccessNextContracts([{
      kind: "fixture-command",
      usage: "fixture command [--json]",
      receiptContract: {}
    }]),
    /fixture-command .* must explicitly declare successNext/u
  );
});

test("success next-step actions require concrete commands and distilled guidance", () => {
  assert.throws(
    () => assertCommandSuccessNextContracts([{
      kind: "fixture-command",
      usage: "fixture command [--json]",
      receiptContract: {
        successNext: {
          kind: "actions",
          actions: [{ command: "", description: "" }]
        }
      }
    }]),
    /must declare a command.*must declare distilled guidance/su
  );
});
