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

function writeIndex(rootDir: string, directoryName: string, title: string, status: string): void {
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
