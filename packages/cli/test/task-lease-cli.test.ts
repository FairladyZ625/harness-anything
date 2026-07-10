import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("task lease enforcement defaults off and rejects progress writes when enabled without a lease", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_tester", "Harness Tester");
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const defaultOff = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "discipline period write"]);
    assert.equal(defaultOff.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), /discipline period write/u);

    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "guarded write"], false, {
      HARNESS_TASK_LEASE_ENFORCEMENT: "1"
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "write_rejected");
    assert.match(rejected.error?.hint ?? "", /requires an active lease/u);
  });
});

test("task claim fails closed when HARNESS_ACTOR names an agent but settings.identity is missing", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Missing Identity Claim"]);
    writeHarnessConfig(rootDir);

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AuthMissing");
    assert.match(rejected.error?.hint ?? "", /settings\.identity\.personId/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
    assert.equal(JSON.stringify(rejected).includes("person:claude-code"), false);
  });
});

test("lease enforcement reports missing configured identity instead of journal failure", () => {
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
    assert.match(rejected.error?.hint ?? "", /settings\.identity\.personId/u);
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

test("configured identity supports direct human claim without HARNESS_ACTOR", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Configured Human Claim"]);

    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, {
      HARNESS_ACTOR: ""
    });
    const holder = claimed.report.effectiveHolder;

    assert.equal(holder.principal.personId, "person_zeyu");
    assert.equal(holder.executor, null);
    assert.equal(holder.responsibleHuman, "person:person_zeyu");
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

function writePeopleRoster(rootDir: string, personId: string, displayName: string): void {
  writeFileSync(path.join(rootDir, "harness/people.yaml"), JSON.stringify({
    schema: "harness-people/v1",
    people: [{ personId, displayName, roles: ["writer"], credentials: [] }],
    roles: [{ roleId: "writer", commandClasses: ["repo-write", "repo-read"] }]
  }), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: "human:tester",
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
