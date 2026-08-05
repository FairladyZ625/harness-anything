// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const cleanGitEnv = {
  PATH: process.env.PATH,
  HOME: path.join(tmpdir(), "ha-coldstart-empty-home"),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  HARNESS_ACTOR: "agent:coldstart-test",
  HARNESS_GIT_AUTHOR_NAME: "Harness Coldstart Test",
  HARNESS_GIT_AUTHOR_EMAIL: "coldstart@example.invalid",
  HARNESS_DAEMON_MODE: "fixture",
  HARNESS_CLI_TEST_FIXTURE_PRELOAD: process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD,
  NODE_OPTIONS: process.env.NODE_OPTIONS
} satisfies NodeJS.ProcessEnv;

test("fresh init creates a workspace HEAD without ambient git identity", () => {
  withTempRoot((rootDir) => {
    const initialized = runJson(rootDir, ["init"], {
      HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user")
    });

    assert.equal(initialized.ok, true);
    assert.equal(runGit(rootDir, "rev-parse", "--is-inside-work-tree"), "true");
    assert.match(runGit(rootDir, "rev-parse", "--verify", "HEAD^{commit}"), /^[0-9a-f]{40}$/u);
    assert.equal(runGit(rootDir, "rev-list", "--count", "HEAD"), "1");
    assert.equal(initialized.report.isolation.outerGit.action, "initialized");
    assert.equal(initialized.report.isolation.outerGit.initialCommitCreated, true);
  });
});

test("task packet help templates parse while approval dry-run requires the authority planner", () => {
  withTempRoot((rootDir) => {
    const repoEnv = { HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user") };
    runJson(rootDir, ["init"], repoEnv);
    const created = runJson(rootDir, [
      "task", "create", "--title", "Coldstart packet templates",
      "--vertical", "software/coding", "--preset", "standard-task"
    ], repoEnv);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "coldstart-template-session";
    const homeDir = path.join(rootDir, "home");
    mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
    writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-07-31T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "verify packet templates" } }),
      JSON.stringify({ timestamp: "2026-07-31T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "verified" }] } })
    ].join("\n"), "utf8");
    const sessionEnv = { ...repoEnv, HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };
    runJson(rootDir, ["task", "start", created.taskId], sessionEnv);

    const submission = packetTemplate(rootDir, ["task", "submit", "--help"]);
    const submissionPath = path.join(rootDir, "submission.json");
    writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`, "utf8");
    const submissionDryRun = runJson(rootDir, [
      "task", "submit", created.taskId, "--from-file", submissionPath, "--dry-run"
    ], sessionEnv);
    assert.equal(submissionDryRun.ok, true);
    runJson(rootDir, ["task", "submit", created.taskId, "--from-file", submissionPath], sessionEnv);

    writeFileSync(path.join(rootDir, created.packagePath, "closeout.md"), [
      "# Closeout",
      "",
      "## Summary",
      "",
      "Verified the copy-ready packet templates.",
      "",
      "## Verification",
      "",
      "Both packets passed their CLI dry-runs.",
      "",
      "## Residual Risk",
      "",
      "No residual risk observed.",
      ""
    ].join("\n"), "utf8");
    const approval = packetTemplate(rootDir, ["task", "complete", "--help"]);
    const approvalPath = path.join(rootDir, "approval.json");
    writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
    const indexPath = path.join(rootDir, created.packagePath, "INDEX.md");
    const indexBeforeDryRun = readFileSync(indexPath, "utf8");
    const approvalDryRun = runJsonFailure(rootDir, [
      "task", "complete", created.taskId,
      "--approve", "--from-file", approvalPath, "--dry-run"
    ], sessionEnv);
    assert.equal(approvalDryRun.ok, false);
    assert.equal(approvalDryRun.error.code, "write_rejected");
    assert.match(approvalDryRun.error.hint, /canonical authority planner is unavailable/iu);
    assert.equal(readFileSync(indexPath, "utf8"), indexBeforeDryRun);
  });
});

function packetTemplate(rootDir: string, args: ReadonlyArray<string>): Record<string, unknown> {
  const help = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: cleanGitEnv
  });
  const match = help.match(/Packet template \(copy as [^)]+\):\n([\s\S]+?)(?:\n\n|$)/u);
  assert.notEqual(match, null, help);
  return JSON.parse(match![1]!.split("\n").map((line) => line.replace(/^  /u, "")).join("\n")) as Record<string, unknown>;
}

function runJson(rootDir: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...cleanGitEnv, ...env }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function runJsonFailure(rootDir: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...cleanGitEnv, ...env }
  });
  assert.notEqual(result.status, 0, result.stdout || result.stderr);
  return unwrapCommandReceipt(JSON.parse(result.stdout) as Record<string, any>);
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: cleanGitEnv
  }).trim();
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-coldstart-p1-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
