// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  clientCount = 8,
  chainsPerClient = 3;

type Fixture = {
  readonly parent: string;
  readonly root: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly repoId: string;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

test("eight isolated CLI clients complete 24 lifecycle chains", async (context) => {
  const fixtures = Array.from({ length: clientCount }, (_, index) => setup(index));
  const startedAt = Date.now();
  try {
    for (const fixture of fixtures) await startClient(fixture);
    const outcomes = await Promise.all(fixtures.map((fixture, index) => runClient(fixture, index)));
    const chains = outcomes.flat();
    assert.equal(chains.length, clientCount * chainsPerClient);
    assert.equal(chains.filter((chain) => chain.status === "done").length, chains.length);
    assert.equal(new Set(chains.map((chain) => chain.taskId)).size, chains.length);
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-stress/v1",
        clients: clientCount,
        chains: chains.length,
        actors: outcomes.map(({ actor }) => actor),
        elapsedMs: Date.now() - startedAt,
        chainElapsedMs: chains.map(({ elapsedMs }) => elapsedMs),
      }),
    );
  } finally {
    for (const fixture of fixtures) {
      await stopClient(fixture);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("eight CLI clients share one center while closeout facade completes each task", async (context) => {
  const fixture = setup(8),
    startedAt = Date.now();
  try {
    await startClient(fixture);
    const outcomes = await Promise.all(
      Array.from({ length: clientCount }, (_, clientIndex) =>
        runChain(fixture, clientIndex, 0, actorLabel(clientIndex), true),
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
    const firstSubmission = {
      completionClaim: "First execution needs another iteration.",
      deliverables: [packagePathFor(packagePath, "closeout.md")],
      outputs: ["synthetic recovery receipt"],
      verificationNotes: ["changes_requested recovery"],
      knownGaps: ["review requested another iteration"],
      residualRisks: [],
      commitSha: git(fixture.root, "rev-parse", "HEAD"),
    };
    const firstSubmissionPath = path.join(fixture.root, "recovery-first-submission.json");
    writeFileSync(firstSubmissionPath, JSON.stringify(firstSubmission));
    await expectApplied(
      fixture,
      ["task", "submit", taskId, "--execution-id", firstExecutionId, "--from-file", path.basename(firstSubmissionPath)],
      workerEnvironment,
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
    const afterRequest = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
      afterRequestEvidence = JSON.parse(String(afterRequest.evidence)) as {
        readonly task?: { readonly status?: string; readonly iteration?: number };
      };
    assert.equal(afterRequestEvidence.task?.status, "active");
    assert.equal(afterRequestEvidence.task?.iteration, 1);
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    const secondSubmission = {
      ...firstSubmission,
      completionClaim: "Second execution addresses the requested verification note.",
      knownGaps: [],
      commitSha: git(fixture.root, "rev-parse", "HEAD"),
    };
    const secondSubmissionPath = path.join(fixture.root, "recovery-second-submission.json");
    writeFileSync(secondSubmissionPath, JSON.stringify(secondSubmission));
    await expectApplied(
      fixture,
      [
        "task",
        "submit",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--from-file",
        path.basename(secondSubmissionPath),
      ],
      workerEnvironment,
    );
    const review = await expectApplied(
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
    const reviewDigest = String(review.reviewDigest ?? ""),
      contentDigest = String(review.contentDigest ?? "");
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
        "--consent-id",
        "consent-cli-recovery-approved",
        "--json-input",
        JSON.stringify({ reviewDigest, contentDigest }),
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
    context.diagnostic(JSON.stringify({ schema: "cli-lifecycle-restart-recovery/v1", taskId, opId, executionId }));
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
    assert.equal(facetState(settled, "git"), "verified", JSON.stringify(settled));
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
    assert.equal(waitState(pending), "timed_out", JSON.stringify(pending));
    assert.equal(existsSync(path.join(pendingPackageRoot, "INDEX.md")), false, pendingPackageRoot);
    const shown = await runResult(
        fixture,
        ["receipt", "show", String(pending.opId), "--wait", "git_verified", "--timeout-ms", "0"],
        environment,
      ),
      shownReceipt = JSON.parse(shown.stdout) as Record<string, unknown>;
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
    assert.equal(facetState(recovered, "git"), "verified", JSON.stringify(recovered));
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

test("a locally edited task plan becomes a CLI doc conflict that the conflict command recovers", async (context) => {
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
    writeFileSync(planPath, realizedTaskPlan(title));
    await expectApplied(fixture, ["doc", "sync", "--submit", "--path", planLogical], environment);
    // Unsubmitted local worker prose: the authored copy now diverges from the published cut.
    const drift = "## Drift\n\nUnsubmitted worker prose written before the center retitled the plan.\n",
      driftedBody = `${readFileSync(planPath, "utf8")}\n${drift}`;
    writeFileSync(planPath, driftedBody);
    const eligible = await expectApplied(fixture, ["doc", "status", "--path", planLogical], environment);
    assert.equal(docScanRows(eligible.evidence)[0]?.state, "eligible", String(eligible.evidence));
    // The center rewrites the same authored document while the local copy is dirty.
    const amended = await expectApplied(fixture, ["task", "amend", taskId, "--set", `title:${renamed}`], environment);
    assert.equal(amended.status, "accepted_durable", JSON.stringify(amended));
    const scratches = readdirSync(packageRoot).filter((name) => /^task_plan\.conflict-[0-9a-f]{8}\.md$/u.test(name));
    assert.equal(
      scratches.length,
      1,
      `expected one conflict scratch, found ${JSON.stringify(readdirSync(packageRoot))}`,
    );
    const conflictId = /^task_plan\.conflict-([0-9a-f]{8})\.md$/u.exec(scratches[0]!)![1]!,
      scratchPath = path.join(packageRoot, scratches[0]!);
    assert.equal(readFileSync(scratchPath, "utf8"), driftedBody);
    assert.match(readFileSync(planPath, "utf8"), new RegExp(`^# ${renamed}$`, "mu"));
    const conflicted = await expectApplied(fixture, ["doc", "status", "--path", planLogical], environment);
    assert.equal(docScanRows(conflicted.evidence)[0]?.state, "conflict", String(conflicted.evidence));
    // An explicit --path submit of the conflicted document is rejected with a recovery route.
    const blockedSync = await runResult(fixture, ["doc", "sync", "--submit", "--path", planLogical], environment),
      blockedReceipt = JSON.parse(blockedSync.stdout) as Record<string, unknown>,
      unresolved =
        (
          blockedReceipt.detail as
            | { readonly unresolvedTouches?: readonly { readonly reason?: string; readonly requiredRoute?: string }[] }
            | undefined
        )?.unresolvedTouches ?? [];
    assert.notEqual(blockedSync.status, 0, blockedSync.stdout);
    assert.equal(blockedReceipt.outcome, "op_rejected", blockedSync.stdout);
    assert.match(String(blockedReceipt.nextActions ?? ""), /ha doc conflict resolve [0-9a-f]{8}/u, blockedSync.stdout);
    assert.equal(unresolved.length, 1, blockedSync.stdout);
    assert.equal(unresolved[0]?.requiredRoute, "local-conflict-resolution", blockedSync.stdout);
    assert.match(unresolved[0]?.reason ?? "", /local conflict scratch requires resolution/u, blockedSync.stdout);
    assert.match(String(blockedReceipt.summary ?? ""), /\tconflict\t/u, blockedSync.stdout);
    // Recovery: merge the preserved prose onto the retitled base, then close the conflict by hand.
    writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\n${drift}`);
    const resolved = await expectApplied(fixture, ["doc", "conflict", "resolve", conflictId], environment);
    assert.equal(existsSync(scratchPath), false, scratchPath);
    const healed = await expectApplied(fixture, ["doc", "status", "--path", planLogical], environment);
    assert.equal(docScanRows(healed.evidence)[0]?.state, "clean", String(healed.evidence));
    const canonical = await expectApplied(fixture, ["doc", "show", "--path", planLogical], environment),
      canonicalBody = String(canonical.evidence ?? "");
    assert.match(canonicalBody, new RegExp(`# ${renamed}`, "u"), canonicalBody.slice(0, 400));
    assert.match(canonicalBody, /Unsubmitted worker prose/u, canonicalBody.slice(0, 400));
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-doc-conflict/v1",
        taskId,
        conflictId,
        resolvedVia: "doc conflict resolve",
        resolveOpId: String(resolved.opId ?? ""),
        blockedSyncExit: blockedSync.status,
        blockedSyncOutcome: String(blockedReceipt.outcome ?? ""),
        blockedSyncStatus: String(blockedReceipt.status ?? ""),
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

async function runClient(fixture: Fixture, clientIndex: number): Promise<ChainOutcome[] & { actor: string }> {
  const actor = actorLabel(clientIndex),
    outcomes: ChainOutcome[] = [];
  for (let chainIndex = 0; chainIndex < chainsPerClient; chainIndex += 1)
    outcomes.push(await runChain(fixture, clientIndex, chainIndex, actor));
  return Object.assign(outcomes, { actor });
}

type ChainOutcome = {
  readonly taskId: string;
  readonly status: string;
  readonly elapsedMs: number;
};

async function runChain(
  fixture: Fixture,
  clientIndex: number,
  chainIndex: number,
  actor: string,
  facade = false,
): Promise<ChainOutcome> {
  const taskId = `task-cli-stress-${clientIndex}-${chainIndex}`,
    executionId = `execution-cli-stress-${clientIndex}-${chainIndex}`,
    standard = chainIndex === 2,
    preset = standard ? "standard-task" : "docs-task",
    workerEnvironment = actorEnvironment(fixture, clientIndex, actor),
    reviewerEnvironment = actorEnvironment(fixture, clientIndex, `agent:reviewer-${clientIndex}-${chainIndex}`),
    startedAt = Date.now();
  const created = await expectApplied(
      fixture,
      [
        "task",
        "create",
        "--id",
        taskId,
        "--title",
        `CLI stress ${clientIndex}-${chainIndex}`,
        "--preset",
        preset,
        "--vertical",
        "software/coding",
        "--kind",
        standard ? "test" : "docs",
        "--admin",
      ],
      workerEnvironment,
    ),
    packagePath = String(created.packagePath),
    packageRoot = path.join(fixture.root, "harness", packagePath),
    planPath = path.join(packageRoot, "task_plan.md"),
    closeoutPath = path.join(packageRoot, "closeout.md"),
    artifactPath = path.join(packageRoot, "artifacts", "chain.txt");
  writeFileSync(planPath, realizedTaskPlan(`CLI stress ${clientIndex}-${chainIndex}`));
  writeFileSync(artifactPath, `synthetic chain ${clientIndex}-${chainIndex}\n`);
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
      "A synthetic CLI lifecycle chain reached its execution lease.",
      "--source",
      `test:cli-lifecycle-stress/${taskId}`,
      "--confidence",
      "high",
    ],
    workerEnvironment,
  );
  await expectApplied(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  await expectNoop(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  const rejectedProgress = await runResult(
    fixture,
    ["task", "progress", "append", taskId, "--text", "unauthorized checkpoint"],
    reviewerEnvironment,
  );
  assert.notEqual(rejectedProgress.status, 0, rejectedProgress.stdout);
  assert.match(rejectedProgress.stdout, /progress_lease_required|actor_unauthorized|lease/u);
  await expectApplied(
    fixture,
    [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "checkpoint",
      "--evidence",
      `test:${packagePathFor(packagePath, "artifacts/chain.txt")}:synthetic chain evidence`,
    ],
    workerEnvironment,
  );
  writeFileSync(
    closeoutPath,
    "# Closeout\n\n## Summary\n\nSynthetic chain complete.\n\n" +
      "## Verification\n\nCLI stress path.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
  );
  await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
  const commitSha = git(fixture.root, "rev-parse", "HEAD"),
    submissionPath = path.join(fixture.root, `submission-${taskId}.json`),
    submission = {
      completionClaim: "Synthetic CLI lifecycle chain is complete.",
      deliverables: [packagePathFor(packagePath, "artifacts/chain.txt")],
      outputs: ["synthetic lifecycle receipt"],
      verificationNotes: ["task show reached done"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    };
  writeFileSync(submissionPath, JSON.stringify(submission));
  if (facade) {
    const closeoutPacketPath = path.join(fixture.root, `closeout-${taskId}.json`);
    writeFileSync(
      closeoutPacketPath,
      JSON.stringify({
        submission,
        review: {
          verdict: "approved",
          reason: "Independent synthetic reviewer checked the closeout packet.",
          evidenceChecked: [packagePathFor(packagePath, "artifacts/chain.txt")],
        },
        consent: { approved: true },
        completion: { ci: standard ? "passed" : "not_applicable", codeDocPaths: standard ? ["README.md"] : [] },
      }),
    );
    const closeout = await expectApplied(
      fixture,
      ["task", "closeout", taskId, "--execution-id", executionId, "--from-file", path.basename(closeoutPacketPath)],
      workerEnvironment,
    );
    assert.deepEqual(
      (closeout.steps as Array<Record<string, unknown>>).map(({ stage }) => stage),
      ["submit", "review-execution", "review-consent", "complete"],
    );
  } else {
    await expectApplied(
      fixture,
      ["task", "submit", taskId, "--from-file", path.basename(submissionPath)],
      workerEnvironment,
    );
  }
  const review = facade
    ? null
    : await expectApplied(
        fixture,
        [
          "task",
          "review-execution",
          taskId,
          "--execution-id",
          executionId,
          "--review-id",
          `review-${taskId}`,
          "--json-input",
          JSON.stringify({
            verdict: "approved",
            reason: "Independent synthetic reviewer checked the submitted execution.",
            evidenceChecked: [packagePathFor(packagePath, "artifacts/chain.txt")],
          }),
        ],
        reviewerEnvironment,
      );
  if (!facade && review) {
    const reviewDigest = String(review.reviewDigest ?? ""),
      contentDigest = String(review.contentDigest ?? "");
    assert.match(reviewDigest, /^sha256:/u, JSON.stringify(review));
    assert.match(contentDigest, /^sha256:/u, JSON.stringify(review));
    assert.equal(review.outcome, "applied");
    await expectApplied(
      fixture,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        `review-${taskId}`,
        "--consent-id",
        `consent-${taskId}`,
        "--json-input",
        JSON.stringify({
          reviewDigest,
          contentDigest,
        }),
      ],
      workerEnvironment,
    );
    if (standard) {
      await expectApplied(fixture, ["task", "code-doc", "reconcile", taskId, "--path", "README.md"], workerEnvironment);
      await expectApplied(
        fixture,
        ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed"],
        workerEnvironment,
      );
    } else await expectApplied(fixture, ["task", "complete", taskId, "--execution-id", executionId], workerEnvironment);
  }
  const final = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
    finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
  assert.equal(finalEvidence.task?.status, "done");
  return { taskId, status: finalEvidence.task?.status ?? "missing", elapsedMs: Date.now() - startedAt };
}

async function startClient(fixture: Fixture): Promise<void> {
  const started = await runResult(fixture, ["daemon", "start", "--service"], actorEnvironment(fixture, 0, null));
  if (started.status === 0) {
    await expectApplied(
      fixture,
      ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
      actorEnvironment(fixture, 0, null),
    );
    await waitForAttached(fixture);
    return;
  }
  assert.match(started.stdout, /daemon_starting/u, started.stderr);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    if (status.status === 0) {
      await expectApplied(
        fixture,
        ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
        actorEnvironment(fixture, 0, null),
      );
      await waitForAttached(fixture);
      return;
    }
    await delay(50);
  }
  throw new Error(`daemon did not become ready: ${started.stdout}`);
}

async function waitForAttached(fixture: Fixture): Promise<void> {
  let lastStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    lastStatus = status.stdout;
    const receipt = JSON.parse(status.stdout) as {
      readonly repos?: ReadonlyArray<{ readonly repoId?: string; readonly state?: string }>;
    };
    if (receipt.repos?.some((repo) => repo.repoId === fixture.repoId && repo.state === "attached")) return;
    await delay(50);
  }
  throw new Error(`repository ${fixture.repoId} did not attach: ${lastStatus}`);
}

async function stopClient(fixture: Fixture): Promise<void> {
  if (!existsSync(fixture.userRoot)) return;
  await runResult(fixture, ["daemon", "stop"], actorEnvironment(fixture, 0, null));
}

function setup(index: number): Fixture {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-cli-stress-${index}-`)),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = `cli-stress-${index}`,
    repoId = `cli-stress-repo-${index}`;
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# CLI lifecycle stress fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  const roster = [
    "schema: harness-people/v1",
    "people:",
    "  - personId: owner",
    "    displayName: Owner",
    "    primaryEmail: owner@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "",
  ].join("\n");
  writeFileSync(path.join(root, "harness/people.yaml"), roster);
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "CLI lifecycle stress");
  git(root, "config", "user.email", "cli-lifecycle-stress@example.test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ rootDir: root, repoId });
  return { parent, root, userRoot, daemonId, repoId };
}

function actorLabel(index: number): string {
  return index % 3 === 0 ? "codex-auto" : index % 3 === 1 ? "claude-auto" : "explicit-agent";
}

function actorEnvironment(fixture: Fixture, index: number, actor: string | null): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemon,
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _session,
    ...base
  } = process.env;
  const identity =
    actor === null
      ? {}
      : actor === "codex-auto"
        ? { CODEX_THREAD_ID: `codex-stress-${index}` }
        : actor === "claude-auto"
          ? { CLAUDE_CODE_SESSION_ID: `claude-stress-${index}` }
          : { HARNESS_ACTOR: actor.startsWith("agent:") ? actor : `agent:stress-${index}` };
  return {
    ...base,
    HOME: path.join(fixture.parent, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    HARNESS_DAEMON_ID: fixture.daemonId,
    ...identity,
  };
}

function packagePathFor(packagePath: string, relative: string): string {
  return path.posix.join(packagePath.replaceAll(path.sep, "/"), relative);
}

function createArgs(taskId: string, title: string): readonly string[] {
  return [
    "task",
    "create",
    "--id",
    taskId,
    "--title",
    title,
    "--preset",
    "docs-task",
    "--vertical",
    "software/coding",
    "--kind",
    "docs",
    "--admin",
  ];
}

function facetState(receipt: Record<string, unknown>, facet: "git" | "worktree" | "projection"): string | null {
  const value = receipt[facet];
  return value !== null && typeof value === "object" ? ((value as { readonly state?: string }).state ?? null) : null;
}

function waitState(receipt: Record<string, unknown>): string | null {
  const value = receipt.wait;
  return value !== null && typeof value === "object" ? ((value as { readonly state?: string }).state ?? null) : null;
}

function docScanRows(evidence: unknown): readonly { readonly path: string; readonly state: string }[] {
  const text = String(evidence ?? "");
  assert.match(text, /^doc-scan:/u);
  return (
    JSON.parse(text.slice("doc-scan:".length)) as {
      readonly rows: readonly { readonly path: string; readonly state: string }[];
    }
  ).rows;
}

async function waitForMaterializationFailure(
  fixture: Fixture,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly receipt: Record<string, unknown> }> {
  let last = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    last = result.stdout;
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    if (receipt.code === "materialization_failed") return { status: result.status, stdout: result.stdout, receipt };
    await delay(50);
  }
  throw new Error(`daemon status never reported a failed materialization: ${last}`);
}

async function expectApplied(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "applied", result.stdout);
  return receipt;
}

async function expectNoop(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "no_changes", result.stdout);
  return receipt;
}

function runResult(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
      cwd: fixture.root,
      env: environment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (input !== undefined) child.stdin.end(input);
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
