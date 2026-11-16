// harness-test-tier: integration
import test from "node:test";
import {
  assert,
  cli,
  cliEnv,
  git,
  mkdirSync,
  path,
  published,
  realizedTaskPlan,
  register,
  run,
  setup,
  spawnSync,
  stop,
  writeFileSync,
} from "./daemon-autostart-cli.fixture.ts";

test("fact supersession CLI identifies the invalid field and preserves canonical admission", async (context) => {
  const fixture = setup();
  const record = ["fact", "record", "--statement", "Replacement observation", "--source", "test:supersession"];
  try {
    register(fixture.root, fixture.userRoot, "fact-supersedes-cli");
    const first = run(fixture.root, fixture.userRoot, [
      "fact",
      "record",
      "--statement",
      "Original observation",
      "--source",
      "test:original",
    ]);
    published(fixture.root, fixture.userRoot, first);
    const factRef = `fact/${first.factId}`;
    const cases = [
      {
        name: "bare fact id",
        ref: String(first.factId),
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "other entity ref",
        ref: "task/task-example",
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "malformed canonical ref",
        ref: "fact/F-invalid",
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "empty rationale",
        ref: factRef,
        rationale: "",
        field: "--rationale",
        hint: "--rationale is required",
        code: "invalid_field",
      },
      {
        name: "excessive rationale",
        ref: factRef,
        rationale: "x".repeat(200),
        field: "--rationale",
        hint: "1-199",
        code: "invalid_field",
      },
    ];
    for (const scenario of cases) {
      await context.test(scenario.name, () => {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "--root",
            fixture.root,
            "--json",
            ...record,
            "--supersedes",
            scenario.ref,
            "--rationale",
            scenario.rationale,
          ],
          {
            encoding: "utf8",
            env: cliEnv(fixture.root, fixture.userRoot),
          },
        );
        assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
        console.log(`${scenario.name}: ${result.stdout.trim()}`);
        assert.equal(receipt.code, scenario.code);
        assert.ok(result.stdout.includes(scenario.field), result.stdout);
        assert.ok(result.stdout.includes(scenario.hint), result.stdout);
        assert.ok(result.stdout.includes("--rationale"), result.stdout);
        assert.ok(result.stdout.includes("Replaces the earlier observation."), result.stdout);
      });
    }
    await context.test("plain CLI renders the canonical correction", () => {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--root",
          fixture.root,
          ...record,
          "--supersedes",
          String(first.factId),
          "--rationale",
          "Replaces the original.",
        ],
        {
          encoding: "utf8",
          env: cliEnv(fixture.root, fixture.userRoot),
        },
      );
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      console.log(`plain CLI stderr: ${result.stderr.trim()}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--supersedes fact\/F-12345678/u);
      assert.match(result.stderr, /--rationale "Replaces the earlier observation\."/u);
    });
    await context.test("ordinary record parameter errors do not suggest supersession", () => {
      const result = spawnSync(process.execPath, [cli, "--root", fixture.root, ...record, "--confidence", "wrong"], {
        encoding: "utf8",
        env: cliEnv(fixture.root, fixture.userRoot),
      });
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      console.log(`ordinary record stderr: ${result.stderr.trim()}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--confidence/u);
      assert.match(result.stderr, /one of low, medium, high/u);
      assert.doesNotMatch(
        result.stderr,
        /--supersedes|--rationale|Updated observation|Replaces the earlier observation/u,
      );
    });
    await context.test("canonical ref remains successful at the rationale length boundary", () => {
      const before = run(fixture.root, fixture.userRoot, ["fact", "show", String(first.factId)]);
      assert.equal((JSON.parse(String(before.evidence)) as { fact: { state: string } }).fact.state, "standing");
      const accepted = run(fixture.root, fixture.userRoot, [
        ...record,
        "--supersedes",
        factRef,
        "--rationale",
        "x".repeat(199),
      ]);
      console.log(`canonical ref: ${JSON.stringify(accepted)}`);
      assert.equal(accepted.outcome, "applied");
      assert.equal(accepted.status, "accepted_durable");
      published(fixture.root, fixture.userRoot, accepted);
      const after = run(fixture.root, fixture.userRoot, ["fact", "show", String(first.factId)]);
      assert.equal((JSON.parse(String(after.evidence)) as { fact: { state: string } }).fact.state, "superseded_fact");
    });
  } finally {
    stop(fixture.root, fixture.userRoot);
  }
});

test("semantic sources and agent execution cross the daemon before transport-bound human review completes", () => {
  const fixture = setup(),
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
