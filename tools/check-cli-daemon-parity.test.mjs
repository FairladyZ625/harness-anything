// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { checkCliDaemonParity, parityOutcome } from "./check-cli-daemon-parity.mjs";

test("CLI-daemon parity gate executes the complete typed write matrix", { timeout: 30_000 }, async () => {
  assert.deepEqual(await checkCliDaemonParity(), []);
});

test("CLI-daemon parity comparison preserves negative error codes", () => {
  const ordinary = parityOutcome({ ok: false, command: "decision amend", error: { code: "decision_read_failed" } });
  const masked = parityOutcome({ ok: false, command: "decision amend", error: { code: "command_receipt_contract_mismatch" } });
  assert.notDeepEqual(masked, ordinary);
});
