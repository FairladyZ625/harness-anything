// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDocSyncSubmitRequest, buildDocSyncReport, makeDocSyncService } from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";
import { attributedCoordinator } from "./helpers/doc-sync-coordinator.ts";

const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";

test("doc sync keeps a consumer closeout edit visible as a governed task-prose candidate", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot }) => {
    const closeoutPath = path.join(taskRoot, "closeout.md");
    const initial = [
      "# Closeout",
      "",
      "## Summary",
      "",
      "Original closeout.",
      "",
      "## Verification",
      "",
      "Original verification.",
      "",
      "## Residual Risk",
      "",
      "No known residual risk.",
      ""
    ].join("\n");
    writeFileSync(closeoutPath, initial, "utf8");
    git(harnessRoot, "add", `tasks/${taskId}/closeout.md`);
    gitCommit(harnessRoot, "seed closeout");
    writeFileSync(closeoutPath, initial.replace("Original closeout.", "Edited closeout."), "utf8");

    const report = buildDocSyncReport(rootDir, cliDaemonServiceHostServices.docSync);

    assert.equal(report.candidateBlobs.length, 1);
    assert.equal(report.candidateBlobs[0]?.path, `tasks/${taskId}/closeout.md`);
    assert.equal(report.writeIntentPreview.changes.length, 1);
    assert.equal(report.readyToSubmitPreview, true);

    const request = buildDocSyncSubmitRequest(
      rootDir,
      "consumer",
      [`tasks/${taskId}/closeout.md`],
      { kind: "agent", id: "codex-test" },
      cliDaemonServiceHostServices.docSync
    );
    const result = await makeDocSyncService({
      rootDir,
      coordinator: attributedCoordinator(rootDir),
      hostServices: cliDaemonServiceHostServices.docSync
    }).submit(request);

    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.deepEqual(result.appliedChanges.map((change) => change.path), [`tasks/${taskId}/closeout.md`]);
    }
    assert.equal(git(harnessRoot, "status", "--short"), "");
  }, { writeRegistry: false });
});

test("doc sync publishes a consumer task plan through the governed prose road without a registry", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot }) => {
    const relativePath = `tasks/${taskId}/task_plan.md`;
    const planPath = path.join(taskRoot, "task_plan.md");
    writeFileSync(planPath, planBody().replace("Original prose.", "Edited consumer plan."), "utf8");

    const request = buildDocSyncSubmitRequest(
      rootDir,
      "consumer",
      [relativePath],
      { kind: "agent", id: "codex-test" },
      cliDaemonServiceHostServices.docSync
    );
    const report = buildDocSyncReport(rootDir, cliDaemonServiceHostServices.docSync);
    assert.deepEqual(report.candidateBlobs.map((entry) => entry.path), [relativePath]);
    const result = await makeDocSyncService({
      rootDir,
      coordinator: attributedCoordinator(rootDir),
      hostServices: cliDaemonServiceHostServices.docSync
    }).submit(request);

    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.deepEqual(result.appliedChanges.map((change) => change.path), [relativePath]);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("doc sync rejects a closeout request whose task package is swapped to an external symlink", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot }) => {
    const closeoutPath = path.join(taskRoot, "closeout.md");
    const initial = [
      "# Closeout",
      "",
      "## Summary",
      "",
      "Original closeout.",
      "",
      "## Verification",
      "",
      "Original verification.",
      "",
      "## Residual Risk",
      "",
      "No known residual risk.",
      ""
    ].join("\n");
    const edited = initial.replace("Original closeout.", "Edited closeout.");
    writeFileSync(closeoutPath, initial, "utf8");
    git(harnessRoot, "add", `tasks/${taskId}/closeout.md`);
    gitCommit(harnessRoot, "seed closeout");
    writeFileSync(closeoutPath, edited, "utf8");

    const request = buildDocSyncSubmitRequest(
      rootDir,
      "consumer",
      [`tasks/${taskId}/closeout.md`],
      { kind: "agent", id: "codex-test" },
      cliDaemonServiceHostServices.docSync
    );
    const externalTaskRoot = path.join(rootDir, "outside-task");
    const externalCloseoutPath = path.join(externalTaskRoot, "closeout.md");
    mkdirSync(externalTaskRoot, { recursive: true });
    for (const file of ["INDEX.md", "task_plan.md", "facts.md", "notes.txt"]) {
      writeFileSync(path.join(externalTaskRoot, file), readFileSync(path.join(taskRoot, file)));
    }
    writeFileSync(externalCloseoutPath, initial, "utf8");
    rmSync(taskRoot, { recursive: true, force: true });
    symlinkSync(externalTaskRoot, taskRoot, "dir");

    const result = await makeDocSyncService({
      rootDir,
      coordinator: attributedCoordinator(rootDir),
      hostServices: cliDaemonServiceHostServices.docSync
    }).submit(request);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(readFileSync(externalCloseoutPath, "utf8"), initial);
  }, { writeRegistry: false });
});

async function withHarnessFixture<T>(
  fn: (fixture: { readonly rootDir: string; readonly harnessRoot: string; readonly taskRoot: string }) => T | Promise<T>
): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-closeout-"));
  const harnessRoot = path.join(rootDir, "harness");
  const taskRoot = path.join(harnessRoot, "tasks", taskId);
  try {
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(path.join(harnessRoot, "decisions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), planBody(), "utf8");
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody(), "utf8");
    writeFileSync(path.join(taskRoot, "notes.txt"), "old notes\n", "utf8");
    writeFileSync(path.join(harnessRoot, "decisions", "dec_mrcda9kw.md"), "# Decision\n\n- claim: old\n", "utf8");
    initHarnessGit(harnessRoot);
    return await fn({ rootDir, harnessRoot, taskRoot });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function taskIndex(): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "status: active",
    "urgency: medium",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "# Task",
    ""
  ].join("\n");
}

function planBody(): string {
  return [
    "# Plan",
    "",
    "## Brief", "Brief.",
    "## Goal", "Original prose.",
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}

function factsBody(): string {
  return ["# Facts", "", "## Records", "", "- fact: original", ""].join("\n");
}

function initHarnessGit(harnessRoot: string): void {
  git(harnessRoot, "init");
  git(harnessRoot, "config", "user.name", "Harness Test");
  git(harnessRoot, "config", "user.email", "harness@example.test");
  git(harnessRoot, "add", ".");
  gitCommit(harnessRoot, "seed");
}

function gitCommit(harnessRoot: string, message: string): void {
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", message], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: emptyGitConfigPath(harnessRoot),
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    }
  });
}

function emptyGitConfigPath(harnessRoot: string): string {
  const emptyHome = path.join(harnessRoot, ".empty-home");
  mkdirSync(emptyHome, { recursive: true });
  const configPath = path.join(emptyHome, "empty.gitconfig");
  writeFileSync(configPath, "", "utf8");
  return configPath;
}

function git(harnessRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", harnessRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: emptyGitConfigPath(harnessRoot)
    }
  }).trimEnd();
}
