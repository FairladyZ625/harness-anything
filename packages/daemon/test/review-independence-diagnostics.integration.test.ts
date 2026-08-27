// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const git = (rootDir: string, ...args: readonly string[]): string =>
  execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

// #1541 was filed as "execution review is structurally unreachable on Windows" because one sentence
// covered every refusal. The transport principal is shared on that platform, but independence is
// decided on the executor axis, so the loop does close; the message just never said which axis failed
// or what to do. Each branch below pins one cause to one repair.
test("#1541: each Execution Review refusal names its own cause and its own repair", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-independence-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("review-independence"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
    });
    // One shared principal, exactly as a single Windows host mints it: every local identity is uid 0.
    const collapsed = { personId: "0" } as const;
    const agentActor = { principal: collapsed, executor: { kind: "agent" as const, id: "windows-tester" } };
    const humanActor = { principal: collapsed, executor: null };
    const agent = withRoleBinding({ actor: agentActor, source: "local" as const }, "arbiter");
    const human = withRoleBinding({ actor: humanActor, source: "local" as const }, "arbiter");
    const taskId = "task-review-axis",
      executionId = "exec-1";
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Review axis" }, agent)).outcome, "applied");
    // The packet parses before authorization runs, so the file must exist for the refusal to be the one under test.
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"] }),
    );

    const beforeSubmission = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r0", fromFile: "review.json" },
      human,
    );
    assert.equal(beforeSubmission.outcome, "op_rejected");
    assert.match(String(beforeSubmission.nextAction), /requires a submitted execution/u);

    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, agent)).outcome, "applied");
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Ready.",
        deliverables: ["d"],
        outputs: ["o"],
        verificationNotes: ["v"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, agent)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"] }),
    );

    // Missing the arbiter RoleBinding is a role problem, not an independence problem.
    const withoutRole = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r1", fromFile: "review.json" },
      { ...human, roleBindings: [] },
    );
    assert.equal(withoutRole.code, "actor_unauthorized");
    assert.match(String(withoutRole.nextAction), /arbiter RoleBinding/u);

    // The submitting executor reviewing itself is the one genuinely dependent case.
    const selfReview = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r2", fromFile: "review.json" },
      agent,
    );
    assert.equal(selfReview.code, "actor_unauthorized");
    assert.match(String(selfReview.nextAction), /independent of the submitting executor/u);
    assert.doesNotMatch(String(selfReview.nextAction), /declared no executor/u);

    // The repair the issue could not find: a bare human invocation reviews an agent-declared submission
    // on the very same principal. This is the assertion that falsifies "unreachable on Windows".
    const reviewed = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r3", fromFile: "review.json" },
      human,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The complementary half: when the execution declared no executor, the same principal genuinely cannot
