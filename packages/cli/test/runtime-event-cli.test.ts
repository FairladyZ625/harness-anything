import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI runtime-event append and list write local JSONL without task lifecycle mutation", () => {
  withTempRoot((rootDir) => {
    const appended = runJson(rootDir, [
      "runtime-event",
      "append",
      "--session",
      "codex-session-1",
      "--kind",
      "interrupt",
      "--runtime",
      "codex",
      "--task",
      "task_01KWK8Z8V1YF1N0V0H2F6R1AYW",
      "--interrupt",
      "append",
      "--result",
      "succeeded",
      "--summary",
      "User appended task guidance.",
      "--total-tokens",
      "42"
    ]);

    assert.equal(appended.ok, true);
    assert.equal(appended.command, "runtime-event-append");
    assert.equal(appended.path, "generated/runtime-events/codex-session-1.jsonl");
    const ledgerBody = readFileSync(path.join(rootDir, ".harness", "generated/runtime-events/codex-session-1.jsonl"), "utf8");
    assert.match(ledgerBody, /"kind":"interrupt"/u);
    assert.match(ledgerBody, /"approval":null/u);
    assert.match(ledgerBody, /"interrupt":\{"interruptId":"evt_/u);

    const listed = runJson(rootDir, ["runtime-event", "list", "--session", "codex-session-1"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "runtime-event-list");
    assert.equal(listed.rows, 1);
    assert.equal(listed.report.events[0].cost.totalTokens, 42);
  });
});

test("CLI runtime-event append rejects unsupported steering vocabulary", () => {
  withTempRoot((rootDir) => {
    const failure = runJson(rootDir, [
      "runtime-event",
      "append",
      "--session",
      "codex-session-1",
      "--kind",
      "interrupt",
      "--interrupt",
      "inject-pty"
    ], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_runtime_event_value");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-event-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}
