// harness-test-tier: integration
import test from "node:test";
import * as shared from "./cli-lifecycle-user-journey-stress.fixture.ts";

const {
  assert,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  path,
  realizedTaskPlan,
  clientCount,
  runChain,
  startClient,
  stopClient,
  setup,
  actorLabel,
  actorEnvironment,
  packagePathFor,
  createArgs,
  facetState,
  docScanRows,
  waitForMaterializationFailure,
  parseCliReceipt,
  expectApplied,
  published,
  runResult,
  git,
} = shared;

test("eight CLI clients share one center while completing each task", async (context) => {
  const fixture = setup(8),
    startedAt = Date.now();
  try {
    await startClient(fixture);
    const outcomes = await Promise.all(
      Array.from({ length: clientCount }, (_, clientIndex) =>
        runChain(fixture, clientIndex, 0, actorLabel(clientIndex)),
      ),
    );
    assert.equal(outcomes.length, clientCount);
    assert.equal(new Set(outcomes.map(({ taskId }) => taskId)).size, clientCount);
    assert.ok(outcomes.every(({ status }) => status === "done"));
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-shared-center/v1",
        topology: "eight-clients-one-daemon-one-repo",
        clients: clientCount,
        chains: outcomes.length,
        elapsedMs: Date.now() - startedAt,
        chainElapsedMs: outcomes.map(({ elapsedMs }) => elapsedMs),
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI changes-requested recovery releases and re-enters a new execution", async (context) => {
  const fixture = setup(9),
    taskId = "task-cli-changes-requested",
    firstExecutionId = "execution-cli-changes-requested-1",
    secondExecutionId = "execution-cli-changes-requested-2",
    workerEnvironment = actorEnvironment(fixture, 0, "agent:recovery-worker"),
    reviewerEnvironment = actorEnvironment(fixture, 1, "agent:recovery-reviewer");
  try {
    await startClient(fixture);
    const created = await expectApplied(
        fixture,
        [
          "task",
          "create",
          "--id",
          taskId,
          "--title",
          "CLI changes requested recovery",
          "--preset",
          "docs-task",
          "--vertical",
          "software/coding",
          "--kind",
          "docs",
          "--admin",
        ],
        workerEnvironment,
      ),
      packagePath = String(created.packagePath),
      packageRoot = path.join(fixture.root, "harness", packagePath),
      closeoutPath = path.join(packageRoot, "closeout.md");
    await published(fixture, created, workerEnvironment);
    writeFileSync(path.join(packageRoot, "task_plan.md"), realizedTaskPlan("CLI changes requested recovery"));
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\nRecovery chain.\n\n## Verification\n\nCLI recovery.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
    );
    await expectApplied(
      fixture,
      ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
      workerEnvironment,
    );
    await expectApplied(
      fixture,
      [
        "fact",
        "record",
        "--task",
        taskId,
        "--statement",
        "The CLI recovery fixture reached its first execution.",
        "--source",
        `test:cli-lifecycle-recovery/${taskId}`,
        "--confidence",
        "high",
      ],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", firstExecutionId], workerEnvironment);
    await expectApplied(
      fixture,
      ["task", "release", taskId, "--reason", "re-dispatch before the first review"],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", firstExecutionId], workerEnvironment);
    await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
    writeFileSync(path.join(packageRoot, "artifacts", "recovery.txt"), "Changes-requested recovery execution.\n");
    const artifactSync = await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
    writeFileSync(
      closeoutPath,
      `# Closeout\n\n## Summary\n\nFirst execution needs another iteration: artifact:${packagePath}/artifacts/recovery.txt@${artifactSync.revision}\n\n` +
        "## Verification\n\nChanges-requested recovery exercised.\n\n" +
        "## Residual Risk\n\n已知缺口：review requested another iteration\n\n" +
        "## Same Mechanism Elsewhere\n\nRecovery lifecycle.\n",
    );
    await expectApplied(fixture, ["task", "submit", taskId, "--execution-id", firstExecutionId], workerEnvironment);
    await expectApplied(
      fixture,
      ["task", "adjudicate", taskId, "--forward", "--note", "Forward first stress cut."],
      workerEnvironment,
    );
    mkdirSync(path.join(packageRoot, "artifacts", "reports"), { recursive: true });
    writeFileSync(
      path.join(packageRoot, "artifacts", "reports", "cli-changes-requested.md"),
      "# Review review-cli-changes-requested\n\nThe first iteration needs a clearer verification note.\n",
    );
    const requested = await expectApplied(
      fixture,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        firstExecutionId,
        "--review-id",
        "review-cli-changes-requested",
        "--json-input",
        JSON.stringify({
          verdict: "changes_requested",
          reason: "The first iteration needs a clearer verification note.",
          evidenceChecked: [packagePathFor(packagePath, "closeout.md")],
        }),
      ],
      reviewerEnvironment,
    );
    assert.equal(requested.outcome, "applied");
    await expectApplied(
      fixture,
      [
        "task",
        "adjudicate",
        taskId,
        "--return",
        "--review-id",
        "review-cli-changes-requested",
        "--note",
        "Return the first stress cut for rework.",
      ],
      workerEnvironment,
    );
    const afterRequest = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
      afterRequestEvidence = JSON.parse(String(afterRequest.evidence)) as {
        readonly task?: { readonly status?: string; readonly iteration?: number };
      };
    assert.equal(afterRequestEvidence.task?.status, "active");
    assert.equal(afterRequestEvidence.task?.iteration, 1);
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    writeFileSync(
      closeoutPath,
      `# Closeout\n\n## Summary\n\nSecond execution addresses the verification note: artifact:${packagePath}/artifacts/recovery.txt@${artifactSync.revision}\n\n` +
        "## Verification\n\nRequested verification note addressed.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nRecovery lifecycle.\n",
    );
    await expectApplied(fixture, ["task", "submit", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    await expectApplied(
      fixture,
      ["task", "adjudicate", taskId, "--forward", "--note", "Forward second stress cut."],
      workerEnvironment,
    );
    writeFileSync(
      path.join(packageRoot, "artifacts", "reports", "cli-recovery-approved.md"),
      "# Review review-cli-recovery-approved\n\nThe second execution includes the requested verification note.\n",
    );
    await expectApplied(
      fixture,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-cli-recovery-approved",
        "--json-input",
        JSON.stringify({
          verdict: "approved",
          reason: "The second execution includes the requested verification note.",
          evidenceChecked: [packagePathFor(packagePath, "closeout.md")],
        }),
      ],
      reviewerEnvironment,
    );
    await expectApplied(
      fixture,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-cli-recovery-approved",
      ],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "complete", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    const final = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
      finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
    assert.equal(finalEvidence.task?.status, "done");
    context.diagnostic(
      JSON.stringify({ schema: "cli-lifecycle-recovery/v1", taskId, firstExecutionId, secondExecutionId }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI accepted receipt and daemon restart recover an in-flight task", async (context) => {
  const fixture = setup(10),
    taskId = "task-cli-restart-recovery",
    executionId = "execution-cli-restart-recovery",
    environment = actorEnvironment(fixture, 0, "agent:restart-worker");
  try {
    await startClient(fixture);
    const created = await expectApplied(
        fixture,
        [
          "task",
          "create",
          "--id",
          taskId,
          "--title",
          "CLI daemon restart recovery",
          "--preset",
          "docs-task",
          "--vertical",
          "software/coding",
          "--kind",
          "docs",
          "--admin",
        ],
        environment,
      ),
      opId = String(created.opId),
      receipt = await expectApplied(
        fixture,
        [
          "receipt",
          "show",
          opId,
          "--wait",
          "accepted_durable,projection_visible,git_verified,worktree_visible",
          "--timeout-ms",
          "5000",
        ],
        environment,
      );
    const acceptanceCut = receipt.acceptance?.cut as { readonly generation?: number } | undefined;
    assert.equal(acceptanceCut?.generation, 2, JSON.stringify(receipt));
    for (const facet of ["projection", "git", "worktree", "replica"] as const) {
      const value = receipt[facet] as {
        readonly state?: string;
        readonly cut?: { readonly generation?: number } | null;
      };
      if (value.state === "verified") assert.equal(value.cut?.generation, 2, `${facet}: ${JSON.stringify(receipt)}`);
    }
    assert.deepEqual(receipt.wait, { state: "satisfied", unsatisfied: [] });
    assert.equal((receipt.git as { readonly state?: string }).state, "verified");
    const packagePath = String(created.packagePath),
      packageRoot = path.join(fixture.root, "harness", packagePath),
      planPath = path.join(packageRoot, "task_plan.md"),
      closeoutPath = path.join(packageRoot, "closeout.md");
    writeFileSync(planPath, realizedTaskPlan("CLI daemon restart recovery"));
    await expectApplied(
      fixture,
      ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
      environment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", executionId], environment);
    await expectApplied(
      fixture,
      ["task", "progress", "append", taskId, "--text", "before daemon restart"],
      environment,
    );
    await stopClient(fixture);
    await startClient(fixture);
    await expectApplied(fixture, ["task", "progress", "append", taskId, "--text", "after daemon restart"], environment);
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\nRestart recovery.\n\n## Verification\n\nDaemon restarted during execution.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
    );
    await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], environment);
    const final = await expectApplied(fixture, ["task", "show", taskId], environment),
      finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
    assert.equal(finalEvidence.task?.status, "active");
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-restart-recovery/v1",
        taskId,
        opId,
        executionId,
        acceptanceGeneration: acceptanceCut?.generation ?? null,
        receiptShowGeneration:
          (receipt.projection as { readonly cut?: { readonly generation?: number } }).cut?.generation ?? null,
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI writes stay accepted while a stale authored ref lock keeps Git publication pending", async (context) => {
  const fixture = setup(11),
    settledTaskId = "task-cli-git-settled",
    pendingTaskId = "task-cli-git-pending",
    recoveredTaskId = "task-cli-git-recovered",
    environment = actorEnvironment(fixture, 0, "agent:git-pending-worker");
  try {
    await startClient(fixture);
    const settled = await expectApplied(fixture, createArgs(settledTaskId, "CLI Git settled baseline"), environment);
    assert.equal(settled.status, "accepted_durable", JSON.stringify(settled));
    assert.equal(facetState(await published(fixture, settled, environment), "git"), "verified");
    // A real repository fault, not a test hook: a crashed Git process leaves the authored ref locked,
    // so the SQLite-to-Git follower cannot advance the branch while SQLite keeps accepting writes.
    const branch = git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD"),
      refLock = path.join(fixture.root, ".git", "refs", "heads", `${branch}.lock`);
    assert.ok(existsSync(path.join(fixture.root, ".git", "refs", "heads", branch)), branch);
    writeFileSync(refLock, "");
    const pending = await expectApplied(fixture, createArgs(pendingTaskId, "CLI Git pending acceptance"), environment),
      pendingPackageRoot = path.join(fixture.root, "harness", String(pending.packagePath));
    assert.equal(pending.status, "accepted_durable", JSON.stringify(pending));
    assert.equal(facetState(pending, "git"), "pending", JSON.stringify(pending));
    assert.equal(existsSync(path.join(pendingPackageRoot, "INDEX.md")), false, pendingPackageRoot);
    const shown = await runResult(
        fixture,
        ["receipt", "show", String(pending.opId), "--wait", "git_verified", "--timeout-ms", "0"],
        environment,
      ),
      shownReceipt = parseCliReceipt(shown, "receipt show");
    assert.equal(shownReceipt.status, "accepted_durable", shown.stdout);
    assert.equal(facetState(shownReceipt, "git"), "pending", shown.stdout);
    assert.deepEqual(shownReceipt.wait, { state: "timed_out", unsatisfied: ["git_verified"] }, shown.stdout);
    const pendingShow = await expectApplied(fixture, ["task", "show", pendingTaskId], environment),
      pendingTask = JSON.parse(String(pendingShow.evidence)) as { readonly task?: { readonly status?: string } };
    assert.equal(typeof pendingTask.task?.status, "string", pendingShow.evidence as string);
    const failure = await waitForMaterializationFailure(fixture),
      diagnostic = failure.receipt.diagnostic as { readonly reason?: string; readonly lastError?: string } | undefined;
    assert.equal(failure.status, 1, failure.stdout);
    assert.equal(diagnostic?.reason, "deterministic_failure", failure.stdout);
    assert.match(String(diagnostic?.lastError ?? ""), /lock/iu, failure.stdout);
    assert.match(String(failure.receipt.nextAction ?? ""), /SQLite-to-Git publication failed/u, failure.stdout);
    // Recovery is the operator's own repository repair; the follower republishes on the next accepted write.
    rmSync(refLock);
    const recovered = await expectApplied(
      fixture,
      createArgs(recoveredTaskId, "CLI Git follower recovered"),
      environment,
    );
    assert.equal(facetState(await published(fixture, recovered, environment), "git"), "verified");
    const resettled = await expectApplied(
      fixture,
      [
        "receipt",
        "show",
        String(pending.opId),
        "--wait",
        "accepted_durable,projection_visible,git_verified,worktree_visible",
        "--timeout-ms",
        "5000",
      ],
      environment,
    );
    assert.deepEqual(resettled.wait, { state: "satisfied", unsatisfied: [] }, JSON.stringify(resettled));
    assert.equal(facetState(resettled, "git"), "verified", JSON.stringify(resettled));
    const packageIndex = packagePathFor(`harness/${String(pending.packagePath)}`, "INDEX.md");
    assert.ok(existsSync(path.join(pendingPackageRoot, "INDEX.md")), pendingPackageRoot);
    assert.equal(git(fixture.root, "ls-tree", "--name-only", "HEAD", packageIndex), packageIndex);
    const healthy = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    assert.equal(healthy.status, 0, healthy.stdout);
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-git-pending/v1",
        fault: "stale-authored-ref-lock",
        pendingOpId: String(pending.opId),
        pendingTaskId,
        recoveredTaskId,
        pendingShowExit: shown.status,
        materializationReason: diagnostic?.reason ?? null,
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("a locally edited task plan blocks a CLI retitle until doc sync submits the drift", async (context) => {
  const fixture = setup(12),
    taskId = "task-cli-doc-conflict",
    title = "CLI doc conflict recovery",
    renamed = "CLI doc conflict recovery renamed",
    environment = actorEnvironment(fixture, 0, "agent:doc-conflict-worker");
  try {
    await startClient(fixture);
    const created = await expectApplied(fixture, createArgs(taskId, title), environment),
      packagePath = String(created.packagePath),
      packageRoot = path.join(fixture.root, "harness", packagePath),
      planPath = path.join(packageRoot, "task_plan.md"),
      planLogical = packagePathFor(packagePath, "task_plan.md");
    await published(fixture, created, environment);
    writeFileSync(planPath, realizedTaskPlan(title));
    await published(
      fixture,
      await expectApplied(fixture, ["doc", "sync", "--submit", "--path", planLogical], environment),
      environment,
    );
    // Unsubmitted local worker prose: the authored copy now diverges from the published cut.
    const drift = "## Drift\n\nUnsubmitted worker prose written before the center retitles the plan.\n",
      driftedBody = `${readFileSync(planPath, "utf8")}\n${drift}`;
    writeFileSync(planPath, driftedBody);
    const eligible = await expectApplied(fixture, ["doc", "status", "--path", planLogical], environment);
    assert.equal(docScanRows(eligible.evidence)[0]?.state, "eligible", String(eligible.evidence));
    // The center must not retitle over unsubmitted prose: the amend is refused with the sync route,
    // the dirty plan keeps its exact bytes, and nothing moves into a hidden conflict scratch.
    const refused = await runResult(fixture, ["task", "amend", taskId, "--set", `title:${renamed}`], environment),
      refusedReceipt = parseCliReceipt(refused, "task amend");
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.equal(refusedReceipt.outcome, "op_rejected", refused.stdout);
    assert.equal(refusedReceipt.code, "plan_local_modified", refused.stdout);
    assert.match(String(refusedReceipt.rejectionExplanation ?? ""), /ha doc sync --submit/u, refused.stdout);
    assert.equal(readFileSync(planPath, "utf8"), driftedBody);
    assert.equal(existsSync(path.join(fixture.root, ".harness", "conflicts", "doc-sync")), false);
    // The shorter recovery: submit the drift first, then the same retitle applies over the published body.
    await published(
      fixture,
      await expectApplied(fixture, ["doc", "sync", "--submit", "--path", planLogical], environment),
      environment,
    );
    const amended = await expectApplied(fixture, ["task", "amend", taskId, "--set", `title:${renamed}`], environment);
    await published(fixture, amended, environment);
    // The end state matches the journey this guard replaced: canonical holds the new title and the drift.
    const onDisk = readFileSync(planPath, "utf8");
    assert.match(onDisk, new RegExp(`^# ${renamed}$`, "mu"));
    assert.match(onDisk, /Unsubmitted worker prose/u);
    const canonical = await expectApplied(fixture, ["doc", "show", "--path", planLogical], environment),
      canonicalBody = String(canonical.evidence ?? "");
    assert.match(canonicalBody, new RegExp(`# ${renamed}`, "u"), canonicalBody.slice(0, 400));
    assert.match(canonicalBody, /Unsubmitted worker prose/u, canonicalBody.slice(0, 400));
    const healed = await expectApplied(fixture, ["doc", "status", "--path", planLogical], environment);
    assert.equal(docScanRows(healed.evidence)[0]?.state, "clean", String(healed.evidence));
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-plan-local-modified/v1",
        taskId,
        refusedExit: refused.status,
        refusedCode: String(refusedReceipt.code ?? ""),
        recoveredVia: "doc sync submit then amend",
        amendOpId: String(amended.opId ?? ""),
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});
