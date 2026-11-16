// harness-test-tier: integration
import test from "node:test";
import {
  assert,
  cli,
  cliEnv,
  git,
  path,
  published,
  realizedTaskPlan,
  register,
  run,
  setup,
  spawnSync,
  statusOf,
  writeFileSync,
} from "./daemon-autostart-cli.fixture.ts";

test("submitted contract migration continues through the CLI without losing historical execution", () => {
  const fixture = setup(),
    taskId = "task-contract-lifecycle";
  const cli = (...args: string[]) => run(fixture.root, fixture.userRoot, args);
  const show = () => JSON.parse(String(cli("task", "show", taskId).evidence));
  assert.equal(cli("daemon", "start", "--service").ok, true);
  register(fixture.root, fixture.userRoot, "contract-lifecycle");
  const created = cli(
    "task",
    "create",
    "--id",
    taskId,
    "--admin",
    "--title",
    "Contract lifecycle",
    "--preset",
    "standard-task",
    "--risk-tier",
    "low",
  );
  published(fixture.root, fixture.userRoot, created);
  const packagePath = String(created.workspacePackagePath);
  writeFileSync(path.join(fixture.root, packagePath, "task_plan.md"), realizedTaskPlan("Contract lifecycle"));
  assert.equal(cli("doc", "sync", "--submit", "--task", taskId).outcome, "applied");
  assert.equal(cli("task", "start", taskId, "--execution-id", "execution-original").outcome, "applied");
  const deliveryRoot = path.join(fixture.root, ".worktrees", taskId);
  writeFileSync(path.join(deliveryRoot, "README.md"), "# Contract lifecycle implementation\n");
  git(deliveryRoot, "add", "README.md");
  git(deliveryRoot, "commit", "--quiet", "-m", "fix: contract lifecycle fixture");
  const sha = git(deliveryRoot, "rev-parse", "HEAD");
  writeFileSync(
    path.join(fixture.root, packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\nImplemented contract lifecycle at ${sha}.\n\n## Verification\n\nCLI lifecycle assertions passed.\n\n## Residual Risk\n\nNone observed.\n\n## Same Mechanism Elsewhere\n\nIteration changes retain historical executions.\n`,
  );
  assert.equal(cli("task", "submit", taskId, "--execution-id", "execution-original").outcome, "applied");
  const before = show();
  assert.equal(before.task.status, "submitted");
  assert.equal(before.executions.length, 1);
  const migrate = (...mode: string[]) =>
    cli("task", "contract", "migrate", "--task", taskId, "--to-preset", "docs-task", ...mode);
  assert.equal(migrate("--dry-run").outcome, "pending");
  assert.deepEqual(show(), before, "dry-run must leave the lifecycle unchanged");
  assert.equal(migrate("--apply").outcome, "applied");
  const migrated = show();
  assert.equal(migrated.task.iteration, before.task.iteration + 1);
  assert.equal(migrated.task.status, "submitted");
  assert.equal(migrated.lease, null);
  assert.equal(
    migrated.executions.some((execution: { iteration: number }) => execution.iteration === migrated.task.iteration),
    false,
  );
  assert.deepEqual(migrated.executions, before.executions);
  assert.deepEqual(migrated.reviews, before.reviews);
  assert.equal(migrated.completionNext.action, `ha task start ${taskId}`);
  const started = cli("task", "start", taskId, "--execution-id", "execution-new-contract");
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  assert.equal(show().task.status, "active");
  writeFileSync(
    path.join(fixture.root, packagePath, "artifacts", "iteration-two.md"),
    "# Contract migration deliverable\n\nThe new contract has a deliverable.\n",
  );
  assert.equal(cli("doc", "sync", "--submit", "--task", taskId).outcome, "applied");
  assert.equal(cli("task", "submit", taskId, "--execution-id", "execution-new-contract").outcome, "applied");
  const after = show();
  assert.equal(after.task.status, "submitted");
  assert.deepEqual(after.executions[0], before.executions[0]);
  assert.deepEqual(after.reviews, before.reviews);
});

test("cancelled task reinstates to planned through the CLI and daemon", () => {
  const fixture = setup(),
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
