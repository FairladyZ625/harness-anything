// harness-test-tier: integration
import test from "node:test";

import {
  assert,
  rmSync,
  runClient,
  setup,
  startClient,
  stopClient,
  waitForDaemonExit,
} from "./cli-lifecycle-user-journey-stress.fixture.ts";
import {
  cli,
  cliEnv,
  git,
  mkdirSync,
  path,
  published,
  realizedTaskPlan,
  register,
  run,
  setup as setupAutostart,
  spawnSync,
  statusOf,
  writeFileSync,
} from "./daemon-autostart-cli.fixture.ts";

// The eight-client stress case can exhaust the daemon's 10s start budget on Windows, which would
// keep the teardown assertion below from ever running. One client exercises the same ownership
// boundary: start a resident daemon, write through it, stop it, then remove the temporary root.
test("one isolated CLI client stops its daemon before the temporary root is removed", async () => {
  const fixture = setup(0);
  try {
    await startClient(fixture);
    const outcomes = await runClient(fixture, 0);
    assert.equal(outcomes.length, 3);
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("daemon exit wait names a process that never releases its endpoint", async () => {
  await assert.rejects(
    () =>
      waitForDaemonExit({
        pid: () => 999_999,
        deadline: Date.now() + 20,
        alive: () => true,
        endpointExists: () => true,
        delayMs: 5,
      }),
    /daemon-stop deadline exceeded/u,
  );
});

test("daemon exit wait returns once the process and endpoint are gone", async () => {
  await waitForDaemonExit({
    pid: () => null,
    deadline: Date.now() + 20,
    alive: () => false,
    endpointExists: () => false,
  });
});

test("daemon exit wait keeps probing after a PID appears below the initial snapshot", async () => {
  let pid: number | null = null,
    endpoint = true,
    discoveries = 0;
  await assert.rejects(
    () =>
      waitForDaemonExit({
        pid: () => pid,
        deadline: Date.now() + 40,
        alive: (value) => value === 999_999,
        endpointExists: () => endpoint,
        onStalled: () => {
          discoveries += 1;
          pid = 999_999;
          endpoint = false;
        },
        delayMs: 5,
      }),
    /daemon-stop deadline exceeded/u,
  );
  assert.ok(discoveries > 0, "the helper must keep probing after the PID is discovered");
});

test("semantic sources and agent execution cross the daemon before transport-bound human review completes", () => {
  const fixture = setupAutostart(),
    taskId = "task-executor-axis",
    executionId = "exec-executor-axis",
    reviewId = "review-executor-axis";

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  register(fixture.root, fixture.userRoot, "executor-axis");
  assert.equal(
    run(fixture.root, fixture.userRoot, ["settings", "update", "--closeout-profile", "strict"]).outcome,
    "applied",
  );
  const created = run(fixture.root, fixture.userRoot, [
    "task",
    "create",
    "--id",
    taskId,
    "--admin",
    "--title",
    "Executor Axis",
    "--preset",
    "standard-task",
  ]);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The executor and review actor axes remain distinct across the daemon.",
      "--source",
      "test:executor-axis",
    ]).outcome,
    "applied",
  );
  const packagePath = String(created.workspacePackagePath),
    closeoutPath = `${packagePath}/closeout.md`;
  const planPath = `${packagePath}/task_plan.md`;
  writeFileSync(path.join(fixture.root, planPath), realizedTaskPlan("Executor Axis"));
  assert.equal(run(fixture.root, fixture.userRoot, ["doc", "sync", "--submit", "--path", planPath]).outcome, "applied");

  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:claude-code")
      .outcome,
    "applied",
  );
  writeFileSync(
    path.join(fixture.root, packagePath, "artifacts", "executor-axis.txt"),
    "Executor and review actor axes remain distinct.\n",
  );
  const closeoutSync = run(
    fixture.root,
    fixture.userRoot,
    ["doc", "sync", "--submit", "--task", taskId],
    "agent:claude-code",
  );
  assert.equal(closeoutSync.outcome, "applied");
  published(fixture.root, fixture.userRoot, closeoutSync);
  const deliveryRoot = path.join(fixture.root, ".worktrees", taskId);
  writeFileSync(path.join(deliveryRoot, "README.md"), "# Executor axis implementation\n");
  git(deliveryRoot, "add", "README.md");
  git(deliveryRoot, "commit", "--quiet", "-m", "executor axis implementation");
  const deliveryCommit = git(deliveryRoot, "rev-parse", "HEAD");
  writeFileSync(
    path.join(fixture.root, closeoutPath),
    `# Closeout\n\n## Summary\n\nExecutor attribution restored at ${deliveryCommit}.\n\n` +
      "## Verification\n\nEnd-to-end daemon flow.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "submit", taskId, "--execution-id", executionId], "agent:claude-code")
      .outcome,
    "applied",
  );
  writeFileSync(
    path.join(fixture.root, "review.json"),
    JSON.stringify({
      verdict: "approved",
      reason: "Human review accepted the agent execution.",
      evidenceChecked: ["end-to-end daemon flow"],
      findings: [],
      resolutions: [],
    }),
  );
  mkdirSync(path.join(fixture.root, packagePath, "artifacts", "reports"), { recursive: true });
  writeFileSync(
    path.join(fixture.root, packagePath, "artifacts", "reports", "executor-axis.md"),
    "# Review review-executor-axis\n\nHuman review accepted the agent execution.\n",
  );
  const reviewed = run(fixture.root, fixture.userRoot, [
    "task",
    "review-execution",
    taskId,
    "--execution-id",
    executionId,
    "--review-id",
    reviewId,
    "--from-file",
    "review.json",
  ]);
  assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "review-consent",
      taskId,
      "--execution-id",
      executionId,
      "--review-id",
      reviewId,
    ]).outcome,
    "applied",
  );
  git(fixture.root, "update-ref", "refs/remotes/origin/main", deliveryCommit);
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "annotate",
      taskId,
      "--execution-id",
      executionId,
      "--note",
      `merge_commit_sha:${deliveryCommit}`,
    ]).outcome,
    "applied",
  );
  assert.equal(run(fixture.root, fixture.userRoot, ["task", "complete", taskId]).outcome, "applied");

  const shown = run(fixture.root, fixture.userRoot, ["task", "show", taskId]),
    snapshot = JSON.parse(String(shown.evidence)) as {
      task: { status: string; createdBy: unknown };
      executions: { actor: unknown }[];
      reviews: { actor: unknown }[];
    };
  assert.equal(snapshot.task.status, "done");
  assert.deepEqual(snapshot.task.createdBy, { principal: { personId: "owner" }, executor: null });
  assert.deepEqual(snapshot.executions[0]?.actor, {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "claude-code" },
  });
  assert.deepEqual(snapshot.reviews[0]?.actor, { principal: { personId: "owner" }, executor: null });
  const sourceTaskCreated = run(
    fixture.root,
    fixture.userRoot,
    ["task", "create", "--id", "task-source", "--admin", "--title", "Source"],
    "agent:codex",
  );
  assert.equal(sourceTaskCreated.outcome, "applied");
  const sourceTask = JSON.parse(
    String(run(fixture.root, fixture.userRoot, ["task", "show", "task-source"]).evidence),
  ) as { task: { createdBy: unknown } };
  assert.deepEqual(sourceTask.task.createdBy, {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "codex" },
  });
  writeFileSync(path.join(fixture.root, "artifact.md"), "# Artifact\n", "utf8");
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "artifact",
      "add",
      "task-source",
      "--source",
      "artifact.md",
      "--destination",
      `${sourceTaskCreated.workspacePackagePath}/artifacts/proof.md`,
    ]).outcome,
    "applied",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, ["relation", "list", "--source", "task/task-source"]).outcome,
    "applied",
  );
});

