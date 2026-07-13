// harness-test-tier: integration
import assert from "node:assert/strict";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("new-task records attribution events independently of local git author config", () => {
  withTempRoot((rootDir) => {
    initGit(rootDir);
    configureGitUser(rootDir, "M2 Commander", "m2@example.com");
    initializeNestedHarnessRepo(rootDir, { writeOuterGitignore: true });

    const created = runJson(rootDir, ["new-task", "--title", "Attribution Task"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const indexBody = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-attribution-task/INDEX.md`), "utf8");

    assert.equal(indexBody.includes("createdBy:"), false);

    const listed = runJson(rootDir, ["task", "list"]);
    assert.equal(listed.tasks[0].attribution.completeness, "host-only");
    assert.equal(listed.tasks[0].attribution.trailCount, 1);
    assert.equal(listed.tasks[0].attribution.originator.principal.kind, "person");
    assert.equal(listed.tasks[0].canonicalStatus, "planned");
    assert.equal(listed.tasks[0].packageDisposition, "active");
  });
});

test("new-task never serializes retired createdBy when git user config is unavailable", () => {
  withTempRoot((rootDir) => {
    initGit(rootDir);
    initializeNestedHarnessRepo(rootDir, { writeOuterGitignore: true });
    mkdirSync(path.join(rootDir, "home"), { recursive: true });

    const created = runJson(rootDir, ["new-task", "--title", "Anonymous Task"], true, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: path.join(rootDir, "home")
    });
    const taskId = assertGeneratedTaskId(created.taskId);
    const indexBody = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-anonymous-task/INDEX.md`), "utf8");

    assert.equal(indexBody.includes("createdBy:"), false);
  });
});

test("git-diff emits stable read-only evidence without creating harness state or leaking root paths", () => {
  withTempRoot((rootDir) => {
    initGit(rootDir);
    configureGitUser(rootDir, "Diff User", "diff@example.com");
    writeFileSync(path.join(rootDir, "README.md"), "before\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: rootDir, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: rootDir, stdio: "ignore" });

    writeFileSync(path.join(rootDir, "README.md"), "after\n", "utf8");
    writeFileSync(path.join(rootDir, "notes.md"), "untracked\n", "utf8");

    const result = runJson(rootDir, ["git-diff"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "git-diff");
    assert.equal(result.report.schema, "git-diff-evidence/v1");
    assert.equal(result.report.readOnly, true);
    assert.equal(result.report.dirty, true);
    assert.equal(result.report.fileCount, 2);
    assert.deepEqual(new Set(result.report.files.map((file: Record<string, unknown>) => file.path)), new Set(["README.md", "notes.md"]));
    assert.equal(result.report.files.some((file: Record<string, unknown>) => file.status === "modified"), true);
    assert.equal(result.report.files.some((file: Record<string, unknown>) => file.status === "untracked"), true);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("git-diff handles status output larger than Node's default exec buffer", () => {
  withTempRoot((rootDir) => {
    initGit(rootDir);
    configureGitUser(rootDir, "Diff User", "diff@example.com");
    writeFileSync(path.join(rootDir, "README.md"), "baseline\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: rootDir, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: rootDir, stdio: "ignore" });

    const segment = "nested-status-output-" + "x".repeat(150);
    const deepDir = path.join(rootDir, segment, segment, segment, segment);
    mkdirSync(deepDir, { recursive: true });
    for (let index = 0; index < 1600; index += 1) {
      writeFileSync(path.join(deepDir, `untracked-${String(index).padStart(4, "0")}.txt`), "status\n", "utf8");
    }

    const result = runJson(rootDir, ["git-diff"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.schema, "git-diff-evidence/v1");
    assert.equal(result.report.fileCount, 1600);
    assert.equal(result.report.files.every((file: Record<string, unknown>) => file.status === "untracked"), true);
  });
});

function initGit(rootDir: string): void {
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
}

function configureGitUser(rootDir: string, name: string, email: string): void {
  execFileSync("git", ["config", "user.name", name], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", email], { cwd: rootDir, stdio: "ignore" });
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p5-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
