// harness-test-tier: integration
import assert from "node:assert/strict";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const executionTaskId = "task_01KX7H00000000000000000000";
const executionId = "exe_01KX7H00000000000000000001";
// Execution role checks compare the CLI actor's executor against the execution's
// executor; pin the actor instead of inheriting whatever the invoking shell has.
const testActorEnv = { HARNESS_ACTOR: "agent:test" };

test("CLI task-complete without Execution preserves its legacy receipt and byte-exact INDEX transition", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeCloseout(rootDir, "task-1", [
      "## Summary",
      "",
      "Summarize the completed behavior change.",
      "",
      "## Verification",
      "",
      "List passing checks and CI.",
      "",
      "## Residual Risk",
      "",
      "Record accepted non-blocking risks."
    ]);

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "closeout_placeholder");
    assert.match(blocked.error?.hint ?? "", new RegExp(path.join(rootDir, "harness/tasks/task-1").replaceAll("\\", "\\\\"), "u"));

    writeRealCloseout(rootDir, "task-1");
    const indexPath = path.join(rootDir, "harness/tasks/task-1/INDEX.md");
    const before = readFileSync(indexPath, "utf8");

    const passed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.data?.status ?? passed.status, "done");
    assert.equal(JSON.stringify(passed).includes("executionId"), false);
    assert.equal(readFileSync(indexPath, "utf8"), before.replace(/^(  status:\s*).+$/mu, "$1done"));
  });
});

test("CLI task-complete rejects initial not-started review placeholders", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeFact(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/review.md"), [
      "# Review",
      "",
      "Status: not-started",
      "",
      "## Reviewer",
      "",
      "- Agent: pending",
      "- Mode: read-only review before merge",
      "",
      "## Findings",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ""
    ].join("\n"), "utf8");
    writeRealCloseout(rootDir, "task-1");

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "review_placeholder");
  });
});

test("CLI task-complete rejects missing code-doc anchors", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeCloseout(rootDir, "task-1", [
      "## Summary",
      "",
      "Implemented the task document gate.",
      "",
      "## Verification",
      "",
      "npm run check passed.",
      "",
      "## Residual Risk",
      "",
      "No residual risk accepted."
    ]);

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "code_doc_reconciliation_failed");
    assert.equal(blocked.issues?.[0]?.code, "code_doc_anchors_missing");
  });
});

test("CLI task-complete rejects fabricated code-doc shas", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1");
    writeCodeDocAnchorsRaw(rootDir, "task-1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "code_doc_reconciliation_failed");
    assert.equal(blocked.issues?.[0]?.code, "code_doc_git_ref_missing");
  });
});

test("CLI task-complete reports the underlying completion write failure", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, "task-1", "Complete Task", "in_review", { provenance: false });
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1", { coordinatedAnchors: false });

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "malformed_snapshot");
    assert.match(blocked.error?.hint, /Completion task-tree staging failed\./);
    assert.match(blocked.error?.hint, /minItems\(1\)|Expected a refinement/);
  });
});

test("CLI task-review accepts a task without facts under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");

    // dec_mrg3z1we/CH4: Fact is an explicit 0..N promotion, never a review quantity gate.
    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.command, "task-review");
    assert.equal(reviewed.data?.reviewContract?.schema ?? reviewed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-review invalid severity error enumerates valid severity values", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/review.md"), [
      "# Review",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| F-001 | P9 | Bad severity. | test | Fix severity. | yes | open | yes | none |",
      ""
    ].join("\n"), "utf8");

    const blocked = runJson(rootDir, ["task", "review", "task-1", "--reviewer", "reviewer-a"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "review_schema_invalid");
    assert.match(blocked.error?.hint ?? "", /Valid severity values: P0, P1, P2, P3/u);
  });
});

