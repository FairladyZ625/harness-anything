// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const cleanRuntimeEnv = {
  CLAUDE_CODE_SESSION_ID: "",
  CLAUDE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
} as const;

test("CLI authored write commands append a current-session result event", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-w2-command-event";
    const created = runJson(rootDir, ["new-task", "--title", "Evented Task"], true, {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: ""
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
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: ""
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);

    assert.equal(result.ok, true);
    assert.equal(existsSync(ledgerPath), false);
  });
});

test("CLI failed command results append failed command events", () => {
  withTempRoot((rootDir) => {
    initGitRoot(rootDir);
    const sessionId = "codex-w2-command-failure";
    const taskId = "task_01KWY3Z4VEVP6FNT28ZFA809GW";
    const result = runJson(rootDir, ["task", "transition", taskId, "done"], false, {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: ""
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const events = readJsonl(ledgerPath);

    assert.equal(result.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "result");
    assert.equal(events[0].tool.toolName, "status-set");
    assert.equal(events[0].result.status, "failed");
    assert.equal(events[0].result.summary, "CLI command failed: status-set");
    assert.equal(typeof events[0].result.errorCode, "string");
  });
});

test("CLI task transition runtime event records dual-axis actor", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Transition Actor Task"]);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    const sessionId = "codex-transition-actor";
    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"], true, {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: "",
      HARNESS_ACTOR: "agent:codex-cli"
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const events = readJsonl(ledgerPath);

    assert.equal(transitioned.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool.toolName, "status-set");
    assert.equal(events[0].session.taskId, created.taskId);
    assert.equal(events[0].actor.principal.personId, "person_tester");
    assert.deepEqual(events[0].actor.executor, { kind: "agent", id: "codex-cli" });
    assert.equal(events[0].actor.responsibleHuman, "person:person_tester");
  });
});

test("CLI warns when runtime event actor attribution cannot be resolved", () => {
  withTempRoot((rootDir) => {
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nsettings:\n", "utf8");
    const sessionId = "codex-runtime-event-missing-actor";
    const output = runJsonWithStderr(rootDir, ["new-task", "--title", "Missing Actor Event"], {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: ""
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const events = readJsonl(ledgerPath);

    assert.equal(output.result.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, undefined);
    assert.match(output.stderr, /runtime event actor attribution unavailable: Local writes require a configured person identity/u);
  });
});

test("CLI parse failures append safe failed command events", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-w2-parse-failure";
    const result = runJson(rootDir, ["definitely-not-a-command", "--secret", "do-not-store"], false, {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: ""
    });
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const body = readFileSync(ledgerPath, "utf8");
    const events = readJsonl(ledgerPath);

    assert.equal(result.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool.toolName, "parse");
    assert.equal(events[0].result.status, "failed");
    assert.equal(events[0].result.errorCode, "unknown_command");
    assert.equal(body.includes("do-not-store"), false);
  });
});

test("CLI event append and list write local JSONL without task lifecycle mutation", () => {
  withTempRoot((rootDir) => {
    const appended = runJson(rootDir, [
      "event",
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

    const listed = runJson(rootDir, ["event", "list", "--session", "codex-session-1"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "runtime-event-list");
    assert.equal(listed.rows, 1);
    assert.equal(listed.report.events[0].cost.totalTokens, 42);
  });
});

test("CLI event append preserves JSONL append order across repeated writes", () => {
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
      const appended = runJson(rootDir, ["event", "append", "--session", sessionId, ...args]);
      assert.equal(appended.ok, true);
      if (index === 0) {
        firstLineAfterFirstAppend = readFileSync(ledgerPath, "utf8").trimEnd().split("\n")[0] ?? "";
      }
    }

    const listed = runJson(rootDir, ["event", "list", "--session", sessionId]);
    const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    const lineEvents = lines.map((line) => JSON.parse(line) as { readonly eventId: string; readonly kind: string });

    assert.equal(lines.length, 3);
    assert.equal(lines[0], firstLineAfterFirstAppend);
    assert.deepEqual(lineEvents.map((event) => event.eventId), ["evt_first001", "evt_second002", "evt_third003"]);
    assert.deepEqual(lineEvents.map((event) => event.kind), ["session", "tool", "result"]);
    assert.deepEqual(listed.report.events.map((event: { readonly eventId: string }) => event.eventId), lineEvents.map((event) => event.eventId));
  });
});

test("CLI event append rejects unsupported steering vocabulary", () => {
  withTempRoot((rootDir) => {
    const failure = runJson(rootDir, [
      "event",
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
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    personId: person_tester",
      "    displayName: Harness Tester",
      ""
    ].join("\n"), "utf8");
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initGitRoot(rootDir: string): void {
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: rootDir, stdio: "ignore" });
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
      env: {
        ...process.env,
        ...cleanRuntimeEnv,
        HARNESS_ACTOR: "agent:harness-test",
        HARNESS_GIT_AUTHOR_NAME: "Harness Tester",
        HARNESS_GIT_AUTHOR_EMAIL: "tester@example.test",
        ...env
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runJsonWithStderr(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): { readonly result: Record<string, any>; readonly stderr: string } {
  const child = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...cleanRuntimeEnv,
      HARNESS_ACTOR: "agent:harness-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Tester",
      HARNESS_GIT_AUTHOR_EMAIL: "tester@example.test",
      ...env
    }
  });
  assert.equal(child.status, 0);
  return {
    result: unwrapCommandReceipt(JSON.parse(child.stdout) as Record<string, any>),
    stderr: child.stderr
  };
}
