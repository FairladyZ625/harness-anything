// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { appendCommandRuntimeEvent } from "../src/cli/command-runtime-events.ts";
import { appendParseFailureRuntimeEvent } from "../src/cli/parse-failure-runtime-event.ts";
import type { CommandRunnerContext } from "../src/cli/runner-registry.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
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

test("automatic runtime event failure warns without reversing a successful command receipt", async () => {
  const command = {
    rootDir: "/tmp/runtime-event-failure",
    json: true,
    action: { kind: "new-task" }
  } as unknown as ParsedCommand;
  const context = {
    currentSessionProbe: {
      currentSession: Effect.succeed({ source: "runtime", runtime: "codex", sessionId: "codex-event-failure" })
    },
    runtimeEventLedgerService: {
      append: () => Effect.fail({
        _tag: "RuntimeEventLedgerRejected" as const,
        sessionId: "codex-event-failure",
        reason: "global write conflict"
      })
    },
    taskHolderPrincipal: () => ({
      principal: { personId: "person_test", displayName: "Harness Test" },
      executor: { kind: "agent", id: "codex" },
      responsibleHuman: "person:person_test"
    })
  } as unknown as CommandRunnerContext;

  const result = await runEffect(appendCommandRuntimeEvent(context, command, {
    ok: true,
    command: "new-task",
    taskId: "task_event_success",
    packagePath: "harness/tasks/task_event_success"
  }));

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, [{
    severity: "warning",
    code: "runtime_event_append_failed",
    sessionId: "codex-event-failure",
    message: "Runtime event append failed after the command result was determined: global write conflict"
  }]);
});

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
    const commandEvents = readdirSync(path.dirname(ledgerPath))
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readJsonl(path.join(path.dirname(ledgerPath), file)))
      .filter((event) => event.tool?.toolName === "new-task");
    assert.equal(commandEvents.length, 1);
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
    assert.equal(events[0].schema, "runtime-event/v2");
    assert.equal(events[0].actor.principal.personId, "person_tester");
    assert.deepEqual(events[0].actor.executor, { kind: "agent", id: "codex-cli" });
    assert.equal("responsibleHuman" in events[0].actor, false);
  });
});

test("CLI entity write fails closed before runtime event append when principal cannot be resolved", () => {
  withTempRoot((rootDir) => {
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nsettings:\n", "utf8");
    const sessionId = "codex-runtime-event-missing-actor";
    const output = runJsonWithStderr(rootDir, ["new-task", "--title", "Missing Actor Event"], {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: "",
      HARNESS_DAEMON_MODE: "direct"
    }, 1);
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);

    assert.equal(output.result.ok, false);
    assert.equal(existsSync(ledgerPath), false);
    assert.match(output.result.warnings?.[0]?.message ?? "", /Local writes require a configured person identity/u);
  });
});

test("CLI parse failures append operational events without business actor attribution", () => {
  withTempRoot((rootDir) => {
    const sessionId = "codex-w2-parse-failure";
    const output = runJsonWithStderr(rootDir, [
      "decision", "propose",
      "--title", "Malformed rejection",
      "--question", "Which option?",
      "--chosen", "Chosen option",
      "--rejected", '{"badfield":"do-not-store"}'
    ], {
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: "",
      HARNESS_ACTOR: "",
      HARNESS_GIT_AUTHOR_NAME: "",
      HARNESS_GIT_AUTHOR_EMAIL: "",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: ""
    }, 2);
    const ledgerPath = path.join(rootDir, ".harness/generated/runtime-events", `${sessionId}.jsonl`);
    const body = readFileSync(ledgerPath, "utf8");
    const events = readJsonl(ledgerPath);

    assert.equal(output.result.ok, false);
    assert.equal(output.result.error?.code, "invalid_decision_amend_patch");
    assert.match(output.result.error?.hint ?? "", /rejected JSON requires text/u);
    assert.doesNotMatch(output.stderr, /CliActorAttributionError/u);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, undefined);
    assert.equal(events[0].actorAxes, undefined);
    assert.equal(events[0].tool.toolName, "parse");
    assert.equal(events[0].result.status, "failed");
    assert.equal(events[0].result.errorCode, "invalid_decision_amend_patch");
    assert.equal(body.includes("do-not-store"), false);
  });
});

test("parse-failure diagnostic injection failures preserve the primary error and emit a warning", async () => {
  const primaryError = {
    code: "invalid_json_input",
    category: "parse",
    hint: "rejected JSON requires text"
  } as const;
  const warnings: string[] = [];

  await appendParseFailureRuntimeEvent([], primaryError, {
    append: async (_argv, error) => {
      assert.equal(error, primaryError);
      throw new Error("injected runtime-event failure");
    },
    warn: (message) => warnings.push(message)
  });

  assert.equal(primaryError.hint, "rejected JSON requires text");
  assert.deepEqual(warnings, [
    "warning: unable to append CLI parse-failure diagnostic: injected runtime-event failure"
  ]);
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
  ensureTestHarnessIdentity(rootDir);
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
        HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user"),
        HARNESS_DAEMON_IDLE_MS: "250",
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

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}

function runJsonWithStderr(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
  expectedStatus = 0
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
  assert.equal(child.status, expectedStatus);
  return {
    result: unwrapCommandReceipt(JSON.parse(child.stdout) as Record<string, any>),
    stderr: child.stderr
  };
}
