// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts");
type TaskSnapshot = {
  readonly task: { readonly status: string; readonly currentNode: string };
  readonly executions: readonly {
    readonly state: string;
    readonly actor: { readonly executor: null | { readonly kind: string; readonly id: string } };
  }[];
  readonly reviews: readonly { readonly verdict: string }[];
};

test("a live source daemon recovers a reviewed execution whose executor was omitted", async (context) => {
  const parent = mkdtempSync(path.join(privateTemporaryRoot(), "executor-null-live.")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "edge-user-root"),
    daemonId = `edge-executor-null-${process.pid}`,
    taskId = "task-executor-null-live",
    executionId = "execution-executor-null-live",
    reviewId = "review-executor-null-live";
  let daemon: ChildProcess | undefined;
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId: "executor-null-live" });
  try {
    daemon = spawnSourceDaemon(root, userRoot, daemonId);
    const status = waitForDaemon(root, userRoot, daemonId),
      daemonPid = readDaemonPid(userRoot, daemonId);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(daemonPid, daemon.pid, "the responding daemon must be the explicitly spawned source process");
    assert.deepEqual(status.target, {
      endpoint: localUserDaemonEndpoint(userRoot, daemonId),
      daemonId,
      userRoot,
      repoId: null,
      canonicalRoot: null,
    });

    assert.equal(
      run(root, userRoot, daemonId, ["daemon", "repo", "register", "--repo-id", "executor-null-live", "--root", root])
        .outcome,
      "applied",
    );
    const created = run(root, userRoot, daemonId, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Executor null live",
      ]),
      packagePath = String(created.packagePath),
      planPath = `${packagePath}/task_plan.md`,
      closeoutPath = `${packagePath}/closeout.md`;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    writeFileSync(path.join(root, "harness", planPath), realizedTaskPlan("Executor null live"));
    assert.equal(run(root, userRoot, daemonId, ["doc", "sync", "--submit", "--path", planPath]).outcome, "applied");
    assert.equal(
      run(root, userRoot, daemonId, [
        "fact",
        "record",
        "--task",
        taskId,
        "--statement",
        "The reviewed execution can recover its omitted executor through the live daemon.",
        "--source",
        "test:executor-null-live",
      ]).outcome,
      "applied",
    );
    assert.equal(
      run(root, userRoot, daemonId, ["task", "start", taskId, "--execution-id", executionId]).outcome,
      "applied",
    );
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nExecutor attribution recovered.\n\n## Verification\n\nLive daemon route.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nCovered by the executor declaration contract.\n",
    );
    assert.equal(run(root, userRoot, daemonId, ["doc", "sync", "--submit", "--task", taskId]).outcome, "applied");
    const commitSha = git(root, "rev-parse", "HEAD");
    writeFileSync(
      path.join(root, "submission.json"),
      JSON.stringify({
        completionClaim: "The live daemon executor recovery is complete.",
        deliverables: ["README.md"],
        outputs: ["README.md"],
        verificationNotes: ["live source daemon route"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    assert.equal(
      run(root, userRoot, daemonId, [
        "task",
        "submit",
        taskId,
        "--execution-id",
        executionId,
        "--from-file",
        "submission.json",
      ]).outcome,
      "applied",
    );
    assert.equal(
      run(root, userRoot, daemonId, ["task", "code-doc", "reconcile", taskId], "agent:worker").outcome,
      "applied",
    );
    writeFileSync(
      path.join(root, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent agent review passed.",
        evidenceChecked: ["live source daemon route"],
      }),
    );
    const reviewed = run(
      root,
      userRoot,
      daemonId,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        reviewId,
        "--from-file",
        "review.json",
      ],
      "agent:reviewer",
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const before = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId]));
    assert.equal(before.executions[0]?.actor.executor, null);
    assert.equal(before.reviews[0]?.verdict, "approved");

    const declared = run(
      root,
      userRoot,
      daemonId,
      [
        "task",
        "declare-executor",
        taskId,
        "--execution-id",
        executionId,
        "--reason",
        "The original principal names the agent that performed the approved work.",
      ],
      "agent:worker",
    );
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    writeFileSync(
      path.join(root, "consent.json"),
      JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }),
    );
    assert.equal(
      run(root, userRoot, daemonId, [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        reviewId,
        "--consent-id",
        "consent-executor-null-live",
        "--from-file",
        "consent.json",
      ]).outcome,
      "applied",
    );
    const completed = run(root, userRoot, daemonId, [
        "task",
        "complete",
        taskId,
        "--execution-id",
        executionId,
        "--ci",
        "passed",
      ]),
      after = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId]));
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(after.task.status, "done");
    assert.deepEqual(after.executions[0]?.actor.executor, { kind: "agent", id: "worker" });
    assert.equal(
      after.reviews.some((review) => review.verdict === "changes_requested"),
      false,
    );
    context.diagnostic(
      `executor-null-live-receipt=${JSON.stringify({
        daemonId,
        userRoot,
        sourceEntry: cli,
        nodeEntry: process.execPath,
        pid: daemonPid,
        target: status.target,
        before: {
          taskStatus: before.task.status,
          currentNode: before.task.currentNode,
          executionState: before.executions[0]?.state,
          executor: before.executions[0]?.actor.executor,
          reviewVerdict: before.reviews[0]?.verdict,
        },
        declared: { outcome: declared.outcome, opId: declared.opId },
        completed: { outcome: completed.outcome, opId: completed.opId, taskStatus: after.task.status },
        changesRequestedReviews: after.reviews.filter((review) => review.verdict === "changes_requested").length,
      })}`,
    );

    const stopped = run(root, userRoot, daemonId, ["daemon", "stop", "--user-root", userRoot, "--daemon-id", daemonId]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    await childExit(daemon);
    daemon = undefined;
    assert.equal(readDaemonPid(userRoot, daemonId), null);
    assert.equal(existsSync(localUserDaemonEndpoint(userRoot, daemonId)), false);
  } finally {
    if (readDaemonPid(userRoot, daemonId) !== null)
      runMaybe(root, userRoot, daemonId, ["daemon", "stop", "--user-root", userRoot, "--daemon-id", daemonId]);
    if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
    if (daemon) await childExit(daemon);
    rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(existsSync(userRoot), false, "the dedicated daemon user-root must be removed after the live probe");
});

