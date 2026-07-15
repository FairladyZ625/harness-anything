// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("task lease enforcement defaults off without configuration or environment", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const write = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "default off write"]);
    assert.equal(write.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), /default off write/u);
  });
});

test("workspace lease configuration rejects unclaimed writes and permits the claimed writer", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const created = runJson(rootDir, ["new-task", "--title", "Configured Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "unclaimed write"], false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "write_rejected");
    assert.match(rejected.error?.hint ?? "", /requires an active lease/u);

    const claimed = runJson(rootDir, ["task", "claim", taskId]);
    assert.equal(claimed.ok, true);
    const accepted = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "claimed write"]);
    assert.equal(accepted.ok, true);
  });
});

test("configured writes recover the caller's orphaned lease but reject another principal", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentityWithLeaseEnforcement(rootDir, "person_zeyu", "Zeyu Li", true);
    const created = runJson(rootDir, ["new-task", "--title", "Recover Orphaned Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    runJson(rootDir, ["task", "claim", taskId, "--ttl-ms", "60000"], true, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    expireTaskHolder(rootDir, taskId);

    const recovered = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "write recovered lease"], true, {
      HARNESS_ACTOR: "agent:codex"
    });
    assert.equal(recovered.ok, true);
    const holder = readTaskHolder(rootDir, taskId);
    assert.equal(holder.holder.principal.personId, "person_zeyu");
    assert.deepEqual(holder.holder.executor, { kind: "agent", id: "codex" });
    assert.ok(Date.parse(holder.leaseExpiresAt) > Date.now());

    writeHarnessIdentityWithLeaseEnforcement(rootDir, "person_alice", "Alice", true);
    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "must not cross principal"], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error?.hint ?? "", /caller principal=person_alice, executor=agent:claude-code/u);
    assert.match(rejected.error?.hint ?? "", /current holder principal=person_zeyu, executor=agent:codex/u);
    assert.match(rejected.error?.hint ?? "", /lease status active/u);
  });
});

test("explicit false environment override disables configured lease enforcement", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const created = runJson(rootDir, ["new-task", "--title", "Environment Disabled Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const write = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "env disabled write"], true, {
      HARNESS_TASK_LEASE_ENFORCEMENT: "0"
    });
    assert.equal(write.ok, true);
  });
});

test("explicit true environment override enables lease enforcement without configuration", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Environment Enabled Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "env enabled write"], false, {
      HARNESS_TASK_LEASE_ENFORCEMENT: "1"
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "write_rejected");
  });
});

test("task claim fails closed when HARNESS_ACTOR names an agent but machine identity is missing", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Missing Identity Claim"]);
    writeHarnessConfig(rootDir);

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AuthMissing");
    assert.match(rejected.error?.hint ?? "", /machine identity|people\.yaml/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
    assert.equal(JSON.stringify(rejected).includes("person:claude-code"), false);
  });
});

test("lease enforcement reports missing machine identity instead of journal failure", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Missing Identity Lease"]);
    writeHarnessConfig(rootDir);

    const rejected = runJson(rootDir, ["task", "progress", "append", created.taskId, "--text", "guarded"], false, {
      HARNESS_ACTOR: "agent:claude-code",
      HARNESS_TASK_LEASE_ENFORCEMENT: "1"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "write_rejected");
    assert.match(rejected.error?.hint ?? "", /machine identity|people\.yaml/u);
    assert.equal((rejected.error?.hint ?? "").includes("Journal is unavailable"), false);
  });
});

test("configured identity supplies principal while HARNESS_ACTOR supplies only agent executor", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Configured Agent Claim"]);

    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    const holder = claimed.report.effectiveHolder;

    assert.equal(holder.principal.personId, "person_zeyu");
    assert.equal(holder.principal.displayName, "Zeyu Li");
    assert.deepEqual(holder.executor, { kind: "agent", id: "claude-code" });
    assert.equal(holder.responsibleHuman, "person:person_zeyu");
  });
});

test("configured identity supports direct human claim through --actor", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Configured Human Claim"]);

    const claimed = runJson(rootDir, ["--actor", "human:person_zeyu", "task", "claim", created.taskId], true, {
      HARNESS_ACTOR: ""
    });
    const holder = claimed.report.effectiveHolder;

    assert.equal(holder.principal.personId, "person_zeyu");
    assert.equal(holder.executor, null);
    assert.equal(holder.responsibleHuman, "person:person_zeyu");
  });
});

