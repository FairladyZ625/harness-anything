import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI authored write commands append a current-session result event", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-w2-command-event";
    const created = runJson(rootDir, ["new-task", "--title", "Evented Task"], true, {
      CODEX_SESSION_ID: sessionId
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const events = readJsonl(ledgerPath);

    assert.equal(created.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "result");
    assert.equal(events[0].session.sessionId, sessionId);
    assert.equal(events[0].session.runtime, "codex");
    assert.equal(events[0].session.taskId, created.taskId);
    assert.equal(events[0].result.status, "succeeded");
    assert.equal(events[0].result.summary, "CLI command succeeded: new-task");
  });
});

test("CLI dry-run authored commands do not append command events", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-w2-dry-run";
    const result = runJson(rootDir, ["new-task", "--title", "Dry Run Task", "--dry-run"], true, {
      CODEX_SESSION_ID: sessionId
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);

    assert.equal(result.ok, true);
    assert.equal(existsSync(ledgerPath), false);
  });
});

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

test("CLI runtime-event append preserves JSONL append order across repeated writes", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-session-append-only";
    const appendArgs = [
      ["--kind", "session", "--runtime", "codex", "--id", "evt_first001", "--at", "2026-07-03T00:00:00.000Z"],
      ["--kind", "tool", "--tool", "shell", "--id", "evt_second002", "--at", "2026-07-03T00:00:01.000Z"],
      ["--kind", "result", "--result", "succeeded", "--summary", "Completed step.", "--id", "evt_third003", "--at", "2026-07-03T00:00:02.000Z"]
    ];

    const ledgerPath = path.join(rootDir, ".harness", "generated/runtime-events", `${sessionId}.jsonl`);
    let firstLineAfterFirstAppend = "";
    for (const [index, args] of appendArgs.entries()) {
      const appended = runJson(rootDir, ["runtime-event", "append", "--session", sessionId, ...args]);
      assert.equal(appended.ok, true);
      if (index === 0) {
        firstLineAfterFirstAppend = readFileSync(ledgerPath, "utf8").trimEnd().split("\n")[0] ?? "";
      }
    }

    const listed = runJson(rootDir, ["runtime-event", "list", "--session", sessionId]);
    const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    const lineEvents = lines.map((line) => JSON.parse(line) as { readonly eventId: string; readonly kind: string });

    assert.equal(lines.length, 3);
    assert.equal(lines[0], firstLineAfterFirstAppend);
    assert.deepEqual(lineEvents.map((event) => event.eventId), ["evt_first001", "evt_second002", "evt_third003"]);
    assert.deepEqual(lineEvents.map((event) => event.kind), ["session", "tool", "result"]);
    assert.deepEqual(listed.report.events.map((event: { readonly eventId: string }) => event.eventId), lineEvents.map((event) => event.eventId));
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

function readJsonl(filePath: string): ReadonlyArray<Record<string, any>> {
  return readFileSync(filePath, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true,
  env: Readonly<Record<string, string>> = {}
): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}