function privateTemporaryRoot(): string {
  const preferred = "/private/tmp";
  try {
    mkdirSync(preferred, { recursive: true });
    accessSync(preferred, constants.W_OK);
    return preferred;
  } catch {
    return tmpdir();
  }
}

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1
people:
  - personId: owner
    displayName: Owner
    primaryEmail: owner@example.test
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:${hostname()}
        subject: ${process.getuid?.() ?? 0}
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Executor Null Live Test");
  git(root, "config", "user.email", "executor-null-live@example.test");
  git(root, "add", "README.md", "harness");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function spawnSourceDaemon(root: string, userRoot: string, daemonId: string): ChildProcess {
  return spawn(process.execPath, [cli, "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId, "--json"], {
    cwd: root,
    env: environment(root, userRoot, daemonId),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForDaemon(root: string, userRoot: string, daemonId: string): Record<string, unknown> {
  let last = runMaybe(root, userRoot, daemonId, ["daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId]);
  for (let attempt = 0; attempt < 300 && last.status !== 0; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    last = runMaybe(root, userRoot, daemonId, ["daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId]);
  }
  assert.equal(last.status, 0, `${last.stderr}\n${last.stdout}`);
  return JSON.parse(last.stdout) as Record<string, unknown>;
}

function run(
  root: string,
  userRoot: string,
  daemonId: string,
  args: readonly string[],
  actor?: string,
): Record<string, unknown> {
  const result = runMaybe(root, userRoot, daemonId, args, actor);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runMaybe(
  root: string,
  userRoot: string,
  daemonId: string,
  args: readonly string[],
  actor?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, daemonId, actor),
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function environment(root: string, userRoot: string, daemonId: string, actor?: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemon,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    ...(actor ? { HARNESS_ACTOR: actor } : {}),
  };
}

function taskSnapshot(receipt: Record<string, unknown>): TaskSnapshot {
  return JSON.parse(String(receipt.evidence)) as TaskSnapshot;
}

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
