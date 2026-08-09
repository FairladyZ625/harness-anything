// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import { buildArtifactIngestPlan, ArtifactIngestError, normalizeProgressAfterArtifact, portableGitPathRelative, progressRetryCommand } from "../src/daemon/artifact-ingest.ts";
import { CliErrorCode, cliError } from "../src/cli/error-codes.ts";
import { toCommandReceipt } from "../src/cli/receipt.ts";
import type { ParsedCommand } from "../src/cli/types.ts";

test("artifact planner rewrites untracked evidence to a governed task path", () => withFixture(({ rootDir, taskId }) => {
  const source = path.join(rootDir, "verification.txt");
  writeFileSync(source, "green\n", "utf8");
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.ok(plan?.request);
  const target = `tasks/${taskId}/artifacts/verification.txt`;
  assert.deepEqual(plan.targetPaths, [target]);
  assert.equal(plan.request.payload.changes[0]?.path, target);
  assert.equal(plan.progressCommand?.action.kind, "progress-append");
  if (plan.progressCommand?.action.kind === "progress-append") {
    assert.equal(plan.progressCommand.action.evidence?.[0]?.path, target);
  }
  assert.match(progressRetryCommand(plan) ?? "", /verification\.txt/u);
}));

test("artifact planner leaves version-controlled source evidence on the existing pointer path", () => withFixture(({ rootDir, harnessRoot, taskId }) => {
  const source = path.join(harnessRoot, "src", "source.ts");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "export const value = 1;\n", "utf8");
  git(harnessRoot, "add", "src/source.ts");
  git(harnessRoot, "commit", "-m", "seed tracked source");
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.equal(plan, null);
}));

test("portable Git paths normalize Windows separators and case on POSIX", () => {
  const repositoryRoot = String.raw`C:\Users\runneradmin\AppData\Local\Temp\ha-artifact-plan\harness`;
  const trackedSource = "c:/USERS/RUNNERADMIN/AppData/Local/Temp/ha-artifact-plan/harness/src/source.ts";
  assert.equal(portableGitPathRelative(repositoryRoot, trackedSource), "src/source.ts");
  assert.equal(
    portableGitPathRelative(repositoryRoot, String.raw`C:\Users\runneradmin\AppData\Local\Temp\outside.ts`),
    null
  );
});

test("explicit artifact add rejects binary bytes with an actionable UTF-8 message", () => withFixture(({ rootDir, taskId }) => {
  const source = path.join(rootDir, "capture.bin");
  writeFileSync(source, Buffer.from([0xff, 0x00, 0xfe]));
  assert.throws(
    () => buildArtifactIngestPlan({ command: artifactCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir }),
    (error) => error instanceof ArtifactIngestError && error.code === "artifact_read_failed" && /UTF-8 text only/u.test(error.message)
  );
}));

test("progress evidence keeps a binary pointer and records why ingestion was skipped", () => withFixture(({ rootDir, taskId }) => {
  const source = path.join(rootDir, "capture.bin");
  writeFileSync(source, Buffer.from([0xff, 0x00, 0xfe]));
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  assert.equal(plan.request, null);
  assert.equal(plan.skippedEvidence[0]?.path, source);
  assert.match(plan.skippedEvidence[0]?.reason ?? "", /UTF-8 text only/u);
  if (plan.progressCommand?.action.kind === "progress-append") {
    assert.equal(plan.progressCommand.action.evidence?.[0]?.path, source);
  }
}));

test("artifact planner reuses an identical committed artifact so a failed progress append can be retried", () => withFixture(({ rootDir, harnessRoot, taskId }) => {
  const source = path.join(rootDir, "retry.txt");
  const target = path.join(harnessRoot, "tasks", taskId, "artifacts", "retry.txt");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(source, "retry body\n", "utf8");
  writeFileSync(target, "retry body\n", "utf8");
  git(harnessRoot, "add", ".");
  git(harnessRoot, "commit", "-m", "seed reusable artifact");
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  assert.equal(plan.request, null);
  assert.deepEqual(plan.reusedPaths, [`tasks/${taskId}/artifacts/retry.txt`]);
}));

test("artifact add republishes a tracked task artifact whose working tree content changed", () => withFixture(({ rootDir, harnessRoot, taskId }) => {
  const target = seedPublishedArtifact(harnessRoot, taskId, "report.md", "# first\n");
  const updated = "# first\n\n## added section\n";
  writeFileSync(target, updated, "utf8");
  const plan = buildArtifactIngestPlan({ command: artifactCommand(rootDir, taskId, target), repoId: "canonical", cwd: rootDir });
  const portable = `tasks/${taskId}/artifacts/report.md`;
  assert.ok(plan?.request, "a changed tracked artifact must produce a doc-sync submit request");
  assert.deepEqual(plan.submittedPaths, [portable]);
  assert.deepEqual(plan.reusedPaths, []);
  const change = plan.request.payload.changes[0];
  assert.equal(change?.path, portable);
  assert.equal(change?.content.kind === "inline" ? change.content.body : null, updated);
  // Submit rejects with base_blob_changed unless the base names the current HEAD body.
  assert.equal(change?.baseBlobSha256, sha256Text("# first\n"));
  assert.equal(change?.newBlobSha256, sha256Text(updated));
}));

