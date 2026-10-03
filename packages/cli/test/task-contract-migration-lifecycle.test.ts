// harness-test-tier: integration
import test from "node:test";
import {
  assert,
  setup,
  register,
  run,
  published,
  writeFileSync,
  path,
  realizedTaskPlan,
  git,
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
  );
  published(fixture.root, fixture.userRoot, created);
  const packagePath = String(created.packagePath);
  writeFileSync(
    path.join(fixture.root, "harness", packagePath, "task_plan.md"),
    realizedTaskPlan("Contract lifecycle"),
  );
  assert.equal(cli("doc", "sync", "--submit", "--task", taskId).outcome, "applied");
  assert.equal(cli("task", "start", taskId, "--execution-id", "execution-original").outcome, "applied");
  const deliveryRoot = path.join(fixture.root, ".worktrees", taskId);
  writeFileSync(path.join(deliveryRoot, "README.md"), "# Contract lifecycle implementation\n");
  git(deliveryRoot, "add", "README.md");
  git(deliveryRoot, "commit", "--quiet", "-m", "fix: contract lifecycle fixture");
  const sha = git(deliveryRoot, "rev-parse", "HEAD");
  writeFileSync(
    path.join(fixture.root, "harness", packagePath, "closeout.md"),
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
  assert.equal(cli("task", "submit", taskId, "--execution-id", "execution-new-contract").outcome, "applied");
  const after = show();
  assert.equal(after.task.status, "submitted");
  assert.deepEqual(after.executions[0], before.executions[0]);
  assert.deepEqual(after.reviews, before.reviews);
});
