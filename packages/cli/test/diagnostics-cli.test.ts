// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("diagnostics command-usage reports failed commands and unused evented surfaces", () => {
  withTempRoot((rootDir) => {
    const ledgerDir = path.join(rootDir, ".harness/generated/runtime-events");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(path.join(ledgerDir, "codex-session.jsonl"), [
      JSON.stringify(runtimeEvent("evt_diag0001", "new-task", "succeeded")),
      JSON.stringify(runtimeEvent("evt_diag0002", "status-set", "failed", "task_not_found")),
      JSON.stringify(runtimeEvent("evt_diag0003", "status-set", "failed", "invalid_transition")),
      JSON.stringify(deprecatedRuntimeEvent("evt_diag0004", "status-set"))
    ].join("\n") + "\n", "utf8");

    const result = runJson(rootDir, ["diagnostics", "command-usage"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "diagnostics-command-usage");
    assert.equal(result.report.schema, "command-usage-diagnostics/v1");
    assert.equal(result.report.totalEvents, 4);
    assert.equal(result.report.resultEvents, 4);
    assert.equal(result.report.sessions, 1);
    const statusSet = result.report.rows.find((row: Record<string, unknown>) => row.commandKind === "status-set");
    assert.equal(statusSet.succeeded, 1);
    assert.equal(statusSet.failed, 2);
    assert.equal(statusSet.deprecated, 1);
    assert.equal(statusSet.failureRate, 2 / 3);
    assert.deepEqual(statusSet.errorCodes, [
      { errorCode: "invalid_transition", count: 1 },
      { errorCode: "task_not_found", count: 1 }
    ]);
    assert.deepEqual(result.report.deprecatedUsage, [{ commandKind: "status-set", count: 1 }]);
    assert.equal(result.report.unusedEventedCommands.some((entry: Record<string, unknown>) => entry.commandKind === "progress-append"), true);
  });
});

function runtimeEvent(eventId: string, commandKind: string, status: "succeeded" | "failed", errorCode?: string): Record<string, unknown> {
  return {
    schema: "runtime-event/v1",
    eventId,
    recordedAt: "2026-07-07T00:00:00.000Z",
    kind: "result",
    session: { sessionId: "codex-session", runtime: "codex" },
    turn: null,
    step: null,
    tool: { toolName: commandKind, ...(errorCode ? { errorCode } : {}) },
    approval: null,
    interrupt: null,
    result: {
      status,
      summary: `CLI command ${status === "succeeded" ? "succeeded" : "failed"}: ${commandKind}`,
      ...(errorCode ? { errorCode } : {})
    },
    cost: null
  };
}

function deprecatedRuntimeEvent(eventId: string, commandKind: string): Record<string, unknown> {
  return {
    schema: "runtime-event/v1",
    eventId,
    recordedAt: "2026-07-07T00:00:00.000Z",
    kind: "result",
    session: { sessionId: "codex-session", runtime: "codex" },
    turn: null,
    step: null,
    tool: { toolName: commandKind, deprecated: true },
    approval: null,
    interrupt: null,
    result: {
      status: "succeeded",
      summary: `CLI command succeeded: ${commandKind}`
    },
    cost: null
  };
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-diagnostics-cli-"));
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
