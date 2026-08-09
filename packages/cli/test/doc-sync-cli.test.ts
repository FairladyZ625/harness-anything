// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { pollUntil, stopDaemon } from "./helpers/daemon-cli.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

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

test("CLI doc sync exposes renamed anchor diagnostics and still accepts the restored anchor", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
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
    initHarnessGit(harnessRoot);

    const renamedPlan = taskPlan("Updated prose.").replace("## Goal", "## Purpose");
    writeFileSync(path.join(taskRoot, "task_plan.md"), renamedPlan);
    const rejected = runJson(rootDir, ["doc", "sync", "--submit"], false);
    assert.match(rejected.error?.hint ?? "", /## Goal/u);
    assert.match(rejected.error?.hint ?? "", /deleted or renamed/u);

    const statusText = runText(rootDir, ["doc", "status"]);
    assert.match(statusText, new RegExp(`tasks/${taskId}/task_plan\\.md`));
    assert.match(statusText, /SEMANTIC_DIFF_AMBIGUOUS.*## Goal/u);
    assert.match(statusText, /summary="doc status: 1 dirty, 1 blocked"/u);

    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan("Updated prose."));
    const submitted = runJson(rootDir, ["doc", "sync", "--submit"]);
    assert.equal(submitted.ok, true);
    assert.equal(submitted.report.status, "accepted");
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
    const sessionBranch = "sessions/doc-sync-cli-test";
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
      () => execFileSync("git", ["-C", harnessRoot, "log", "-1", "--format=%an <%ae>", sessionBranch], { encoding: "utf8" }).trim(),
      (candidate) => candidate === "Doc Sync User <harness@example.test>",
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), submitted })
    );
    assert.equal(author, "Doc Sync User <harness@example.test>");
    assert.match(
      execFileSync("git", ["-C", harnessRoot, "show", `${sessionBranch}:tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task_plan.md`], { encoding: "utf8" }),
      /Updated through daemon/u
    );
  });
});

test("CLI doc sync materializes an exact log artifact", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    const relativePath = `tasks/${taskId}/artifacts/daemon-evidence.log`;
    const targetPath = path.join(harnessRoot, relativePath);
    const sessionBranch = "sessions/doc-sync-cli-test";
    const body = `${"x".repeat(47_659)}\n`;
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
    initHarnessGit(harnessRoot);

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, body, "utf8");
    const submitted = runJson(rootDir, ["doc", "sync", "--submit", "--path", relativePath]);

    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.report.status, "accepted");
    assert.equal(submitted.report.appliedChanges[0].path, relativePath);
    assert.equal(
      execFileSync("git", ["-C", harnessRoot, "show", `${sessionBranch}:${relativePath}`], { encoding: "utf8" }),
      body
    );
  });
});

test("CLI doc status and sync preserve a non-ASCII artifact path", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    const relativePath = `tasks/${taskId}/artifacts/实测报告.md`;
    const targetPath = path.join(harnessRoot, relativePath);
    const sessionBranch = "sessions/doc-sync-cli-test";
    const body = "# 实测报告\n\n中文文件名写路证据。\n";
    mkdirSync(taskRoot, { recursive: true });
    seedDocSyncWriteRoadRegistry(rootDir);
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    initHarnessGit(harnessRoot);

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, body, "utf8");

    const status = runJson(rootDir, ["doc", "status"]);
    assert.deepEqual(status.report.dirtyFiles.map((entry: Record<string, any>) => entry.path), [relativePath]);
    assert.deepEqual(status.report.candidateBlobs.map((entry: Record<string, any>) => entry.path), [relativePath]);
    assert.deepEqual(status.report.unresolvedTouches, []);

    const submitted = runJson(rootDir, ["doc", "sync", "--submit", "--path", relativePath]);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.report.appliedChanges[0].path, relativePath);
    assert.equal(
      execFileSync("git", ["-C", harnessRoot, "show", `${sessionBranch}:${relativePath}`], { encoding: "utf8" }),
      body
    );
  });
});

