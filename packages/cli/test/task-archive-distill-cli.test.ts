// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord, type EntityRelationRecord } from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI task archive batches filtered terminal tasks through package archive writes", () => {
  withTempRoot((rootDir) => {
    const first = runJson(rootDir, ["new-task", "--title", "First Done"]);
    const second = runJson(rootDir, ["new-task", "--title", "Second Done"]);
    const active = runJson(rootDir, ["new-task", "--title", "Still Active"]);
    const firstTaskId = assertGeneratedTaskId(first.taskId);
    const secondTaskId = assertGeneratedTaskId(second.taskId);
    const activeTaskId = assertGeneratedTaskId(active.taskId);
    for (const task of [first, second, active]) writeSubstantiveTaskPlan(rootDir, String(task.packagePath));
    for (const taskId of [firstTaskId, secondTaskId]) {
      runJson(rootDir, ["task", "status", "set", taskId, "active"]);
      runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "batch fixture"]);
    }
    runJson(rootDir, ["task", "status", "set", activeTaskId, "active"]);

    const result = runJson(rootDir, ["task", "archive", "--filter", "state:done", "--before", "2999-01-01", "--reason", "batch containment"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-archive");
    assert.equal(result.rows, 2);
    assert.deepEqual(result.tasks.map((entry: Record<string, unknown>) => entry.taskId).sort(), [firstTaskId, secondTaskId].sort());
    assert.match(readFileSync(path.join(rootDir, String(first.packagePath), "INDEX.md"), "utf8"), /packageDisposition: archived/);
    assert.match(readFileSync(path.join(rootDir, String(second.packagePath), "INDEX.md"), "utf8"), /packageDisposition: archived/);
    assert.match(readFileSync(path.join(rootDir, String(active.packagePath), "INDEX.md"), "utf8"), /packageDisposition: active/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI task archive creates a distill candidate from closeout content before archiving", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Candidate Archive"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    writeFileSync(path.join(rootDir, String(created.packagePath), "closeout.md"), [
      "# Closeout",
      "",
      "Archive candidate preserves a durable task fact before stage containment.",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["task", "archive", taskId, "--reason", "stage contained"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-archive");
    assert.match(result.report.candidatePath, new RegExp(`^\\.harness/generated/distill/${taskId}/distill_[^/]+\\.json$`, "u"));
    const artifact = JSON.parse(readFileSync(path.join(rootDir, String(result.report.candidatePath)), "utf8")) as Record<string, unknown>;
    assert.equal(artifact.schema, "distill-candidate/v1");
    assert.equal(artifact.taskId, taskId);
    assert.equal(artifact.command, "ha task archive");
    assert.equal(artifact.inputPath, `${created.packagePath}/closeout.md`);
    assert.match(readFileSync(path.join(rootDir, String(created.packagePath), "INDEX.md"), "utf8"), /packageDisposition: archived/);
  });
});

test("CLI task archive writes runtime distill artifacts through the canonical repo when harness is a nested repo", () => {
  withTempRoot((rootDir) => {
    initNestedHarnessRepo(rootDir);
    const created = runJson(rootDir, ["new-task", "--title", "Nested Repo Archive"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    writeFileSync(path.join(rootDir, String(created.packagePath), "closeout.md"), [
      "# Closeout",
      "",
      "Nested repo archive preserves a distill candidate outside the authored harness repo.",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["task", "archive", taskId, "--reason", "nested repo containment"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-archive");
    assert.match(result.report.candidatePath, new RegExp(`^\\.harness/generated/distill/${taskId}/distill_[^/]+\\.json$`, "u"));
    assert.match(readFileSync(path.join(rootDir, String(created.packagePath), "INDEX.md"), "utf8"), /packageDisposition: archived/);
  });
});

test("CLI task archive fails closed when a task-owned relation endpoint is unresolved", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Unresolved Fact Archive"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const packagePath = path.join(rootDir, String(created.packagePath));
    const indexPath = path.join(packagePath, "INDEX.md");
    const before = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, appendIndexRelation(before, relationRecord(`task/${taskId}`, `fact/${taskId}/F-MISSING1`)), "utf8");

    const result = runJson(rootDir, ["task", "archive", taskId, "--reason", "blocked by unresolved anchor"], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "task-archive");
    assert.equal(result.error?.code, "archive_reference_unresolved");
    assert.match(result.error?.hint ?? "", /unresolved relation endpoint/u);
    assert.match(readFileSync(indexPath, "utf8"), /packageDisposition: active/);
  });
});

test("CLI task archive preflights all batch ids before mutating any package", () => {
  withTempRoot((rootDir) => {
    const first = runJson(rootDir, ["new-task", "--title", "First Batch Archive"]);
    const second = runJson(rootDir, ["new-task", "--title", "Second Batch Archive"]);
    const firstTaskId = assertGeneratedTaskId(first.taskId);
    const secondTaskId = assertGeneratedTaskId(second.taskId);
    for (const task of [first, second]) writeSubstantiveTaskPlan(rootDir, String(task.packagePath));
    for (const taskId of [firstTaskId, secondTaskId]) {
      runJson(rootDir, ["task", "status", "set", taskId, "active"]);
      runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "batch fixture"]);
    }
    const firstIndexPath = path.join(rootDir, String(first.packagePath), "INDEX.md");
    const secondIndexPath = path.join(rootDir, String(second.packagePath), "INDEX.md");
    const secondBefore = readFileSync(secondIndexPath, "utf8");
    writeFileSync(secondIndexPath, appendIndexRelation(secondBefore, relationRecord(`task/${secondTaskId}`, `fact/${secondTaskId}/F-MISSING1`)), "utf8");

    const result = runJson(rootDir, ["task", "archive", "--ids", `${firstTaskId},${secondTaskId}`, "--reason", "batch containment"], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "task-archive");
    assert.equal(result.taskId, secondTaskId);
    assert.equal(result.error?.code, "archive_reference_unresolved");
    assert.match(readFileSync(firstIndexPath, "utf8"), /packageDisposition: active/);
    assert.match(readFileSync(secondIndexPath, "utf8"), /packageDisposition: active/);
  });
});

function appendIndexRelation(body: string, relation: EntityRelationRecord): string {
  const line = formatRelationFlowRecord(relation);
  const nextBody = body.replace("---\n\n#", `relations:\n${line}\n---\n\n#`);
  return nextBody === body ? `${body.trimEnd()}\nrelations:\n${line}\n` : nextBody;
}

function relationRecord(source: string, target: string): EntityRelationRecord {
  const base = {
    source,
    target,
    type: "relates" as const,
    direction: "directed" as const
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale: "Archive reference guard fixture",
    state: "active"
  };
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-archive-distill-cli-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initNestedHarnessRepo(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  initGitRepo(rootDir);
  initGitRepo(harnessRoot);
}

function initGitRepo(repoRoot: string): void {
  execFileSync("git", ["-C", repoRoot, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoRoot, "-c", "user.name=Harness Test", "-c", "user.email=harness-test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { stdio: "ignore" });
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
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
