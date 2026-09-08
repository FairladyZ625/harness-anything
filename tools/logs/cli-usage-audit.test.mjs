// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditCliUsage, buildCommandDenominator, loadJsonl } from "./cli-usage-audit.mjs";

const command = (id, actionKind = id, phase = "W3") => ({
  id,
  actionKind,
  method: id.includes("read") ? "repo.task.read" : "repo.task.run",
  path: ["task", id],
  usage: `ha task ${id}`,
  phase,
  commandClass: id.includes("read") ? "repo-read" : "repo-write",
  testReferences: 1,
});
const row = (at, commandName, overrides = {}) => ({
  schema: "daemon-request-log/v1",
  at,
  atMs: Date.parse(at),
  sourceFile: "requests.jsonl",
  command: commandName,
  ok: true,
  code: null,
  opId: null,
  durationMs: 1,
  ...overrides,
});

test("audit keeps the descriptor denominator and refuses to call mixed request logs CLI usage", () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const report = auditCliUsage({
    commands: [command("read", "read"), command("write", "write")],
    requestRecords: [row("2026-09-07T00:00:00.000Z", "read")],
    nowMs: now,
  });
  assert.equal(report.observation.requestCount, 1);
  assert.equal(report.observation.uniqueCommands, 1);
  assert.equal(report.observation.sourceAttribution.cli, 0);
  assert.equal(report.observation.sourceAttribution.unknown, 1);
  assert.equal(report.denominator.find((item) => item.id === "read").status, "observed");
  assert.equal(report.denominator.find((item) => item.id === "write").status, "unobserved-tested");
  assert.equal(report.windows[0].requestCount, 1);
  assert.equal(report.windows[1].requestCount, 1);
});

test("failure families deduplicate opIds, classify invalid suggestions and correlate receipts", () => {
  const at = "2026-09-08T00:00:00.000Z";
  const report = auditCliUsage({
    commands: [command("write", "write", "W4")],
    requestRecords: [
      row(at, "write", { ok: false, code: "invalid_field", opId: "op-1", durationMs: 2 }),
      row(at, "write", { ok: false, code: "invalid_field", opId: "op-1", durationMs: 3 }),
      row(at, "write", { ok: false, code: "store_corrupt", opId: "op-2", durationMs: 6_000 }),
    ],
    receipts: ["op-1"],
    nowMs: Date.parse(at),
    slowMs: 5_000,
  });
  assert.equal(report.failures.length, 2);
  const invalid = report.failures.find((family) => family.code === "invalid_field");
  assert.equal(invalid.category, "invalid-suggestion");
  assert.equal(invalid.uniqueOpIds, 1);
  assert.equal(invalid.duplicateRequestsSuppressed, 1);
  assert.equal(invalid.correlatedOpIds, 1);
  assert.equal(report.failures.find((family) => family.code === "store_corrupt").category, "slow-call-or-timeout");
});

test("request log loader handles rotation files and reports long retention gaps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-audit-"));
  const first = path.join(root, "requests.jsonl.1"),
    second = path.join(root, "requests.jsonl");
  writeFileSync(
    first,
    `${JSON.stringify({ schema: "daemon-request-log/v1", at: "2026-08-01T00:00:00.000Z", command: "old", ok: true })}\n`,
  );
  writeFileSync(
    second,
    `${JSON.stringify({ schema: "daemon-request-log/v1", at: "2026-09-08T00:00:00.000Z", command: "new", ok: true })}\n`,
  );
  const records = loadJsonl([first, second], "daemon-request-log/v1");
  const report = auditCliUsage({
    commands: [command("new")],
    requestRecords: records,
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(records.length, 2);
  assert.equal(report.observation.rotationGaps.length, 1);
  assert.equal(report.observation.rotationGaps[0].kind, "possible-retention-or-no-usage-gap");
});

test("denominator records test and production evidence from descriptor tokens", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-audit-evidence-"));
  const testFile = path.join(root, "command.test.ts"),
    sourceFile = path.join(root, "command.ts");
  writeFileSync(testFile, "task-show");
  writeFileSync(sourceFile, "task-show");
  const result = buildCommandDenominator([command("task-show")], { testFiles: [testFile], sourceFiles: [sourceFile] });
  assert.equal(result[0].testReferences, 1);
  assert.equal(result[0].productionReferences, 1);
});
