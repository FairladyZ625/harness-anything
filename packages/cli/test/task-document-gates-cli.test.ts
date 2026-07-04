import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI task-complete rejects template closeout placeholders and passes after real closeout text", () => {
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

    writeRealCloseout(rootDir, "task-1");

    const passed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.data?.status ?? passed.status, "done");
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

test("CLI task-complete reports the underlying completion write failure", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review", { provenance: false });
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1");

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "malformed_snapshot");
    assert.match(blocked.error?.hint, /Completion status update failed\./);
    assert.match(blocked.error?.hint, /minItems\(1\)|Expected a refinement/);
  });
});

test("CLI task-review rejects tasks without a real fact and prints the remediation command", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");

    const blocked = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_fact_required");
    assert.match(blocked.error?.hint, /ha fact record --task task-1 --statement/);
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
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), ".harness/\n", "utf8");
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    runGit(rootDir, "add", ".gitignore", "harness/tasks/task-1/INDEX.md", "harness/tasks/task-1/facts.md");
    runGit(rootDir, "commit", "-m", "seed task");

    writeReview(rootDir, "task-1");
    assert.match(runGit(rootDir, "status", "--short"), /review\.md/);

    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);
    assert.equal(reviewed.ok, true);
    assert.equal(runGit(rootDir, "status", "--short"), "");
    assert.match(runGit(rootDir, "log", "--oneline", "-1"), /task\(doc-stage\): task-1 review\.md/);

    writeRealCloseout(rootDir, "task-1");
    assert.match(runGit(rootDir, "status", "--short"), /closeout\.md/);

    const completed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(completed.ok, true);
    assert.equal(completed.data?.status ?? completed.status, "done");
    assert.equal(runGit(rootDir, "status", "--short"), "");
    assert.match(runGit(rootDir, "log", "--oneline", "-3"), /task\(transition\): task-1/);
    assert.match(runGit(rootDir, "log", "--oneline", "-3"), /task\(doc-stage\): task-1 closeout\.md/);
  });
});

test("CLI task-review does not count facts.md placeholders as facts", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/facts.md"), "# Facts\n\n- TODO: record a fact before closeout.\n", "utf8");

    const blocked = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_fact_required");
  });
});

test("CLI task-complete preserves the fact gate failure instead of masking it as review_not_passed", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1");

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_fact_required");
    assert.match(blocked.error?.hint, /ha fact record --task task-1 --statement/);
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
    "vertical: default",
    "preset: default",
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

function writeRealCloseout(rootDir: string, directoryName: string): void {
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

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-task-doc-gates-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initializeGitRepo(rootDir: string): void {
  runGit(rootDir, "init");
  runGit(rootDir, "config", "user.email", "test@example.com");
  runGit(rootDir, "config", "user.name", "Test User");
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_SKIP_NPM_INSTALL: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout) as Record<string, any>;
    assert.equal(result.ok, true);
    return result;
  } catch (error) {
    if (expectSuccess) throw error;
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    return JSON.parse(stdout) as Record<string, any>;
  }
}