test("artifact add still reuses a tracked task artifact whose content already matches HEAD", () => withFixture(({ rootDir, harnessRoot, taskId }) => {
  const target = seedPublishedArtifact(harnessRoot, taskId, "stable.md", "# unchanged\n");
  const plan = buildArtifactIngestPlan({ command: artifactCommand(rootDir, taskId, target), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  assert.equal(plan.request, null);
  assert.deepEqual(plan.reusedPaths, [`tasks/${taskId}/artifacts/stable.md`]);
  assert.deepEqual(plan.submittedPaths, []);
}));

test("artifact add keeps reusing a tracked binary artifact instead of failing on UTF-8", () => withFixture(({ rootDir, harnessRoot, taskId }) => {
  const target = path.join(harnessRoot, "tasks", taskId, "artifacts", "capture.bin");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from([0xff, 0x00, 0xfe]));
  git(harnessRoot, "add", ".");
  git(harnessRoot, "commit", "-m", "seed published binary artifact");
  writeFileSync(target, Buffer.from([0xff, 0x00, 0xfd]));
  const plan = buildArtifactIngestPlan({ command: artifactCommand(rootDir, taskId, target), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  assert.equal(plan.request, null);
  assert.deepEqual(plan.reusedPaths, [`tasks/${taskId}/artifacts/capture.bin`]);
}));

test("progress failure reports the retained governed artifact and an exact retry command", () => withFixture(({ rootDir, taskId }) => {
  const source = path.join(rootDir, "orphan.txt");
  writeFileSync(source, "committed first\n", "utf8");
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  const failed = toCommandReceipt({
    ok: false,
    command: "progress-append",
    error: cliError(CliErrorCode.WriteRejected, "execution lease is not reserving")
  });
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  const receipt = normalizeProgressAfterArtifact(failed, plan, { status: "accepted" });
  assert.equal(receipt.ok, false);
  if (receipt.ok) return;
  assert.match(receipt.error?.hint ?? "", /tasks\/task_A\/artifacts\/orphan\.txt/u);
  assert.match(receipt.error?.hint ?? "", /evidence pointer was not written/u);
  assert.match(receipt.error?.hint ?? "", /ha task progress append 'task_A'/u);
  const data = receipt.details?.data as Record<string, unknown>;
  assert.equal(data.pointerRecorded, false);
  assert.match(String(data.retryCommand), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
}));

test("unknown progress outcome does not claim the pointer is missing or offer an unconditional retry", () => withFixture(({ rootDir, taskId }) => {
  const source = path.join(rootDir, "unknown.txt");
  writeFileSync(source, "committed before outcome became unknown\n", "utf8");
  const plan = buildArtifactIngestPlan({ command: progressCommand(rootDir, taskId, source), repoId: "canonical", cwd: rootDir });
  assert.ok(plan);
  const failed = toCommandReceipt({
    ok: false,
    command: "progress-append",
    error: cliError(CliErrorCode.WriteRejected, "child writer response was lost")
  });
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  const receipt = normalizeProgressAfterArtifact({
    ...failed,
    error: { code: "repo_write_outcome_unknown", hint: "the write may already have taken effect" }
  }, plan, { status: "accepted" });
  assert.equal(receipt.ok, false);
  if (receipt.ok) return;
  assert.match(receipt.error?.hint ?? "", /tasks\/task_A\/artifacts\/unknown\.txt/u);
  assert.match(receipt.error?.hint ?? "", /progress append outcome is unknown/iu);
  assert.match(receipt.error?.hint ?? "", /first check progress\.md/iu);
  assert.doesNotMatch(receipt.error?.hint ?? "", /pointer was not written/iu);
  assert.doesNotMatch(receipt.error?.hint ?? "", /Retry or record the pointer with:/iu);
  const data = receipt.details?.data as Record<string, unknown>;
  assert.equal(data.pointerRecorded, "unknown");
  assert.equal(data.outcome, "unknown");
  assert.equal("retryCommand" in data, false);
}));

function progressCommand(rootDir: string, taskId: string, evidencePath: string): ParsedCommand {
  return {
    rootDir,
    json: true,
    action: {
      kind: "progress-append",
      taskId,
      text: "verification complete",
      evidence: [{ type: "log", path: evidencePath, summary: "green" }],
      dryRun: false
    }
  };
}

function artifactCommand(rootDir: string, taskId: string, sourcePath: string): ParsedCommand {
  return { rootDir, json: true, action: { kind: "artifact-add", taskId, sourcePaths: [sourcePath] } };
}

function withFixture(run: (fixture: { readonly rootDir: string; readonly harnessRoot: string; readonly taskId: string }) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-plan-"));
  const harnessRoot = path.join(rootDir, "harness");
  const taskId = "task_A";
  try {
    mkdirSync(path.join(harnessRoot, "tasks", taskId), { recursive: true });
    writeFileSync(path.join(harnessRoot, "tasks", taskId, "INDEX.md"), "---\ntask_id: task_A\nstatus: active\n---\n");
    git(harnessRoot, "init", "-q");
    git(harnessRoot, "config", "user.name", "Harness Test");
    git(harnessRoot, "config", "user.email", "harness@example.test");
    git(harnessRoot, "add", ".");
    git(harnessRoot, "commit", "-m", "seed");
    run({ rootDir, harnessRoot, taskId });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedPublishedArtifact(harnessRoot: string, taskId: string, name: string, body: string): string {
  const target = path.join(harnessRoot, "tasks", taskId, "artifacts", name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
  git(harnessRoot, "add", ".");
  git(harnessRoot, "commit", "-m", `seed published ${name}`);
  return target;
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