// review it until an agent executor accepts that attribution through its own audited lifecycle event.
test("a bare-invocation execution has a visible warning and an audited recovery path", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-bare-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("review-bare"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
    });
    const bare = withRoleBinding(
      {
        actor: { principal: { personId: "0" }, executor: null },
        source: "local" as const,
      },
      "arbiter",
    );
    const taskId = "task-bare-axis",
      executionId = "exec-bare";
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Bare axis" }, bare)).outcome, "applied");
    const started = (await cell.run({ kind: "task-start", taskId, executionId }, bare)) as Record<string, unknown>;
    assert.equal(started.outcome, "applied");
    assert.match(String(started.summary), /declared no executor/u);
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    assert.equal(
      (await cell.run({ kind: "task-release", taskId, reason: "Rejoin as the agent that completed the work." }, bare))
        .outcome,
      "applied",
    );
    const agent = withRoleBinding(
      {
        actor: { principal: { personId: "0" }, executor: { kind: "agent" as const, id: "recovering-agent" } },
        source: "local" as const,
      },
      "arbiter",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, agent)).outcome, "applied");
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Ready.",
        deliverables: ["d"],
        outputs: ["o"],
        verificationNotes: ["v"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, agent)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed.", evidenceChecked: ["tests"] }),
    );

    const refused = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r1", fromFile: "review.json" },
      bare,
    );
    assert.equal(refused.code, "actor_unauthorized");
    assert.match(String(refused.nextAction), /declared no executor/u);
    assert.match(String(refused.nextAction), /original start/u);

    const wrongPrincipal = withRoleBinding(
      {
        actor: { principal: { personId: "1" }, executor: { kind: "agent" as const, id: "recovering-agent" } },
        source: "local" as const,
      },
      "arbiter",
    );
    const denied = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, reason: "Claim from another principal." },
      wrongPrincipal,
    );
    assert.equal(denied.code, "invalid_proof");

    const declared = (await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        reason: "Recovered the executor omitted by the original start invocation.",
      },
      agent,
    )) as Record<string, unknown>;
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    const event = makeTaskEventStore({ repoId: "review-bare", rootDir }).readEvent(String(declared.opId));
    assert.equal(event?.type, "execution_executor_declared");
    if (event?.type === "execution_executor_declared") {
      assert.deepEqual(event.payload.previousActor, bare.actor);
      assert.deepEqual(event.payload.execution.actor, agent.actor);
      assert.equal(event.payload.reason, "Recovered the executor omitted by the original start invocation.");
    }

    const selfReview = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r2", fromFile: "review.json" },
      agent,
    );
    assert.equal(selfReview.code, "actor_unauthorized");
    assert.match(String(selfReview.nextAction), /independent of the submitting executor/u);

    const reviewed = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r3", fromFile: "review.json" },
      bare,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const wrongOwner = {
      actor: { principal: { personId: "person-outsider" }, executor: { kind: "agent" as const, id: "outsider" } },
      source: "local" as const,
    };
    const consent = await cell.run(
      { kind: "task-review-consent", taskId, executionId, reviewId: "r3", consentId: "consent-wrong-owner" },
      wrongOwner,
    );
    assert.equal(consent.code, "actor_unauthorized");
    assert.match(String(consent.nextAction), /personId=0/u);
    assert.doesNotMatch(String(consent.nextAction), /executor=/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a reviewed bare-invocation execution can declare its executor and complete after cold replay", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-bare-reviewed-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const repoId = workspaceId("review-bare-reviewed"),
    taskId = "task-bare-reviewed",
    executionId = "exec-bare-reviewed",
    bare = withRoleBinding(
      {
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local" as const,
      },
      "arbiter",
    ),
    agent = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-owner" },
          executor: { kind: "agent" as const, id: "recovering-agent" },
        },
        source: "local" as const,
      },
      "arbiter",
    ),
    wrongPrincipal = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-outsider" },
          executor: { kind: "agent" as const, id: "recovering-agent" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
  try {
    initRepo(rootDir);
    writeFileSync(path.join(rootDir, "README.md"), "# Reviewed executor repair fixture\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "--quiet", "-m", "fixture output");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "review-bare-reviewed" });
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Bare reviewed" }, bare)).outcome, "applied");
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The reviewed executor repair fixture was observed.",
            evidenceSource: "daemon integration",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
          },
          bare,
        )
      ).outcome,
      "applied",
    );
    const packagePath = "tasks/task-bare-reviewed-bare-reviewed",
      closeoutPath = path.join(rootDir, "harness", packagePath, "closeout.md"),
      commitSha = git(rootDir, "rev-parse", "HEAD"),
      submission = {
        completionClaim: "The reviewed executor repair fixture is complete.",
        deliverables: ["reviewed executor repair"],
        outputs: ["README.md"],
        verificationNotes: ["daemon integration"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      };
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\nReviewed executor repair.\n\n## Verification\n\nDaemon integration.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nCovered by the declaration audit.\n",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, bare)).outcome, "applied");
    writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify(submission));
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, bare)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent review passed.",
        evidenceChecked: ["daemon integration"],
      }),
    );
    const reviewer = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-reviewer" },
          executor: { kind: "agent" as const, id: "reviewer-agent" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-review-execution", taskId, executionId, reviewId: "review-approved", fromFile: "review.json" },
          reviewer,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId, status: "blocked", reason: "Executor attribution must be repaired." },
          bare,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "judgment.json"),
      JSON.stringify({
        submission,
        review: { verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["daemon integration"] },
        consent: { approved: true },
        completion: { ci: "passed", codeDocPaths: ["README.md"] },
      }),
    );

    const negativeControl = {
      complete: await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, agent),
      consent: await cell.run(
        {
          kind: "task-review-consent",
          taskId,
          executionId,
          reviewId: "review-approved",
          consentId: "consent-approved",
        },
        bare,
      ),
      closeout: await cell.run({ kind: "task-closeout", taskId, executionId, fromFile: "judgment.json" }, agent),
      start: await cell.run({ kind: "task-start", taskId, executionId }, agent),
      declareWrongPrincipal: await cell.run(
        { kind: "task-declare-executor", taskId, executionId, reason: "An outsider must not claim this execution." },
        wrongPrincipal,
      ),
    };
    console.log(`executor-null-negative-control=${JSON.stringify(negativeControl)}`);
    assert.deepEqual(
      Object.values(negativeControl).map((receipt) => receipt.outcome),
      ["op_rejected", "op_rejected", "op_rejected", "op_rejected", "op_rejected"],
    );
    assert.equal(negativeControl.complete.code, "task_blocked");
    assert.match(String(negativeControl.complete.nextAction), /ha task transition task-bare-reviewed active/u);
    assert.match(String(negativeControl.closeout.nextAction), /ha task transition task-bare-reviewed active/u);
    assert.match(String(negativeControl.closeout.nextAction), /ha task declare-executor task-bare-reviewed/u);

    const unblocked = await cell.run({ kind: "task-transition", taskId, status: "active" }, bare);
    assert.equal(unblocked.outcome, "applied", JSON.stringify(unblocked));
    const completeRepair = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, agent),
      closeoutRepair = await cell.run({ kind: "task-closeout", taskId, executionId, fromFile: "judgment.json" }, agent);
    assert.equal(completeRepair.code, "executor_missing", JSON.stringify(completeRepair));
    assert.match(String(completeRepair.nextAction), /ha task declare-executor task-bare-reviewed/u);
    assert.equal(closeoutRepair.code, "executor_missing", JSON.stringify(closeoutRepair));
    assert.match(String(closeoutRepair.nextAction), /ha task declare-executor task-bare-reviewed/u);
    const denied = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, reason: "An outsider must not claim this execution." },
      wrongPrincipal,
    );
    assert.equal(denied.code, "invalid_proof", JSON.stringify(denied));

    const declared = (await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId,
        reason: "The original principal names the agent that completed the already approved execution.",
      },
      agent,
    )) as Record<string, unknown>;
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    const declaration = makeTaskEventStore({ repoId, rootDir }).readEvent(String(declared.opId));
    assert.equal(declaration?.type, "execution_executor_declared");
    if (declaration?.type === "execution_executor_declared") {
      assert.deepEqual(declaration.payload.previousActor, bare.actor);
      assert.deepEqual(declaration.payload.execution.actor, agent.actor);
      assert.equal(declaration.payload.task.status, "in_review");
      assert.equal(declaration.payload.task.currentNode, "review");
    }

    await cell.close();
    cell = undefined;
    const projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventStore({ repoId, rootDir }) });
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.equal(projection.read(taskId).snapshot.task?.status, "in_review");
    assert.deepEqual(
      projection.read(taskId).snapshot.executions.find((execution) => execution.executionId === executionId)?.actor,
      agent.actor,
    );
    projection.close();

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "review-bare-reviewed-reopened" });
    const consented = await cell.run(
      { kind: "task-review-consent", taskId, executionId, reviewId: "review-approved", consentId: "consent-approved" },
      bare,
    );
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const completed = (await cell.run(
      { kind: "task-complete", taskId, executionId, ci: "passed", paths: ["README.md"] },
      bare,
    )) as Record<string, unknown>;
    console.log(
      `executor-null-positive-control=${JSON.stringify({ completeRepair, closeoutRepair, denied, declared, consented, completed })}`,
    );
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const shown = await cell.run({ kind: "task-show", taskId }, bare);
    assert.match(String(shown.evidence), /"status":"done"/u);
    assert.equal(
      makeTaskEventStore({ repoId, rootDir })
        .read()
        .events.some(
          (event) => event.type === "review_recorded" && event.payload.review.verdict === "changes_requested",
        ),
      false,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task-bound runtime sessions cannot review their own execution across exit and resume", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-runtime-bound-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    const processes: { exit: ((code: number | null) => void) | null }[] = [];
    let providerSequence = 0;
    cell = await openRepoCell({
      repoId: workspaceId("review-runtime-bound"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
      runtimeDaemonRoute: { userRoot: rootDir, daemonId: "daemon-test", endpoint: path.join(rootDir, "daemon.sock") },
      prepareRuntimeLaunch: (_instanceId, request) => {
        const providerSessionId = request.providerSessionId ?? `provider-${++providerSequence}`;
        return {
          definition: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "review-runtime",
            installationId: "review-runtime-installation",
            kindId: "codex",
            providerId: "openai",
            model: "review-model",
            reasoningEffort: "medium",
            baseUrl: null,
            authMode: "subscription",
          },
          installation: {
            installationId: "review-runtime-installation",
            kindId: "codex",
            executablePath: "/test/review-runtime",
            version: "1.0.0",
            observedAt: "2026-08-22T00:00:00.000Z",
          },
          executablePath: "/test/review-runtime",
          args: [providerSessionId],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: (prepared) => {
        const process = { exit: null as ((code: number | null) => void) | null },
          providerSessionId = prepared.args[0]!;
        processes.push(process);
        return {
          pid: 1_001 + processes.length,
          onOutput: (listener) => {
            queueMicrotask(() =>
              listener(`${JSON.stringify({ type: "thread.started", thread_id: providerSessionId })}\n`),
            );
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            process.exit = listener;
          },
          terminate: () => process.exit?.(0),
        };
      },
    });
    const principal = { personId: "person-worker" } as const,
      implementer = {
        actor: { principal, executor: { kind: "agent" as const, id: "implementer" } },
        source: "local" as const,
      },
      arbiter = (id: string) =>
        withRoleBinding(
          {
            actor: { principal, executor: { kind: "agent" as const, id } },
            source: "local" as const,
          },
          "arbiter",
        );
    const taskId = "task-runtime-bound",
      executionId = "execution-runtime-bound";
    assert.equal(
      (await cell.run({ kind: "task-create", taskId, title: "Runtime-bound review" }, implementer)).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, implementer)).outcome, "applied");

    const original = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        prompt: "Implement the task.",
        taskId,
        idempotencyKey: "original-runtime",
      },
      implementer,
    );
    await runtimeEvent(
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === original.runtimeSessionId,
    );
    processes[0]!.exit?.(0);
    await runtimeEvent(
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_exited" && event.payload.runtimeSessionId === original.runtimeSessionId,
    );

    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, implementer)).outcome, "applied");
    const resumed = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        prompt: "Resume the task.",
        taskId,
        providerSessionId: "provider-1",
        idempotencyKey: "resumed-runtime",
      },
      implementer,
    );
    await runtimeEvent(
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === resumed.runtimeSessionId,
    );

    const commitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Ready.",
        deliverables: ["d"],
        outputs: ["o"],
        verificationNotes: ["v"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, implementer)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed.", evidenceChecked: ["tests"] }),
    );

    // A dedicated reviewer runtime has no binding to this task/execution, so it can execute the
    // refusal's named command without changing either identity or review packet.
    const unbound = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        prompt: "Review only.",
        taskId: null,
        idempotencyKey: "unbound-reviewer",
      },
      implementer,
    );
    await runtimeEvent(
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_provider_bound" && event.payload.runtimeSessionId === unbound.runtimeSessionId,
    );
    for (const [reviewId, runtimeSessionId] of [
      ["review-exited", original.runtimeSessionId],
      ["review-resumed", resumed.runtimeSessionId],
    ] as const) {
      const denied = await cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" },
        arbiter(`runtime-session:${runtimeSessionId}`),
      );
      assert.equal(denied.code, "runtime_task_self_review_forbidden");
      assert.equal(
        denied.nextAction,
        `This runtime is bound to task ${taskId} and execution ${executionId} and cannot review its own work; have an independent human or a runtime with no binding to this task and execution run ha task review-execution ${taskId} --execution-id ${executionId} --review-id ${reviewId} --from-file <review.json>.`,
      );
      assert.equal(
        (
          await cell.run(
            { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" },
            arbiter(`runtime-session:${unbound.runtimeSessionId}`),
          )
        ).outcome,
        "applied",
      );
    }

    const directTaskId = "task-direct-review",
      directExecutionId = "execution-direct-review";
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: directTaskId, title: "Direct review" }, implementer)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: directTaskId, executionId: directExecutionId }, implementer))
        .outcome,
      "applied",
    );
    const directCommitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Ready.",
        deliverables: ["d"],
        outputs: ["o"],
        verificationNotes: ["v"],
        knownGaps: [],
        residualRisks: [],
        commitSha: directCommitSha,
      }),
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-submit", taskId: directTaskId, executionId: directExecutionId, fromFile: "submission.json" },
          implementer,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed by another agent.", evidenceChecked: ["tests"] }),
    );
    // A child/non-runtime agent has no runtime-session identity; existing executor independence decides it.
    const reviewedByAgent = await cell.run(
      {
        kind: "task-review-execution",
        taskId: directTaskId,
        executionId: directExecutionId,
        reviewId: "review-child-agent",
        fromFile: "review.json",
      },
      arbiter("child-reviewer"),
    );
    assert.equal(reviewedByAgent.outcome, "applied", JSON.stringify(reviewedByAgent));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function runtimeEvent(
  rootDir: string,
  repoId: string,
  matches: (event: ReturnType<ReturnType<typeof makeTaskEventStore>["read"]>["events"][number]) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (makeTaskEventStore({ repoId, rootDir }).read().events.some(matches)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime event did not arrive");
}
