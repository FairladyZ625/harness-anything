import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const noAgentRuntimeEnv = {
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
};
const testActorEnv = { HARNESS_ACTOR: "agent:new-task-cli-test" } as const;

test("CLI init dogfoods coding vertical defaults for new tasks", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    assert.equal(existsSync(path.join(rootDir, "harness/adr")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/milestones")), true);

    const result = runJson(rootDir, ["new-task", "--title", "Dogfood Task"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-dogfood-task/INDEX.md`), "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.report.vertical, "software/coding");
    assert.equal(result.report.preset, "standard-task");
    assert.equal(result.report.profile, "baseline");
    assert.equal(result.generated.includes("task_plan.md"), true);
    assert.match(index, /vertical: software\/coding/);
    assert.match(index, /preset: standard-task/);
    assert.match(index, /profile: baseline/);
    assertHumanProvenance(rootDir, index);
  });
});

test("CLI creates a local task with generated identity, provenance, and stable JSON output", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "--title", "Task One"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.command, "new-task");
    assert.equal(result.slug, "task-one");
    assert.equal(result.status, "planned");
    assert.equal(result.packagePath, `harness/tasks/${taskId}-task-one`);
    assert.equal(result.paths.package, result.packagePath);
    assert.match(index, /engine: local/);
    assertHumanProvenance(rootDir, index);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /"projectionHash":"sha256:/);
    assert.match(runText(rootDir, ["new-task", "--title", "Text Path"]), /ok command="task create" task=task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26} status=planned path=harness\/tasks\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}-text-path summary=/u);
  });
});

test("CLI task create persists work kind and priority metadata", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["task", "create", "--title", "Metadata Task", "--kind", "feat", "--risk-tier", "high", "--urgency", "low"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-metadata-task/INDEX.md`), "utf8");

    assert.match(index, /^workKind: feat$/mu);
    assert.match(index, /^riskTier: high$/mu);
    assert.match(index, /^urgency: low$/mu);
  });
});

test("CLI task create keeps runtime provenance without fabricating a missing transcript", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const sessionId = "019f32b3-0c38-7720-841d-b41048092cc8";
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);

    const result = runJson(rootDir, [
      "new-task",
      "--title",
      "Runtime Provenance",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ], true, {
      ...noAgentRuntimeEnv,
      CODEX_THREAD_ID: sessionId,
      HOME: path.join(rootDir, "home")
    });
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-runtime-provenance/INDEX.md`), "utf8");
    const sessionPath = path.join(harnessRoot, "sessions", `${sessionId}.md`);

    assert.match(index, new RegExp(`sessionId: "${sessionId}"`, "u"));
    assert.equal(existsSync(sessionPath), false);
    assert.doesNotMatch(gitLog(harnessRoot), new RegExp(`session-export-${sessionId}-[a-f0-9]{16}`, "u"));
    assert.equal(gitStatus(harnessRoot), "");
  });
});

function assertHumanProvenance(rootDir: string, index: string): void {
  assert.match(index, /provenance:\n  - \{runtime: "human", sessionId: "human-cli-\d+", boundAt: "\d{4}-\d{2}-\d{2}T/u);
  const sessionId = /sessionId: "(human-cli-\d+)"/u.exec(index)?.[1];
  assert.ok(sessionId);
  assert.match(readFileSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`), "utf8"), new RegExp(`sessionId: ${sessionId}`, "u"));
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
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
      env: { ...process.env, ...testActorEnv, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runText(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): string {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...testActorEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return stdout;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stderr?: string };
    return failure.stderr ?? "";
  }
}

function initHarnessGit(harnessRoot: string): void {
  execFileSync("git", ["-C", harnessRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}

function gitLog(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "log", "--pretty=%B", "--all"], { encoding: "utf8" });
}