test("CLI task-review accepts a task with a real fact", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");

    const passed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(passed.ok, true);
    assert.equal(passed.command, "task-review");
    assert.equal(passed.data?.reviewContract?.schema ?? passed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-review and task-complete stage reviewed artifacts through WriteCoordinator", () => {
  withTempRoot((rootDir) => {
    const harnessRepo = path.join(rootDir, "harness");
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "seed task");
    runGit(harnessRepo, "add", "tasks/task-1/INDEX.md", "tasks/task-1/facts.md");
    runGit(harnessRepo, "commit", "-m", "seed task");

    writeReview(rootDir, "task-1");
    assert.match(runGit(harnessRepo, "status", "--short"), /review\.md/);

    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);
    assert.equal(reviewed.ok, true);
    assert.equal(runGit(harnessRepo, "status", "--short"), "");
    assert.match(runGit(harnessRepo, "log", "--oneline", "--all"), /task\(task-tree-stage\): task-1 task package/);

    writeRealCloseout(rootDir, "task-1");
    assert.match(runGit(harnessRepo, "status", "--short"), /closeout\.md/);

    const completed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(completed.ok, true);
    assert.equal(completed.data?.status ?? completed.status, "done");
    assert.equal(runGit(harnessRepo, "status", "--short"), "");
    assert.match(runGit(harnessRepo, "log", "--oneline", "--all"), /task\(transition\): task-1/);
    assert.match(runGit(harnessRepo, "log", "--oneline", "--all"), /task\(task-tree-stage\): task-1 task package/);
  });
});

test("CLI task-review ignores facts.md quantity under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/facts.md"), "# Facts\n\n- TODO: record a fact before closeout.\n", "utf8");

    // dec_mrg3z1we/CH4: zero parsed F- records is a valid review input.
    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.data?.reviewContract?.schema ?? reviewed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-complete without Execution accepts no facts under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1");

    // dec_mrg3z1we/CH4 removes only the Fact quantity gate; review, closeout,
    // code-doc reconciliation, and completion gates still run on this path.
    const completed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);

    assert.equal(completed.ok, true);
    assert.equal(completed.data?.status ?? completed.status, "done");
  });
});

test("CLI Review verdict rejects unknown values before writing", () => {
  withTempRoot((rootDir) => {
    const blocked = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "direction_changed",
      "--findings", "Change direction."
    ], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "invalid_task_metadata");
    assert.match(blocked.error?.hint ?? "", /approved, changes_requested, dismissed/u);
  });
});

test("CLI complete accepts an approved Execution Review without facts under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Execution Complete", "in_review");
    writeRealCloseout(rootDir, executionTaskId);
    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");

    const missingReview = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false, testActorEnv);
    assert.equal(missingReview.ok, false);
    assert.match(missingReview.error?.hint ?? "", /approved Review/u);

    const reviewed = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "approved",
      "--findings", "All acceptance checks passed.",
      "--rationale", "The submission satisfies the Task intent."
    ], true, testActorEnv);
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.executionId, executionId);
    assert.match(String(reviewed.reviewId), /^rev_/u);

    writeExecution(rootDir, executionTaskId, executionId, "test");
    const selfComplete = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false, testActorEnv);
    assert.match(selfComplete.error?.hint ?? "", /executor cannot complete/u);
    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");

    // dec_mrg3z1we/CH4: approved Review and completion gates do not imply a Fact quantity gate.
    const completed = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], true, testActorEnv);
    assert.equal(completed.ok, true);
    assert.equal(completed.executionId, executionId);
    assert.equal(completed.status, "done");
    const taskRoot = path.join(rootDir, "harness/tasks", executionTaskId);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "accepted");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  });
});

test("CLI rejects executor self-review and changes_requested opens a fresh claim round", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Execution Rework", "in_review");
    writeExecution(rootDir, executionTaskId, executionId, "test");
    const selfReview = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "approved",
      "--findings", "Self approved.",
      "--rationale", "Self review must still be rejected."
    ], false, testActorEnv);
    assert.match(selfReview.error?.hint ?? "", /executor cannot review/u);

    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");
    const requested = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "changes_requested",
      "--findings", "Add the missing regression test.",
      "--rationale", "The current delivery is semantically insufficient."
    ], true, testActorEnv);
    assert.equal(requested.ok, true);
    const taskRoot = path.join(rootDir, "harness/tasks", executionTaskId);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "changes_requested");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);

    const claimed = runJson(rootDir, ["task", "claim", executionTaskId, "--execution"], true, testActorEnv);
    assert.notEqual(claimed.executionId, executionId);
    assert.equal(existsSync(path.join(taskRoot, "executions", `${claimed.executionId}.md`)), true);
  });
});

