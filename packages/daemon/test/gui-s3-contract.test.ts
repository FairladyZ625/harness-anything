// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateCatalogPreset, validateCatalogRereadReceipt, validateCatalogSnapshot, validateDaemonControlReceipt,
  validateRuntimeCredentialReceipt, validateRuntimeSpawnReceipt, validateSystemStatus,
  validateTerminalAttach, validateTerminalAttachEvent, validateTerminalControlReceipt,
  validateTerminalDetachAck, validateTerminalInputAck, validateTerminalSessionList
} from "../src/gui-s3-control.ts";

test("GUI S3 contracts reject unknown and secret-like fields recursively", () => {
  assert.notDeepEqual(validateSystemStatus({ ok: true, token: "x" }), []);
  assert.notDeepEqual(validateCatalogSnapshot({ ok: true, nested: { apiToken: "x" } }), []);
  assert.notDeepEqual(validateRuntimeCredentialReceipt({ ok: false, secret: "x" }), []);
  assert.notDeepEqual(validateRuntimeSpawnReceipt({ schema: "command-receipt/v2", ok: true, token: "x" }), []);
});

test("every GUI S3 result validator fails closed", () => {
  for (const validate of [validateDaemonControlReceipt, validateCatalogRereadReceipt,
    validateTerminalControlReceipt, validateTerminalInputAck, validateTerminalSessionList,
    validateTerminalAttach, validateTerminalAttachEvent]) assert.notDeepEqual(validate({ ok: true, unexpected: true }), []);
});

test("every pinned GUI S3 negative fixture is rejected by its declared validator", () => {
  const cases = [
    ["gui-system-status-invalid.json", validateSystemStatus], ["daemon-control-receipt-invalid.json", validateDaemonControlReceipt],
    ["gui-catalog-snapshot-invalid.json", validateCatalogSnapshot], ["gui-catalog-preset-invalid.json", validateCatalogPreset],
    ["catalog-reread-receipt-v1-invalid.json", validateCatalogRereadReceipt], ["runtime-credential-receipt-v1-invalid.json", validateRuntimeCredentialReceipt],
    ["terminal-session-list-invalid.json", validateTerminalSessionList], ["terminal-control-receipt-v1-invalid.json", validateTerminalControlReceipt],
    ["terminal-input-ack-v1-invalid.json", validateTerminalInputAck], ["terminal-detach-ack-v1-invalid.json", validateTerminalDetachAck],
    ["terminal-attach-v1-invalid.json", validateTerminalAttach], ["terminal-attach-event-v1-invalid.json", validateTerminalAttachEvent]
  ] as const;
  for (const [fixture, validate] of cases) assert.notDeepEqual(validate(JSON.parse(readFileSync(new URL(`../fixtures/contracts/${fixture}`, import.meta.url), "utf8"))), [], fixture);
});
