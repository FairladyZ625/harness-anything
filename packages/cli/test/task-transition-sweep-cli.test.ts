// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI in_review and complete sweeps commit hand-edited closeout.md", () => {
  withGitTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Sweep Closeout"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const taskPath = String(created.packagePath);
    writeSubstantiveTaskPlan(rootDir, taskPath);
    const closeoutPath = path.join(rootDir, taskPath, "closeout.md");

    runJson(rootDir, ["task", "transition", taskId, "active"]);
    writeFileSync(closeoutPath, "# Closeout\n\nPrepared before review.\n", "utf8");
    assert.match(gitStatus(rootDir, taskPath), /closeout\.md/u);

    const executionId = submitExecutionForReview(rootDir, taskId);
    assert.equal(gitStatus(rootDir, taskPath), "");

    writeFact(rootDir, taskPath);
    writeReview(rootDir, taskPath);
    writeFileSync(closeoutPath, "# Closeout\n\nUpdated before completion.\n", "utf8");
    writeCodeDocAnchors(rootDir, taskPath, taskId);
    approveExecution(rootDir, taskId, executionId);
    assert.match(gitStatus(rootDir, taskPath), /closeout\.md/u);

    const completed = runJson(rootDir, ["task", "complete", taskId, "--reviewer", "reviewer-a", "--ci", "passed"], true, actorEnv("commander"));

    assert.equal(completed.ok, true);
    assert.equal(completed.status, "done");
    assert.equal(gitStatus(rootDir, taskPath), "");
    assert.match(readFileSync(closeoutPath, "utf8"), /Updated before completion/u);
  });
});

for (const preset of ["milestone-closeout"] as const) {
  test(`CLI task complete queues a distill candidate for ${preset}`, () => {
    withGitTempRoot((rootDir) => {
      const created = runJson(rootDir, [
        "new-task",
        "--title",
        `Closeout Candidate ${preset}`,
        "--vertical",
        "software/coding",
        "--preset",
        preset
      ]);
      const taskId = assertGeneratedTaskId(created.taskId);
      const taskPath = String(created.packagePath);
      writeSubstantiveTaskPlan(rootDir, taskPath);
      const closeoutPath = path.join(rootDir, taskPath, "closeout.md");
      const factsPath = path.join(rootDir, taskPath, "facts.md");

      runJson(rootDir, ["task", "transition", taskId, "active"]);
      const executionId = submitExecutionForReview(rootDir, taskId);
      writeFact(rootDir, taskPath);
      writeReview(rootDir, taskPath);
      writeFileSync(closeoutPath, `# Closeout\n\n${preset} generated a closeout candidate source.\n`, "utf8");
      writeCodeDocAnchors(rootDir, taskPath, taskId);
      approveExecution(rootDir, taskId, executionId);
      const factsBefore = readFileSync(factsPath, "utf8");

      const completed = runJson(rootDir, ["task", "complete", taskId, "--reviewer", "reviewer-a", "--ci", "passed"], true, actorEnv("commander"));

      assert.equal(completed.ok, true);
      assert.equal(completed.status, "done");
      assert.equal(completed.report.distillCandidate.queued, true);
      assert.equal(completed.report.distillCandidate.report.factWrite, false);
      const candidatePath = String(completed.report.distillCandidate.path);
      assert.match(candidatePath, new RegExp(`^\\.harness/generated/distill/${taskId}/distill_[^/]+\\.json$`, "u"));
      const artifact = JSON.parse(readFileSync(path.join(rootDir, candidatePath), "utf8")) as Record<string, unknown>;
      assert.equal(artifact.schema, "distill-candidate/v1");
      assert.equal(artifact.taskId, taskId);
      assert.equal(artifact.command, "ha distill candidate");
      assert.equal(artifact.factState, "candidate");
      assert.equal(artifact.inputPath, `${taskPath}/closeout.md`);
      assert.equal(readFileSync(factsPath, "utf8"), factsBefore);
    });
  });
}

test("CLI transition sweep commits orchestration markdown but never commits logs", () => {
  withGitTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Sweep Logs"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const taskPath = String(created.packagePath);
    writeSubstantiveTaskPlan(rootDir, taskPath);
    runJson(rootDir, ["task", "transition", taskId, "active"]);

    const orchestrationDir = path.join(rootDir, taskPath, "artifacts/orchestration");
    mkdirSync(orchestrationDir, { recursive: true });
    writeFileSync(path.join(orchestrationDir, "mission.md"), "# Mission\n\nKeep this context.\n", "utf8");
    writeFileSync(path.join(orchestrationDir, "codex.log"), "transient log\n", "utf8");

    submitExecutionForReview(rootDir, taskId);

    assert.equal(gitStatus(rootDir, taskPath), "");
    assert.equal(gitLsFiles(rootDir, `${taskPath}/artifacts/orchestration/mission.md`), `${taskPath}/artifacts/orchestration/mission.md`);
    assert.equal(gitLsFiles(rootDir, `${taskPath}/artifacts/orchestration/codex.log`), "");
  });
});