test("task artifact add submits UTF-8 evidence through the existing doc-sync governance commit", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const sessionBranch = "sessions/doc-sync-cli-test";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    initHarnessGit(harnessRoot);
    const source = path.join(rootDir, "artifact-report.txt");
    writeFileSync(source, "governed evidence\n", "utf8");

    const submitted = runJson(rootDir, ["task", "artifact", "add", taskId, source]);

    const target = `tasks/${taskId}/artifacts/artifact-report.txt`;
    assert.equal(submitted.ok, true);
    assert.equal(submitted.command, "artifact-add");
    assert.deepEqual(submitted.report.artifacts, [target]);
    const committedBody = await pollUntil(
      () => execFileSync("git", ["-C", harnessRoot, "show", `${sessionBranch}:${target}`], { encoding: "utf8" }),
      (candidate) => candidate === "governed evidence\n",
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), submitted })
    );
    assert.equal(committedBody, "governed evidence\n");
    assert.match(execFileSync("git", ["-C", harnessRoot, "log", "-1", "--format=%s", sessionBranch], { encoding: "utf8" }), /^entity\(doc-sync-submit\):/u);
  });
});

test("progress evidence ingests an untracked artifact before recording its governed pointer", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    writeFileSync(path.join(taskRoot, "progress.md"), "# Progress\n\n## Entries\n\n");
    initHarnessGit(harnessRoot);
    const source = path.join(rootDir, "combined-report.txt");
    writeFileSync(source, "combined evidence\n", "utf8");

    const submitted = runJson(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "combined path",
      "--evidence", `test:${source}:green`
    ]);

    const target = `tasks/${taskId}/artifacts/combined-report.txt`;
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.match(readFileSync(path.join(taskRoot, "progress.md"), "utf8"), new RegExp(`Evidence: test:${target}:green`, "u"));
    assert.equal(execFileSync("git", ["-C", harnessRoot, "show", `HEAD:${target}`], { encoding: "utf8" }), "combined evidence\n");
    assert.match(execFileSync("git", ["-C", harnessRoot, "log", "--all", "--format=%s", "--", target], { encoding: "utf8" }), /entity\(doc-sync-submit\):/u);
  });
});

test("progress evidence preserves a URL-shaped free pointer when it is not a local artifact", async () => {
  await withTempRoot(async (rootDir) => {
    // The URL must live in the summary slot, not PATH: `type:PATH:summary` cannot encode ':' in PATH
    // (the parser rejects `pr:https://...:merged` because the URL scheme 'https' would silently become
    // PATH and the rest would leak into summary — see task_01KZ92RAJ1HXRSYDY4JP6APRCN). Use a short
    // label in PATH and the full URL in summary, which allows ':'.
    await assertPointerOnlyEvidence(rootDir, "pr:1104:https://github.com/FairladyZ625/harness-anything/pull/1104:merged");
  });
});

test("progress evidence rejects a URL-in-PATH shape that the parser cannot disambiguate, with a copyable correct form", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    seedDocSyncWriteRoadRegistry(rootDir);
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    writeFileSync(path.join(taskRoot, "progress.md"), "# Progress\n\n## Entries\n\n");
    initHarnessGit(harnessRoot);

    const rejected = runJson(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "must not be appended",
      "--evidence", "pr:https://github.com/FairladyZ625/harness-anything/pull/1104:merged"
    ], false);

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "invalid_evidence");
    assert.match(rejected.error.hint, /PATH cannot contain ':'/u);
    assert.match(rejected.error.hint, /URL scheme 'https' became PATH/u);
    assert.match(rejected.error.hint, /--evidence pr:<short-label>:https:/u);
    // progress.md was not changed — no miscategorized pointer persisted.
    assert.equal(readFileSync(path.join(taskRoot, "progress.md"), "utf8"), "# Progress\n\n## Entries\n\n");
  });
});

test("progress evidence preserves a non-path free pointer", async () => {
  await withTempRoot(async (rootDir) => {
    await assertPointerOnlyEvidence(rootDir, "note:none:仅文字说明");
  });
});