test("default claim and submit use Holder V2 without requiring an execution id", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Execution Saga"]);
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, {
      HARNESS_ACTOR: "agent:test",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "codex-primary-session",
      CODEX_SESSION_ID: "codex-primary-session"
    });

    assert.match(claimed.executionId, /^exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u);
    assert.match(claimed.report.leaseToken, /^[0-9a-f]{64}$/u);
    assert.deepEqual(claimed.report.actor.executor, { kind: "agent", id: "test" });
    const leaseLedgerBody = readFileSync(path.join(
      rootDir,
      `.harness/generated/runtime-events/lease-${claimed.executionId}.jsonl`
    ), "utf8");
    const leaseEvents = leaseLedgerBody.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(leaseEvents.map((event) => event.lease.action), ["reserved", "activated"]);
    assert.equal(leaseEvents.every((event) => event.schema === "runtime-event/v2" && event.kind === "lease"), true);
    assert.doesNotMatch(leaseLedgerBody, /token|hash|credential/iu);
    const execution = JSON.parse(readFileSync(path.join(
      rootDir,
      `harness/tasks/${created.taskId}-execution-saga/executions/${claimed.executionId}.md`
    ), "utf8"));
    assert.equal(execution.session_bindings[0]?.role, "primary");
    assert.equal(execution.session_bindings[0]?.session_ref, "session/codex-primary-session");
    assert.equal(execution.session_bindings[0]?.archive_status, "pending");

    const homeDir = path.join(rootDir, "home");
    const codexLogs = path.join(homeDir, ".codex/sessions");
    mkdirSync(codexLogs, { recursive: true });
    writeFileSync(path.join(codexLogs, "codex-primary-session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "implement F4" }
      }),
      JSON.stringify({
        timestamp: "2026-07-11T00:00:02.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "F4 ready" }] }
      })
    ].join("\n"), "utf8");

    const submitted = runJson(rootDir, [
      "task", "transition", created.taskId, "in_review",
      "--lease-token", claimed.report.leaseToken,
      "--summary", "ready for review",
      "--verification", "node:test",
      "--output", "commit:abc123"
    ], true, {
      HARNESS_ACTOR: "agent:test",
      HOME: homeDir,
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "codex-primary-session",
      CODEX_SESSION_ID: "codex-primary-session"
    });

    assert.equal(submitted.status, "in_review");
    assert.equal(submitted.report.leaseReleased, true);
    const holder = runJson(rootDir, ["task", "holder", created.taskId]);
    assert.equal(holder.report.effectiveHolder, null);
  });
});

test("lease-enforced relation writes fail closed and persist after the related task is claimed", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const source = runJson(rootDir, ["new-task", "--title", "Relation Source"]);
    const target = runJson(rootDir, ["new-task", "--title", "Relation Target"]);

    const taskRejected = runJson(rootDir, [
      "task", "relate", source.taskId, "depends-on", target.taskId,
      "--rationale", "Source requires target"
    ], false);
    assert.equal(taskRejected.ok, false);
    assert.match(taskRejected.error?.hint ?? "", /requires an active lease/u);
    assert.equal(runJson(rootDir, ["relation", "list", "--source", `task/${source.taskId}`]).rows, 0);

    runJson(rootDir, ["task", "claim", source.taskId]);
    const taskRelated = runJson(rootDir, [
      "task", "relate", source.taskId, "depends-on", target.taskId,
      "--rationale", "Source requires target"
    ]);
    assert.equal(taskRelated.ok, true);
    assert.equal(runJson(rootDir, ["relation", "list", "--source", `task/${source.taskId}`]).rows, 1);

    runJson(rootDir, [
      "decision", "propose", "--id", "dec_RELATION_LEASE", "--title", "Relation lease",
      "--question", "Should the task be derived?", "--chosen", "Derive the task",
      "--rejected", "Leave it orphaned", "--why-not", "Lineage must be explicit",
      "--claim", "The decision derives the task."
    ]);
    const decisionRejected = runJson(rootDir, [
      "decision", "relate", "dec_RELATION_LEASE", "--anchor", "CH1", "--type", "derives",
      "--target", `task/${target.taskId}`, "--rationale", "Decision creates target"
    ], false);
    assert.equal(decisionRejected.ok, false);
    assert.match(decisionRejected.error?.hint ?? "", /requires an active lease/u);
    assert.equal(runJson(rootDir, ["relation", "list", "--source", "decision/dec_RELATION_LEASE/CH1"]).rows, 0);

    runJson(rootDir, ["task", "claim", target.taskId]);
    const decisionRelated = runJson(rootDir, [
      "decision", "relate", "dec_RELATION_LEASE", "--anchor", "CH1", "--type", "derives",
      "--target", `task/${target.taskId}`, "--rationale", "Decision creates target"
    ]);
    assert.equal(decisionRelated.ok, true);
    assert.equal(runJson(rootDir, ["relation", "list", "--source", "decision/dec_RELATION_LEASE/CH1"]).rows, 1);
  });
});

