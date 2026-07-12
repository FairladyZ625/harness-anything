// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI reports doctor-aligned journal cause when authored root is tracked by the outer repo", () => {
  withTempRoot((rootDir) => {
    runGit(rootDir, "init");
    writeFileSync(path.join(rootDir, ".gitignore"), "/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "seed outer repo");
    writeHarnessConfig(rootDir, "outer-managed-authored-root");

    const failure = runJson(rootDir, ["new-task", "--title", "Outer Managed"], false);
    const doctor = runJson(rootDir, ["doctor"]);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "journal_unavailable");
    assert.match(failure.error?.hint, /authored root is not isolated from the outer code repository/);
    assert.match(failure.error?.hint, /independent Git repository/u);
    assert.match(failure.error?.hint, /harness-anything init/u);
    assert.equal(JSON.stringify(failure).includes(rootDir), false);
    assert.equal(doctor.report.harness.isolation.ok, false);
    assert.equal(doctor.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "harness_git_missing"), true);
    assert.equal(doctor.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "outer_gitignore_missing"), true);
  });
});

test("CLI reports actionable journal cause when authored root is ignored without nested Git repo", () => {
  withTempRoot((rootDir) => {
    runGit(rootDir, "init");
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    writeHarnessConfig(rootDir, "ignored-authored-root");

    const failure = runJson(rootDir, ["new-task", "--title", "Ignored Root"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "journal_unavailable");
    assert.match(failure.error?.hint, /authored root is not isolated from the outer code repository/);
    assert.match(failure.error?.hint, /independent Git repository/u);
    assert.match(failure.error?.hint, /harness-anything init/u);
    assert.equal(JSON.stringify(failure).includes(rootDir), false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-boundary-"));
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
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  }).trim();
}

function writeHarnessConfig(rootDir: string, name: string): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    `name: ${name}`,
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "tasks:",
    "  root: harness/tasks",
    "settings:",
    "  identity:",
    "    personId: person_test",
    "    displayName: Harness Test",
    ""
  ].join("\n"), "utf8");
}