test("cancelled task reinstates to planned through the CLI and daemon", () => {
  const fixture = setupAutostart(),
    taskId = "task-reinstate";

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  register(fixture.root, fixture.userRoot, "reinstate");
  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Reinstate"]).outcome,
    "applied",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "transition",
      taskId,
      "cancelled",
      "--force",
      "--reason",
      "Erroneous batch cleanup",
    ]).outcome,
    "applied",
  );
  assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "cancelled");

  // A reinstate without the auditable reason is refused by the CLI before it can reach the daemon.
  const bare = spawnSync(
    process.execPath,
    [cli, "--root", fixture.root, "--json", "task", "transition", taskId, "planned"],
    { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) },
  );
  assert.equal(bare.status, 2, `${bare.stderr}\n${bare.stdout}`);
  const bareReceipt = JSON.parse(bare.stdout) as { ok: boolean; error?: { code: string } };
  assert.equal(bareReceipt.ok, false);
  assert.equal(bareReceipt.error?.code, "missing_field");

  const reinstated = run(fixture.root, fixture.userRoot, [
    "task",
    "transition",
    taskId,
    "planned",
    "--reason",
    "Owner adjudicated rollback of the batch cancellation",
  ]);
  assert.equal(reinstated.outcome, "applied", JSON.stringify(reinstated));
  assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "planned");
});
