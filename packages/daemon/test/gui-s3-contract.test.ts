// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import {
  validateCatalogPreset, validateCatalogRereadReceipt, validateCatalogSnapshot, validateDaemonControlReceipt,
  validateRuntimeSpawnReceipt, validateSystemStatus,
  validateTerminalAttach, validateTerminalAttachEvent, validateTerminalControlReceipt,
  validateTerminalDetachAck, validateTerminalInputAck, validateTerminalSessionList
} from "../src/gui-s3-control.ts";

test("daemon Settings reads use the exact canonical Settings shape", () => {
  const settings = {
    schema: "settings/v1",
    settingsId: "repository",
    defaultVertical: "software/coding",
    defaultPreset: "standard-task",
    defaultProfile: "baseline",
    locale: "en-US",
    scaffolds: {
      task: "governance/task-scaffold.json",
      repository: "governance/repository-scaffold.json",
    },
  };
  const valid = { schema: "daemon.settings-read/v1", ok: true, settings };
  assert.equal(parseDaemonGuiReadResult("repo.settings.read", valid), valid);
  assert.throws(() =>
    parseDaemonGuiReadResult("repo.settings.read", {
      schema: "daemon.settings-read/v1",
      ok: true,
      settings: {
        ...settings,
        scaffolds: { ...settings.scaffolds, unknown: "rejected" },
      },
    }),
  );
});

test("GUI S3 contracts reject unknown and secret-like fields recursively", () => {
  assert.notDeepEqual(validateSystemStatus({ ok: true, token: "x" }), []);
  assert.notDeepEqual(validateCatalogSnapshot({ ok: true, nested: { apiToken: "x" } }), []);
  assert.notDeepEqual(validateRuntimeSpawnReceipt({ schema: "command-receipt/v2", ok: true, token: "x" }), []);
});

test("a produced terminal op_rejected receipt passes its validator", () => {
  assert.deepEqual(validateTerminalControlReceipt({ schema: "terminal-control-receipt/v1", ok: false, outcome: "op_rejected", operationId: "terminal-op-x", sessionId: "s1", daemonGeneration: 1, state: "exited", error: { code: "terminal_exited", hint: "Start a new terminal session." } }), []);
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
    ["catalog-reread-receipt-v1-invalid.json", validateCatalogRereadReceipt],
    ["terminal-session-list-invalid.json", validateTerminalSessionList], ["terminal-control-receipt-v1-invalid.json", validateTerminalControlReceipt],
    ["terminal-input-ack-v1-invalid.json", validateTerminalInputAck], ["terminal-detach-ack-v1-invalid.json", validateTerminalDetachAck],
    ["terminal-attach-v1-invalid.json", validateTerminalAttach], ["terminal-attach-event-v1-invalid.json", validateTerminalAttachEvent]
  ] as const;
  for (const [fixture, validate] of cases) assert.notDeepEqual(validate(JSON.parse(readFileSync(new URL(`../fixtures/contracts/${fixture}`, import.meta.url), "utf8"))), [], fixture);
});