function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: { readonly provenance: boolean } = { provenance: true }
): void {
  const provenance = options.provenance
    ? [
      "provenance:",
      "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}"
    ]
    : [];
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${directoryName}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    ...provenance,
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeReview(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n"), "utf8");
}

function writeRealCloseout(
  rootDir: string,
  directoryName: string,
  options: { readonly coordinatedAnchors?: boolean } = {}
): void {
  writeCloseout(rootDir, directoryName, [
    "## Summary",
    "",
    "Implemented the task document gate.",
    "",
    "## Verification",
    "",
    "npm run check passed.",
    "",
    "## Residual Risk",
    "",
    "No residual risk accepted."
  ]);
  if (options.coordinatedAnchors ?? true) writeCodeDocAnchors(rootDir, directoryName);
  else writeCodeDocAnchorsRaw(rootDir, directoryName, ensureAnchorCommit(rootDir));
}

function writeFact(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}

function writeCloseout(rootDir: string, directoryName: string, lines: ReadonlyArray<string>): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "closeout.md"), ["# Closeout", "", ...lines, ""].join("\n"), "utf8");
}

function writeExecution(rootDir: string, taskId: string, id: string, executorId: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "executions", `${id}.md`), `${JSON.stringify({
    schema: "execution/v1",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "worker" },
      executor: { kind: "agent", id: executorId },
      responsibleHuman: "worker"
    },
    claimed_at: "2026-07-11T00:00:00.000Z",
    submitted_at: "2026-07-11T00:01:00.000Z",
    closed_at: null,
    session_bindings: [{ role: "primary", archive_status: "complete" }],
    outputs: [],
    submission: { summary: "submitted", verification: ["tests passed"], residual_risks: [] }
  }, null, 2)}\n`, "utf8");
}

function writeCodeDocAnchors(rootDir: string, directoryName: string, sha = ensureAnchorCommit(rootDir)): void {
  runJson(rootDir, [
    "task", "code-doc", "reconcile", directoryName,
    "--commit", sha,
    "--path", "evidence/code-doc-anchor.txt"
  ]);
}

function writeCodeDocAnchorsRaw(rootDir: string, directoryName: string, sha: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "code-doc-anchors.json"), `${JSON.stringify({
    schema: "code-doc-reconciliation/v1",
    taskId: directoryName,
    records: [{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [{ kind: "path", sha, path: "evidence/code-doc-anchor.txt" }]
    }]
  }, null, 2)}\n`, "utf8");
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-task-doc-gates-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initializeGitRepo(rootDir: string): void {
  if (existsSync(path.join(rootDir, ".git"))) return;
  mkdirSync(rootDir, { recursive: true });
  runGit(rootDir, "init");
  runGit(rootDir, "config", "user.email", "test@example.com");
  runGit(rootDir, "config", "user.name", "Test User");
}

function ensureAnchorCommit(rootDir: string): string {
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/code-doc-anchor.txt"), "code-doc reconciliation fixture\n", "utf8");
  runGit(rootDir, "add", "evidence/code-doc-anchor.txt");
  runGit(rootDir, "commit", "-m", "seed code-doc anchor");
  return runGit(rootDir, "rev-parse", "HEAD");
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Record<string, string> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_SKIP_NPM_INSTALL: "1", ...testActorEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout) as Record<string, any>;
    assert.equal(result.ok, true);
    return unwrapCommandReceipt(result);
  } catch (error) {
    if (expectSuccess) throw error;
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  }
}
