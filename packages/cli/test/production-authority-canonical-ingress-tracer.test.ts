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
  authorityEventBodies,
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

test("commit-anchor completion crosses production authority with daemon judgment and atomic task transition", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNY0";
  const taskRoot = path.join(fixture.authoredRoot, "tasks", taskId);
  const sessionId = "commit-anchor-authority-tracer";
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: sessionId
  };
  try {
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    copyFileSync(
      path.resolve("tools/write-road-registry.json"),
      path.join(fixture.repoRoot, "tools/write-road-registry.json")
    );
    mkdirSync(taskRoot, { recursive: true });
    const sourceIndex = readFileSync(path.join(
      fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"
    ), "utf8");
    writeFileSync(path.join(taskRoot, "INDEX.md"), sourceIndex.replaceAll("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", taskId));
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Complete from a public workspace commit."));
    writeFileSync(path.join(taskRoot, "closeout.md"), [
      "# Closeout", "", "## Summary", "", "The public commit completes the task.", "",
      "## Verification", "", "Authority verifies the commit and anchor.", "",
      "## Residual Risk", "", "None known.", ""
    ].join("\n"));
    writeFileSync(path.join(taskRoot, "code-doc-anchors.json"), `${JSON.stringify({
      schema: "code-doc-reconciliation/v1",
      taskId,
      records: [{
        id: "closeout", ledgerPath: "closeout.md", kind: "closeout",
        anchors: [{ kind: "commit", sha: fixture.publicHead }, { kind: "path", sha: fixture.publicHead, path: "README.md" }]
      }]
    }, null, 2)}\n`);
    writeFileSync(path.join(fixture.authoredRoot, "harness.yaml"), [
      "schema: harness-anything/v1", "project: production-ingress", "settings:", "  tasks:", "    leaseEnforcement: true", ""
    ].join("\n"));
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "add", "."], { cwd: fixture.authoredRoot });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-q", "-m", "seed commit completion fixture"], { cwd: fixture.authoredRoot });

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
      // Observe the detached service if startup exceeds the CLI reachability wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-31T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], env);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));

    // Establish the immutable prepublish witness independently of the completion
    // receipt. The completion client does not inspect this receipt or derive a
    // follow-up step; the daemon verifier later finds this first-parent materialization.
    writeFileSync(
      path.join(taskRoot, "task_plan.md"),
      readFileSync(path.join(taskRoot, "task_plan.md"), "utf8").replace(
        "Complete from a public workspace commit.",
        "Canonical prepublish snapshot established for completion."
      )
    );
    const prepublished = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit", "--path", `tasks/${taskId}/task_plan.md`
    ], env);
    assert.equal(prepublished.status, 0, JSON.stringify(prepublished.receipt));
    assert.equal(prepublished.receipt.ok, true, JSON.stringify(prepublished.receipt));
    const materialized = runRawJsonMaybeFail(fixture.repoRoot, [
      "materializer", "run", "--current-session-only"
    ], env);
    assert.equal(materialized.status, 0, JSON.stringify(materialized.receipt));
    assert.equal(materialized.receipt.ok, true, JSON.stringify(materialized.receipt));
    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));
    const witnessMaterialized = runRawJsonMaybeFail(fixture.repoRoot, [
      "materializer", "run", "--current-session-only"
    ], env);
    assert.equal(witnessMaterialized.status, 0, JSON.stringify(witnessMaterialized.receipt));

    const completed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId,
      "--commit-anchor", fixture.publicHead,
      "--judgment", "The anchored public workspace commit satisfies this task's implementation and verification scope.",
      "--ci", "passed"
    ], env);
    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    const evidencePath = path.join(taskRoot, "completion-evidence.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.mode, "commit-anchor");
    assert.equal(evidence.anchor.sha, fixture.publicHead);
    assert.equal(evidence.judgment.actor.principal.personId, "person_alice");
    assert.deepEqual(evidence.judgment.actor.executor, { kind: "agent", id: "codex" });
    assert.equal(evidence.judgment.sessionRef, `session/${sessionId}`);
    assert.deepEqual(evidence.gateReceipt.applicableGates, ["ci", "code-doc-reconciliation"]);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /status: done/u);
    assert.equal(authorityEventBodies(fixture.authoredRoot).some((body) =>
      body.includes(sessionId) && body.includes(`task/${taskId}`)
    ), true);

    const operation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.deepEqual(
      operation.authorityIntegrity?.canonicalMutationSet.mutations.map((mutation) => [mutation.entity.entityKind, mutation.action.action]),
      [["task", "document"], ["task", "transition"]]
    );
    const publication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
      .findPublicationForOperation(operation.opId!);
    assert.equal(publication.physicalChanges.some((change) => change.path === `tasks/${taskId}/completion-evidence.json`), true);
    assert.equal(publication.physicalChanges.some((change) => change.path === `tasks/${taskId}/INDEX.md`), true);
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
  const sessionBranch = "sessions/doc-sync-production-writer-child";
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
    const trunkHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.authoredRoot,
      encoding: "utf8"
    }).trim();

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
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      trunkHead
    );
    assert.match(readFileSync(planPath, "utf8"), /Original governed prose/u);
    assert.match(
      execFileSync("git", ["show", `${sessionBranch}:tasks/${taskId}/task_plan.md`], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }),
      /Updated through the writer child/u
    );
    assert.equal(
      execFileSync("git", ["status", "--short", "--", `tasks/${taskId}/task_plan.md`], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      ""
    );
    assert.match(
      execFileSync("git", ["log", "-1", "--format=%s", sessionBranch], {
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
