// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision relate seeds missing task priority metadata once for derives edges", () => {
  withTempRoot((rootDir) => {
    proposeDecision(rootDir, "dec_SEED_TASK", "Seed task metadata", "high", "low");
    const task = runJson(rootDir, ["task", "create", "--title", "Seeded Task"]);

    const result = runJson(rootDir, [
      "decision",
      "relate",
      "dec_SEED_TASK",
      "--anchor",
      "CH1",
      "--type",
      "derives",
      "--target",
      `task/${task.taskId}`,
      "--rationale",
      "Decision derives implementation work"
    ]);

    assert.equal(result.ok, true);
    assert.match(readTaskIndex(rootDir, task), /^riskTier: high$/mu);
    assert.match(readTaskIndex(rootDir, task), /^urgency: low$/mu);
  });
});

test("CLI decision relate preserves explicit task priority overrides per axis", () => {
  withTempRoot((rootDir) => {
    proposeDecision(rootDir, "dec_OVERRIDE_TASK", "Override task metadata", "high", "medium");
    const task = runJson(rootDir, ["task", "create", "--title", "Override Task", "--risk-tier", "low"]);

    runDerives(rootDir, "dec_OVERRIDE_TASK", task.taskId);

    const index = readTaskIndex(rootDir, task);
    assert.match(index, /^riskTier: low$/mu);
    assert.match(index, /^urgency: medium$/mu);
  });
});

test("CLI decision relate uses first-writer-wins for multiple derives decisions", () => {
  withTempRoot((rootDir) => {
    proposeDecision(rootDir, "dec_FIRST_TASK", "First task metadata", "high", "low");
    proposeDecision(rootDir, "dec_SECOND_TASK", "Second task metadata", "low", "high");
    const task = runJson(rootDir, ["task", "create", "--title", "Multi Derives Task"]);

    runDerives(rootDir, "dec_FIRST_TASK", task.taskId);
    runDerives(rootDir, "dec_SECOND_TASK", task.taskId);

    const index = readTaskIndex(rootDir, task);
    assert.match(index, /^riskTier: high$/mu);
    assert.match(index, /^urgency: low$/mu);
  });
});

test("CLI decision relation replace seeds task priority metadata for replacement derives edge", () => {
  withTempRoot((rootDir) => {
    proposeDecision(rootDir, "dec_REPLACE_SEED", "Replace seed metadata", "medium", "high");
    proposeDecision(rootDir, "dec_REPLACE_TARGET", "Replace target decision", "low", "low");
    const task = runJson(rootDir, ["task", "create", "--title", "Replace Seeded Task"]);
    runJson(rootDir, [
      "decision",
      "relate",
      "dec_REPLACE_SEED",
      "--anchor",
      "CH1",
      "--type",
      "relates",
      "--target",
      "decision/dec_REPLACE_TARGET",
      "--rationale",
      "Initial non-task relation"
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_REPLACE_SEED/decision.md");
    const relationId = /relation_id: "(rel_[a-f0-9]{16})"/u.exec(readFileSync(decisionPath, "utf8"))?.[1];
    assert.ok(relationId);

    runJson(rootDir, [
      "decision",
      "relation",
      "replace",
      "dec_REPLACE_SEED",
      "--relation",
      relationId,
      "--anchor",
      "CH1",
      "--type",
      "derives",
      "--target",
      `task/${task.taskId}`,
      "--rationale",
      "Replacement relation derives task work"
    ]);

    const index = readTaskIndex(rootDir, task);
    assert.match(index, /^riskTier: medium$/mu);
    assert.match(index, /^urgency: high$/mu);
  });
});

test("CLI decision relate does not seed task metadata for non-derives or dry-run relations", () => {
  withTempRoot((rootDir) => {
    proposeDecision(rootDir, "dec_NO_SEED_TASK", "No seed metadata", "high", "high");
    const nonDerivesTask = runJson(rootDir, ["task", "create", "--title", "Related Task"]);
    const dryRunTask = runJson(rootDir, ["task", "create", "--title", "Dry Run Task"]);

    runJson(rootDir, [
      "decision",
      "relate",
      "dec_NO_SEED_TASK",
      "--anchor",
      "CH1",
      "--type",
      "relates",
      "--target",
      `task/${nonDerivesTask.taskId}`,
      "--rationale",
      "Decision only relates to the task"
    ]);
    runJson(rootDir, [
      "decision",
      "relate",
      "dec_NO_SEED_TASK",
      "--anchor",
      "CH1",
      "--type",
      "derives",
      "--target",
      `task/${dryRunTask.taskId}`,
      "--rationale",
      "Dry-run derives relation",
      "--dry-run"
    ]);

    assert.doesNotMatch(readTaskIndex(rootDir, nonDerivesTask), /^riskTier:/mu);
    assert.doesNotMatch(readTaskIndex(rootDir, nonDerivesTask), /^urgency:/mu);
    assert.doesNotMatch(readTaskIndex(rootDir, dryRunTask), /^riskTier:/mu);
    assert.doesNotMatch(readTaskIndex(rootDir, dryRunTask), /^urgency:/mu);
  });
});

function runDerives(rootDir: string, decisionId: string, taskId: string): void {
  runJson(rootDir, [
    "decision",
    "relate",
    decisionId,
    "--anchor",
    "CH1",
    "--type",
    "derives",
    "--target",
    `task/${taskId}`,
    "--rationale",
    "Decision derives implementation work"
  ]);
}

function proposeDecision(rootDir: string, decisionId: string, title: string, riskTier: string, urgency: string): void {
  runJson(rootDir, [
    "decision",
    "propose",
    "--id",
    decisionId,
    "--title",
    title,
    "--question",
    `${title}?`,
    "--chosen",
    "Use the proposed path",
    "--rejected",
    "Leave it undefined",
    "--why-not",
    "The relation behavior needs a concrete source decision",
    "--risk-tier",
    riskTier,
    "--urgency",
    urgency
  ]);
}

function readTaskIndex(rootDir: string, task: Record<string, any>): string {
  assert.equal(typeof task.packagePath, "string");
  return readFileSync(path.join(rootDir, task.packagePath, "INDEX.md"), "utf8");
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-task-metadata-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTIGRAVITY_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        CODEX_THREAD_ID: "",
        ZCODE_SESSION_ID: ""
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