test("CLI task complete blocks when the task tree is dirty after the sweep", () => {
  withGitTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Dirty Complete"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const taskPath = String(created.packagePath);
    writeSubstantiveTaskPlan(rootDir, taskPath);
    runJson(rootDir, ["task", "transition", taskId, "active"]);
    const executionId = submitExecutionForReview(rootDir, taskId);
    writeFact(rootDir, taskPath);
    writeReview(rootDir, taskPath);
    writeFileSync(path.join(rootDir, taskPath, "closeout.md"), "# Closeout\n\nReady.\n", "utf8");
    writeCodeDocAnchors(rootDir, taskPath, taskId);
    approveExecution(rootDir, taskId, executionId);
    installPostCommitDirtyHook(rootDir, taskPath);

    const failure = runJson(rootDir, ["task", "complete", taskId, "--reviewer", "reviewer-a", "--ci", "passed"], false, actorEnv("commander"));

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "task_tree_dirty");
    assert.match(gitStatus(rootDir, taskPath), /post-commit-dirty\.md/u);
    assert.match(readFileSync(path.join(rootDir, taskPath, "INDEX.md"), "utf8"), /status: in_review/);
  });
});

function withGitTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-transition-sweep-"));
  const harnessRoot = path.join(rootDir, "harness");
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Test User"]);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(harnessRoot, { recursive: true });
    execFileSync("git", ["-C", harnessRoot, "init", "-q"]);
    execFileSync("git", ["-C", harnessRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Test User"]);
    writeFileSync(path.join(harnessRoot, ".gitignore"), "*.log\n", "utf8");
    ensureTestHarnessIdentity(rootDir);
    execFileSync("git", ["-C", harnessRoot, "add", ".gitignore", "harness.yaml"]);
    execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed harness gitignore"]);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_ACTOR: "agent:harness-test", ...env })
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function submitExecutionForReview(rootDir: string, taskId: string): string {
  const sessionId = `sweep-${taskId}`;
  const homeDir = path.join(rootDir, "home");
  const sessionDir = path.join(homeDir, ".codex/sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-12T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "submit sweep task" } }),
    JSON.stringify({ timestamp: "2026-07-12T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
  ].join("\n"), "utf8");
  const env = {
    ...actorEnv("worker"),
    HOME: homeDir,
    CODEX_THREAD_ID: sessionId,
    CODEX_SESSION_ID: sessionId
  };
  const claimed = runJson(rootDir, ["task", "claim", taskId, "--execution"], true, env);
  const executionId = String(claimed.executionId);
  const submitted = runJson(rootDir, [
    "task", "transition", taskId, "in_review",
    "--lease-token", String(claimed.report.leaseToken),
    "--summary", "sweep task ready for review",
    "--verification", "transition sweep fixture passed"
  ], true, env);
  assert.equal(submitted.executionId, executionId);
  return executionId;
}

function approveExecution(rootDir: string, taskId: string, executionId: string): void {
  const reviewed = runJson(rootDir, [
    "task", "review-execution", taskId,
    "--execution-id", executionId,
    "--verdict", "approved",
    "--findings", "The sweep behavior is verified.",
    "--rationale", "The submitted Execution satisfies this fixture.",
    "--consent-asserted", "Approval was received through an external channel."
  ], true, actorEnv("reviewer"));
  assert.equal(reviewed.executionId, executionId);
}

function actorEnv(id: string): Record<string, string> {
  return { HARNESS_ACTOR: `agent:${id}` };
}

function writeFact(rootDir: string, taskPath: string): void {
  writeFileSync(path.join(rootDir, taskPath, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}

function writeReview(rootDir: string, taskPath: string): void {
  writeFileSync(path.join(rootDir, taskPath, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n"), "utf8");
}

function writeCodeDocAnchors(rootDir: string, taskPath: string, taskId: string, sha = ensureAnchorCommit(rootDir)): void {
  runJson(rootDir, [
    "task", "code-doc", "reconcile", taskId,
    "--commit", sha,
    "--path", "evidence/code-doc-anchor.txt"
  ]);
}

function ensureAnchorCommit(rootDir: string): string {
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/code-doc-anchor.txt"), "code-doc reconciliation fixture\n", "utf8");
  execFileSync("git", ["-C", rootDir, "add", "evidence/code-doc-anchor.txt"]);
  execFileSync("git", ["-C", rootDir, "commit", "-m", "seed code-doc anchor"]);
  return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function installPostCommitDirtyHook(rootDir: string, taskPath: string): void {
  const hookPath = path.join(rootDir, "harness/.git/hooks/post-commit");
  writeFileSync(hookPath, [
    "#!/bin/sh",
    `printf 'dirty after sweep\\n' >> "${authoredRelativePath(taskPath)}/post-commit-dirty.md"`,
    ""
  ].join("\n"), "utf8");
  chmodSync(hookPath, 0o755);
}

function gitStatus(rootDir: string, taskPath: string): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), "status", "--porcelain", "-uall", "--", authoredRelativePath(taskPath)], {
    encoding: "utf8"
  }).trim();
}

function gitLsFiles(rootDir: string, filePath: string): string {
  const relativePath = authoredRelativePath(filePath);
  const trackedPath = execFileSync("git", ["-C", path.join(rootDir, "harness"), "ls-files", "--", relativePath], {
    encoding: "utf8"
  }).trim();
  return trackedPath.length === 0 ? "" : `harness/${trackedPath}`;
}

function authoredRelativePath(filePath: string): string {
  return filePath.startsWith("harness/") ? filePath.slice("harness/".length) : filePath;
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}