test("progress evidence preserves an outside-repository file pointer", async () => {
  await withTempRoot(async (rootDir) => {
    const externalRoot = mkdtempSync(path.join(tmpdir(), "ha-outside-evidence-"));
    try {
      const externalPath = path.join(externalRoot, "probe-run.log");
      writeFileSync(externalPath, "outside log\n", "utf8");
      await assertPointerOnlyEvidence(rootDir, `log:${externalPath}:tail`);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

test("progress evidence preserves a binary file pointer", async () => {
  await withTempRoot(async (rootDir) => {
    const binaryPath = path.join(rootDir, "capture.bin");
    writeFileSync(binaryPath, Buffer.from([0xff, 0x00, 0xfe]));
    await assertPointerOnlyEvidence(rootDir, `log:${binaryPath}:binary capture`);
  });
});

test("artifact doc-sync rejection stops before progress append and leaves no dangling pointer", async () => {
  await withTempRoot(async (rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), `${JSON.stringify({
      schema: "harness-anything/write-road-registry/v1",
      rows: [{ id: "task.document.write-stage", bearing: "task-document", channel: { pathClass: "rpc-only", zoneClass: "task-authored-prose-or-stage" } }]
    }, null, 2)}\n`);
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
    writeFileSync(path.join(taskRoot, "progress.md"), "# Progress\n\n## Entries\n\n");
    initHarnessGit(harnessRoot);
    const source = path.join(rootDir, "rejected-report.txt");
    writeFileSync(source, "must stay unreferenced\n", "utf8");
    const before = execFileSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const rejected = runJson(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "must not be appended",
      "--evidence", `log:${source}:rejected`
    ], false);

    assert.equal(rejected.ok, false);
    assert.match(rejected.error.hint, /progress\.md was not changed/u);
    assert.equal(execFileSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before);
    assert.equal(execFileSync("git", ["-C", harnessRoot, "show", `HEAD:tasks/${taskId}/progress.md`], { encoding: "utf8" }), "# Progress\n\n## Entries\n\n");
    assert.equal(existsSync(path.join(taskRoot, "artifacts", "rejected-report.txt")), false);
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

async function assertPointerOnlyEvidence(rootDir: string, evidence: string): Promise<void> {
  const harnessRoot = path.join(rootDir, "harness");
  const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
  const taskRoot = path.join(harnessRoot, "tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  seedDocSyncWriteRoadRegistry(rootDir);
  writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex());
  writeFileSync(path.join(taskRoot, "progress.md"), "# Progress\n\n## Entries\n\n");
  initHarnessGit(harnessRoot);

  const submitted = runJson(rootDir, [
    "task", "progress", "append", taskId,
    "--text", "free pointer compatibility",
    "--evidence", evidence
  ]);

  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.match(readFileSync(path.join(taskRoot, "progress.md"), "utf8"), new RegExp(`Evidence: ${escapeRegExp(evidence)}`, "u"));
  assert.equal((submitted.warnings ?? []).some((warning: Record<string, unknown>) => warning.code === "artifact_ingest_skipped"), true);
  assert.equal(existsSync(path.join(taskRoot, "artifacts")), false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
    "---", "schema: task-package/v2", "task_id: task_01KX3W4V1EDPHPTGWYYBQQ2J75", "title: Doc sync task",
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: active", "  ref: ''",
    "  titleSnapshot: Doc sync task", "  url: ''", "  bindingCreatedAt: 2026-07-26T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "urgency: medium", "vertical: software/coding", "preset: standard-task",
    "provenance:", "  - {runtime: human, sessionId: fixture, boundAt: 2026-07-26T00:00:00.000Z}",
    "---", "# Task", ""
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
  const daemonMode = (args[0] === "doc" && args[1] === "sync" && args.includes("--submit"))
    || (args[0] === "task" && (args[1] === "artifact" || args[1] === "progress")) ? "local" : "fixture";
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ CODEX_THREAD_ID: "doc-sync-cli-test", HARNESS_ACTOR: "agent:doc-sync-cli-test", HARNESS_GIT_AUTHOR_NAME: "Harness Test", HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test", HARNESS_DAEMON_MODE: daemonMode, HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user"), HARNESS_DAEMON_IDLE_MS: "250", GIT_CONFIG_GLOBAL: "/dev/null" })
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runText(rootDir: string, args: ReadonlyArray<string>): string {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: cliTestEnv({ CODEX_THREAD_ID: "doc-sync-cli-test", HARNESS_ACTOR: "agent:doc-sync-cli-test", HARNESS_GIT_AUTHOR_NAME: "Harness Test", HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test", HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user"), HARNESS_DAEMON_IDLE_MS: "250", GIT_CONFIG_GLOBAL: "/dev/null" })
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
