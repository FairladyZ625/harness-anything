// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision reckon fails closed when entity readers receive withheld projection warnings", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Reckon Projection Conflict"]);
    runJson(rootDir, [
      "fact", "record",
      "--task", task.taskId,
      "--id", "F-C0NFX1C1",
      "--statement", "The conflict fixture covers the load-bearing claim.",
      "--source", "test",
      "--confidence", "high"
    ]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_RECKON_CONFLICT",
      "--title", "Reckon projection conflict",
      "--question", "Should reckon write through an incomplete entity projection?",
      "--chosen", "Refuse the write",
      "--rejected", "Write the fact anyway",
      "--why-not", "The projection warning makes the exact source set indeterminate",
      "--evidence-relation", `C1:evidenced-by:fact/${task.taskId}/F-C0NFX1C1:Fixture evidence covers C1`
    ]);
    runJson(rootDir, ["decision", "accept", "dec_RECKON_CONFLICT"]);

    const taskPackage = readdirSync(path.join(rootDir, "harness/tasks")).find((entry) => entry.startsWith(task.taskId));
    assert.ok(taskPackage);
    writeDuplicateExecutionFixture(rootDir, task.taskId, taskPackage);

    const result = runJson(rootDir, ["decision", "reckon", "dec_RECKON_CONFLICT", "--task", task.taskId], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "projection_check_failed");
    assert.equal(result.report.projectionWarnings.some((warning: Record<string, any>) => warning.code === "declared_identity_conflict"), true);
    assert.equal(result.warnings.some((warning: Record<string, any>) => warning.code === "declared_identity_conflict"), true);
    assert.doesNotMatch(
      readFileSync(path.join(rootDir, "harness/tasks", taskPackage, "facts.md"), "utf8"),
      /Decision dec_RECKON_CONFLICT reckon/u
    );
  });
});

function writeDuplicateExecutionFixture(rootDir: string, taskId: string, taskPackage: string): void {
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5";
  const body = `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "active",
    primary_actor: {
      principal: { personId: "person_fixture" },
      executor: { kind: "agent", id: "fixture" },
      responsibleHuman: "person_fixture"
    },
    claimed_at: "2026-08-05T00:00:00.000Z",
    submitted_at: null,
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: null
  }, null, 2)}\n`;
  for (const directory of [taskPackage, taskId]) {
    const executionPath = path.join(rootDir, "harness/tasks", directory, "executions", `${executionId}.md`);
    mkdirSync(path.dirname(executionPath), { recursive: true });
    writeFileSync(executionPath, body, "utf8");
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-projection-warning-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  const cliArgs = independentDecisionJudgmentArgs(args);
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...cliArgs], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function independentDecisionJudgmentArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (args[0] !== "decision" || !["accept", "reject", "defer", "supersede", "retire"].includes(args[1] ?? "")) return args;
  return ["--actor", "human:person_test", ...args];
}
