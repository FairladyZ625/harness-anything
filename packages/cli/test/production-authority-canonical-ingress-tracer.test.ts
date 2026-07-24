// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGitCanonicalPublicationInspector } from "@harness-anything/daemon";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  createFixture,
  latestAuthorityOperation
} from "./production-authority-canonical-ingress/fixture.ts";

test("PR canonical ingress tracer starts the real daemon and publishes one full-chain task write", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "canonical-ingress-pr-tracer"
  };
  try {
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Keep observing the detached production service when startup outlives
      // the CLI command's fixed reachability wait.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.repoCount, 1, JSON.stringify(status));

    const appended = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--text", "PR canonical ingress tracer"
    ], env);
    assert.equal(appended.status, 0, JSON.stringify(appended.receipt));
    assert.equal(appended.receipt.ok, true, JSON.stringify(appended.receipt));
    assert.match(readFileSync(path.join(
      fixture.authoredRoot,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"
    ), "utf8"), /PR canonical ingress tracer/u);

    const operation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "COMMITTED", JSON.stringify(operation));
    assert.equal(typeof operation.opId, "string", JSON.stringify(operation));
    const publication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
      .findPublicationForOperation(operation.opId!);
    assert.equal(publication.commitSha, operation.commitSha);
    assert.equal(publication.physicalChanges.some((change) => change.path ===
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"), true);
    assert.equal(publication.physicalChanges.some((change) => change.path.startsWith("attribution-events/")), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doc sync submit dispatches prose to the production writer child", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0";
  const planPath = path.join(fixture.authoredRoot, `tasks/${taskId}/task_plan.md`);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "doc-sync-production-writer-child"
  };
  try {
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    copyFileSync(
      path.resolve("tools/write-road-registry.json"),
      path.join(fixture.repoRoot, "tools/write-road-registry.json")
    );
    writeFileSync(planPath, productionPlan("Original governed prose."));
    execFileSync("git", [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "add", `tasks/${taskId}/task_plan.md`
    ], { cwd: fixture.authoredRoot });
    execFileSync("git", [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "commit", "-q", "-m", "seed doc sync fixture"
    ], { cwd: fixture.authoredRoot });

    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot,
      "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Startup can outlive the command's reachability wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, [
        "daemon", "status", "--user-root", userRoot, "--json"
      ], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    writeFileSync(planPath, productionPlan("Updated through the writer child."));

    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit"
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
    assert.equal(submitted.receipt.ok, true, JSON.stringify(submitted.receipt));
    assert.equal(submitted.receipt.details?.data?.report?.status, "accepted");
    assert.equal(
      submitted.receipt.details?.data?.report?.appliedChanges?.length,
      1,
      JSON.stringify(submitted.receipt)
    );
    assert.equal(
      submitted.receipt.details?.data?.report?.appliedChanges?.[0]?.path,
      `tasks/${taskId}/task_plan.md`,
      JSON.stringify(submitted.receipt)
    );
    assert.match(readFileSync(planPath, "utf8"), /Updated through the writer child/u);
    assert.equal(
      execFileSync("git", ["status", "--short", "--", `tasks/${taskId}/task_plan.md`], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      ""
    );
    assert.match(
      execFileSync("git", ["log", "-1", "--format=%s"], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      /^entity\(doc-sync-submit\): doc-sync\//u
    );
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function productionPlan(goal: string): string {
  return [
    "# Plan", "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}
