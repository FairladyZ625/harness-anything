// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { pollUntil, stopDaemon } from "./helpers/daemon-cli.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registryBody = readFileSync(path.join(repoRoot, "tools/write-road-registry.json"), "utf8");
const docSyncRegistryBody = `${JSON.stringify({
  schema: "harness-anything/write-road-registry/v1",
  rows: [{
    id: "task.document.write-stage",
    bearing: "task-document",
    channel: {
      pathClass: "doc-sync-allowed",
      zoneClass: "task-authored-prose-or-stage"
    }
  }]
}, null, 2)}\n`;

test("CLI doc status reports prose candidates and forbidden structured touches", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks", "task_01KX3W4V1EDPHPTGWYYBQQ2J75");
    mkdirSync(taskRoot, { recursive: true });
    seedWriteRoadRegistry(rootDir);
    writeFileSync(path.join(harnessRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    personId: person_doc_sync",
      "    displayName: Doc Sync User",
      ""
    ].join("\n"));
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan("Original prose."));
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody(""));
    initHarnessGit(harnessRoot);

    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan("Updated prose."));
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody(validFactRecord()));
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    mkdirSync(path.join(taskRoot, "reviews"), { recursive: true });
    writeFileSync(path.join(taskRoot, "executions", "fake.md"), "{}\n");
    writeFileSync(path.join(taskRoot, "reviews", "fake.md"), "{}\n");

    const status = runJson(rootDir, ["doc", "status"]);
    assert.equal(status.ok, true);
    assert.equal(status.command, "doc-status");
    assert.equal(status.report.candidateBlobs.length, 2);
    assert.deepEqual(status.report.candidateBlobs.map((candidate: Record<string, any>) => candidate.path).sort(), [
      "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/facts.md",
      "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task_plan.md"
    ]);
    assert.equal(status.report.forbiddenTouches.some((touch: Record<string, any>) => touch.hunks[0].registryRowId === "task.execution.record"), true);
    assert.equal(status.report.forbiddenTouches.some((touch: Record<string, any>) => touch.hunks[0].registryRowId === "task.execution-review.record"), true);

    const dryRun = runJson(rootDir, ["doc", "sync", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.command, "doc-sync-dry-run");
    assert.equal(dryRun.report.writeIntentPreview.submitImplemented, true);
    assert.equal(dryRun.report.writeIntentPreview.changes.length, 2);

    const rejected = runJson(rootDir, ["doc", "sync", "--submit"], false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /preview is not ready/u);
    assert.notEqual(gitStatus(harnessRoot), "");
  });
});

test("CLI doc status marks deletion as an explicit Phase 2 gap", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks", "task_01KX3W4V1EDPHPTGWYYBQQ2J75");
    mkdirSync(taskRoot, { recursive: true });
    seedWriteRoadRegistry(rootDir);
    writeFileSync(path.join(harnessRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    personId: person_doc_sync",
      "    displayName: Doc Sync User",
      ""
    ].join("\n"));
    const planPath = path.join(taskRoot, "task_plan.md");
    writeFileSync(planPath, "# Plan\n\nOriginal prose.\n");
    initHarnessGit(harnessRoot);
    rmSync(planPath);

    const status = runJson(rootDir, ["doc", "status"]);
    assert.equal(status.report.deletionPolicy, "undefined-pending-phase-2");
    assert.equal(status.report.deletions.length, 1);
    assert.equal(status.report.readyToSubmitPreview, false);
    const rejected = runJson(rootDir, ["doc", "sync", "--submit"], false);
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /1 deletion/u);
  });
});

test("CLI doc sync submit commits eligible prose through the daemon", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks", "task_01KX3W4V1EDPHPTGWYYBQQ2J75");
    mkdirSync(taskRoot, { recursive: true });
    seedDocSyncWriteRoadRegistry(rootDir);
    writeFileSync(path.join(harnessRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    personId: person_doc_sync",
      "    displayName: Doc Sync User",
      ""
    ].join("\n"));
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan("Original prose."));
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody("- fact: original"));
    initHarnessGit(harnessRoot);
    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan("Updated through daemon."));
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody("- fact: unrelated structured mutation"));

    const submitted = runJson(rootDir, [
      "doc", "sync", "--submit",
      "--path", "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task_plan.md"
    ]);

    assert.equal(submitted.ok, true);
    assert.equal(submitted.command, "doc-sync-submit");
    assert.equal(submitted.report.status, "accepted");
    assert.equal(submitted.report.appliedChanges[0].path, "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task_plan.md");
    assert.match(gitStatus(harnessRoot), /facts\.md/u);
    const author = await pollUntil(
      () => execFileSync("git", ["-C", harnessRoot, "log", "-1", "--format=%an <%ae>"], { encoding: "utf8" }).trim(),
      (candidate) => candidate === "Doc Sync User <harness@example.test>",
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), submitted })
    );
    assert.equal(author, "Doc Sync User <harness@example.test>");
  });
});

async function withTempRoot<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return await fn(rootDir);
  } finally {
    await stopDaemon(rootDir);
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedWriteRoadRegistry(rootDir: string): void {
  // doc-sync enforcement only activates when the write-road registry is present in the
  // repo root. Seed it here so `doc status`/`doc sync` classify touches against real rows;
  // without it loadRegistry treats the layer as inactive and the report is inert (see #644).
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), registryBody);
}

function seedDocSyncWriteRoadRegistry(rootDir: string): void {
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), docSyncRegistryBody);
}

function initHarnessGit(harnessRoot: string): void {
  execFileSync("git", ["-C", harnessRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "add", "--", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}

function taskIndex(): string {
  return [
    "---", "schema: task-package/v2", "task_id: task_01KX3W4V1EDPHPTGWYYBQQ2J75", "status: active",
    "urgency: medium", "vertical: software/coding", "preset: standard-task", "---", "# Task", ""
  ].join("\n");
}

function taskPlan(goal: string): string {
  return [
    "# Plan", "", "## Goal", goal, "## Context", "Context.", "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.", "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.", "## Verification", "Verify.", ""
  ].join("\n");
}

function factsBody(record: string): string {
  return ["# Facts", "", "## Records", "", record, ""].join("\n");
}

function validFactRecord(): string {
  return "- {fact_id: F-AAAA1111, statement: \"Structured mutation\", source: \"doc sync CLI test\", observedAt: \"2026-07-14T00:00:00.000Z\", confidence: high, memoryClass: semantic, memoryTags: [], provenance: [{runtime: \"codex\", sessionId: \"session-w5\", boundAt: \"2026-07-14T00:00:00.000Z\"}]}";
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  const daemonMode = args[0] === "doc" && args[1] === "sync" && args.includes("--submit") ? "local" : "fixture";
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:doc-sync-cli-test",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
        HARNESS_DAEMON_MODE: daemonMode,
        HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user"),
        HARNESS_DAEMON_IDLE_MS: "250",
        GIT_CONFIG_GLOBAL: "/dev/null"
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