test("same configured person can renew a claim through a different agent", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Agent Handoff Claim"]);

    runJson(rootDir, ["task", "claim", created.taskId], true, { HARNESS_ACTOR: "agent:codex" });
    const renewed = runJson(rootDir, ["task", "claim", created.taskId], true, { HARNESS_ACTOR: "agent:claude-code" });

    assert.equal(renewed.report.effectiveHolder.principal.personId, "person_zeyu");
    assert.deepEqual(renewed.report.effectiveHolder.executor, { kind: "agent", id: "claude-code" });
  });
});

test("configured identity must match people.yaml when a roster is present", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Roster Checked Claim"]);
    writePeopleRoster(rootDir, "person_alice", "Alice");

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AuthMissing");
    assert.match(rejected.error?.hint ?? "", /person_zeyu.*people\.yaml/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeHarnessIdentity(rootDir: string, personId: string, displayName: string): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    `    personId: ${personId}`,
    `    displayName: ${displayName}`
  ]);
}

function writeHarnessLeaseEnforcement(rootDir: string, enabled: boolean): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    "    personId: person_tester",
    "    displayName: Harness Tester",
    "  tasks:",
    `    leaseEnforcement: ${enabled}`
  ]);
}

function writeHarnessIdentityWithLeaseEnforcement(
  rootDir: string,
  personId: string,
  displayName: string,
  enabled: boolean
): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    `    personId: ${personId}`,
    `    displayName: ${displayName}`,
    "  tasks:",
    `    leaseEnforcement: ${enabled}`
  ]);
}

function writeHarnessConfig(rootDir: string, extraLines: ReadonlyArray<string> = []): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    ...extraLines,
    ""
  ].join("\n"), "utf8");
}

function existsTaskHolder(rootDir: string, taskId: string): boolean {
  try {
    readFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readTaskHolder(rootDir: string, taskId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), "utf8")) as Record<string, any>;
}

function expireTaskHolder(rootDir: string, taskId: string): void {
  const record = readTaskHolder(rootDir, taskId);
  writeFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), JSON.stringify({
    ...record,
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "1999-12-31T23:59:00.000Z"
  }), "utf8");
}

function writePeopleRoster(rootDir: string, personId: string, displayName: string): void {
  writeFileSync(path.join(rootDir, "harness/people.yaml"), JSON.stringify({
    schema: "harness-people/v1",
    people: [{ personId, displayName, roles: ["writer"], credentials: [] }],
    roles: [{ roleId: "writer", commandClasses: ["repo-write", "repo-read"] }]
  }), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const childEnv = {
      ...process.env,
      HARNESS_ACTOR: "agent:harness-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Tester",
      HARNESS_GIT_AUTHOR_EMAIL: "tester@example.test",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "test",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
      ZCODE_SESSION_ID: "",
      ANTIGRAVITY_SESSION_ID: "",
      ...env
    };
    delete childEnv.HARNESS_TASK_LEASE_ENFORCEMENT;
    if (env.HARNESS_TASK_LEASE_ENFORCEMENT !== undefined) {
      childEnv.HARNESS_TASK_LEASE_ENFORCEMENT = env.HARNESS_TASK_LEASE_ENFORCEMENT;
    }
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: childEnv
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
