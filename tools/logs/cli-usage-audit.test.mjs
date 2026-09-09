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

const descriptor = (id, method) => ({ id, actionKind: id, method, usage: `ha ${id}`, testCoverage: "unmeasured" });

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
  assert.equal(report.denominator.find((item) => item.id === "write").status, "unobserved-needs-review");
  assert.equal(report.windows[0].requestCount, 1);
  assert.equal(report.windows[1].requestCount, 1);
});

test("a uniquely owned RPC method observes its command descriptor", () => {
  const report = auditCliUsage({
    commands: [descriptor("agenda", "repo.agenda.read")],
    requestRecords: [row("2026-09-07T00:00:00.000Z", undefined, { method: "repo.agenda.read" })],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(report.denominator[0].observedRequests, 1);
  assert.equal(report.denominator[0].directObservedRequests, 0);
  assert.equal(report.denominator[0].uniqueMethodObservedRequests, 1);
  assert.equal(report.observation.methodAttribution.uniqueMethodRequests, 1);
});

test("shared RPC traffic remains unattributed instead of observing every alias", () => {
  const report = auditCliUsage({
    commands: [
      descriptor("runtime-batch", "repo.agentRuntime.spawn"),
      descriptor("runtime-run", "repo.agentRuntime.spawn"),
    ],
    requestRecords: [row("2026-09-07T00:00:00.000Z", undefined, { method: "repo.agentRuntime.spawn" })],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.deepEqual(
    report.denominator.map((item) => item.observedRequests),
    [0, 0],
  );
  assert.deepEqual(
    report.denominator.map((item) => item.sharedMethodObservedRequests),
    [1, 1],
  );
  assert.equal(report.observation.methodAttribution.sharedMethodRequests, 1);
  assert.deepEqual(
    report.denominator.map((item) => item.status),
    ["unattributed-shared-method", "unattributed-shared-method"],
  );
  assert.equal(report.zeroObservation.length, 0);
});

test("a direct identity and its matching unique method count one request once", () => {
  const report = auditCliUsage({
    commands: [descriptor("agenda", "repo.agenda.read")],
    requestRecords: [row("2026-09-07T00:00:00.000Z", "agenda", { method: "repo.agenda.read" })],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(report.denominator[0].observedRequests, 1);
  assert.equal(report.denominator[0].directObservedRequests, 1);
  assert.equal(report.denominator[0].uniqueMethodObservedRequests, 0);
});

test("distinct direct and unique-method records both count", () => {
  const report = auditCliUsage({
    commands: [descriptor("agenda", "repo.agenda.read")],
    requestRecords: [
      row("2026-09-07T00:00:00.000Z", "agenda"),
      row("2026-09-07T00:00:01.000Z", undefined, { method: "repo.agenda.read" }),
    ],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(report.denominator[0].observedRequests, 2);
});

test("a genuinely unobserved descriptor remains a zero-observation candidate", () => {
  const report = auditCliUsage({
    commands: [descriptor("never-used", "repo.never.used")],
    requestRecords: [],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(report.denominator[0].observedRequests, 0);
  assert.equal(report.zeroObservation[0].id, "never-used");
});

test("failure families only deduplicate repeated non-null opIds", () => {
  const at = "2026-09-08T00:00:00.000Z";
  const report = auditCliUsage({
    commands: [command("write", "write", "W4")],
    requestRecords: [
      row(at, "write", { ok: false, code: "invalid_field", opId: "op-1", durationMs: 2 }),
      row(at, "write", { ok: false, code: "invalid_field", opId: "op-1", durationMs: 3 }),
      row(at, "write", { ok: false, code: "invalid_field", opId: null, durationMs: 4 }),
      row(at, "write", { ok: false, code: "store_corrupt", opId: "op-2", durationMs: 6_000 }),
    ],
    receipts: ["op-1"],
    nowMs: Date.parse(at),
    slowMs: 5_000,
  });
  assert.equal(report.failures.length, 2);
  const invalid = report.failures.find((family) => family.code === "invalid_field");
  assert.equal(invalid.category, "needs-triage");
  assert.equal(invalid.uniqueOpIds, 1);
  assert.equal(invalid.uniqueIntentCount, 2);
  assert.equal(invalid.duplicateRequestsSuppressed, 1);
  assert.equal(invalid.correlatedOpIds, 1);
  assert.equal(report.failures.find((family) => family.code === "store_corrupt").category, "needs-triage");
  assert.equal(report.slowCalls.requestCount, 1);
  assert.equal(report.slowCalls.failedRequestCount, 1);
});

test("successful slow requests remain in the independent slow-call summary", () => {
  const report = auditCliUsage({
    commands: [command("read", "read")],
    requestRecords: [row("2026-09-08T00:00:00.000Z", "read", { durationMs: 6_000 })],
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    slowMs: 5_000,
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.slowCalls.requestCount, 1);
  assert.equal(report.slowCalls.successfulRequestCount, 1);
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

test("denominator does not infer test coverage from unrelated source text", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-audit-evidence-"));
  const testFile = path.join(root, "command.test.ts"),
    sourceFile = path.join(root, "command.ts");
  writeFileSync(testFile, "task-show");
  writeFileSync(sourceFile, "task-show");
  const result = buildCommandDenominator([command("task-show")], { testFiles: [testFile], sourceFiles: [sourceFile] });
  assert.equal(result[0].testCoverage, "unmeasured");
  assert.equal("testReferences" in result[0], false);
  assert.equal("productionReferences" in result[0], false);
});

test("loader records malformed lines and explicit unreadable files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-audit-integrity-"));
  const file = path.join(root, "requests.jsonl");
  writeFileSync(file, '{"schema":"daemon-request-log/v1","at":"2026-09-08T00:00:00.000Z","command":"read"}\n{bad}\n');
  const records = loadJsonl([file, path.join(root, "missing.jsonl")], "daemon-request-log/v1");
  assert.equal(records.length, 1);
  assert.equal(records.loadIssues.malformedJsonLines, 1);
  assert.deepEqual(
    records.loadIssues.unreadableFiles.map(({ file: target }) => target),
    [path.join(root, "missing.jsonl")],
  );
  const report = auditCliUsage({ commands: [command("read", "read")], requestRecords: records });
  assert.equal(report.observation.logIntegrity.complete, false);
});
