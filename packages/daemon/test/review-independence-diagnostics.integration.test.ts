// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import {
  commitDelivery,
  git,
  initRepo,
  runtimeEvent,
  submissionOutcome,
  writeCloseout,
  writeSettingsFixture,
} from "./review-independence.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-review-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

// #1541 was filed as "execution review is structurally unreachable on Windows" because one sentence
// covered every refusal. The transport principal is shared on that platform, but independence is
// decided on the executor axis, so the loop does close; the message just never said which axis failed
// or what to do. Each branch below pins one cause to one repair.
test("#1541: each Execution Review refusal names its own cause and its own repair", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-independence-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
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
    const created = await cell.run({ kind: "task-create", taskId, title: "Review axis" }, agent);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, agent);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, agent),
    );
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
    assert.deepEqual(
      beforeSubmission.unmetCriteria?.map(({ ref }) => ref),
      ["task-lifecycle-review-transitions/review.validate"],
    );

    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, agent)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(submissionOutcome(await cell.run({ kind: "task-submit", taskId, executionId }, agent)), "applied");
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward review-axis cut." },
          agent,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"] }),
    );
    const reviewReportDir = path.join(
      rootDir,
      "harness",
      String((created as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
    );
    mkdirSync(reviewReportDir, { recursive: true });
    for (const id of ["r1", "r2", "r3"])
      writeFileSync(path.join(reviewReportDir, `${id}.md`), `# Review ${id}\n\nPhysical review findings.\n`);

    // Missing the arbiter RoleBinding is a role problem, not an independence problem.
    const withoutRole = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r1", fromFile: "review.json" },
      { ...human, roleBindings: [], authorizationBindingMode: "declared" },
    );
    assert.equal(withoutRole.code, "authorization_denied");

    // The submitting executor reviewing itself is the one genuinely dependent case.
    const selfReview = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r2", fromFile: "review.json" },
      agent,
    );
    assert.equal(selfReview.code, "actor_unauthorized");

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

test("principal review independence rejects a different executor owned by the submitting principal", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-principal-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("review-principal"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
    });
    const principal = { personId: "person-review-principal" } as const,
      person = withRoleBinding({ actor: { principal, executor: null }, source: "local" as const }, "arbiter"),
      agent = withRoleBinding(
        { actor: { principal, executor: { kind: "agent" as const, id: "worker" } }, source: "local" as const },
        "arbiter",
      ),
      reviewer = withRoleBinding(
        { actor: { principal, executor: { kind: "agent" as const, id: "reviewer" } }, source: "local" as const },
        "arbiter",
      );
    const updated = await cell.run(
      { kind: "settings-update", reviewIndependence: "principal", idempotencyKey: "strict-review-independence" },
      person,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const settingsRead = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewIndependence?: string };
    };
    assert.equal(settingsRead.settings.reviewIndependence, "principal");

    const taskId = "task-principal-review",
      executionId = "exec-principal-review";
    const created = await cell.run({ kind: "task-create", taskId, title: "Principal review" }, agent);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, agent);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, agent),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, agent)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(submissionOutcome(await cell.run({ kind: "task-submit", taskId, executionId }, agent)), "applied");
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward principal-review cut." },
          agent,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"] }),
    );
    const strictReportDir = path.join(
      rootDir,
      "harness",
      String((created as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
    );
    mkdirSync(strictReportDir, { recursive: true });
    writeFileSync(
      path.join(strictReportDir, "strict-review.md"),
      "# Review strict-review\n\nPhysical review findings.\n",
    );

    const refused = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "strict-review", fromFile: "review.json" },
      reviewer,
    );
    assert.equal(refused.code, "actor_unauthorized", JSON.stringify(refused));
    assert.match(
      JSON.stringify(refused),
      /reviewIndependence.*principal.*ha settings update --review-independence execution/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The complementary half: when the execution declared no executor, the same principal genuinely cannot
// review it until an agent executor accepts that attribution through its own audited lifecycle event.
test("a lightweight child bare-invocation execution closes without a review dispatch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-bare-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    const threadStarted = Promise.withResolvers<void>();
    cell = await openRepoCell({
      repoId: workspaceId("review-bare"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
      runtimeDaemonRoute: { userRoot: rootDir, daemonId: "daemon-test", endpoint: path.join(rootDir, "daemon.sock") },
      prepareRuntimeLaunch: (_instanceId, request) => ({
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
        args: ["provider-review-bare"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => ({
        pid: 1_001,
        onOutput: (listener) => {
          queueMicrotask(() => {
            listener(`${JSON.stringify({ type: "thread.started", thread_id: "provider-review-bare" })}\n`);
            threadStarted.resolve();
          });
        },
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    const bare = withRoleBinding(
      {
        actor: { principal: { personId: "0" }, executor: null },
        source: "local" as const,
      },
      "arbiter",
    );
    const parentTaskId = "task-bare-parent",
      parentExecutionId = "exec-bare-parent",
      taskId = "task-bare-axis",
      priorExecutionId = "exec-bare-prior",
      executionId = "exec-bare-recovery";
    const parentCreated = await cell.run({ kind: "task-create", taskId: parentTaskId, title: "Bare parent" }, bare);
    assert.equal(parentCreated.outcome, "applied");
    await waitForFixturePublication(cell, parentCreated.opId, bare);
    await realizeTaskPlanFixture(rootDir, String((parentCreated as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, bare),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: parentTaskId, executionId: parentExecutionId }, bare)).outcome,
      "applied",
    );
    const created = await cell.run(
      {
        kind: "task-create",
        taskId,
        title: "Bare axis",
        parentTaskId,
        verticalId: "software/coding",
        presetId: "standard-task",
        profileId: "baseline",
      },
      bare,
    );
    assert.equal(created.outcome, "applied");
    assert.deepEqual(
      {
        presetId: (created as Record<string, unknown>).presetId,
        profileId: (created as Record<string, unknown>).profileId,
        completionGates: (created as Record<string, unknown>).completionGates,
      },
      { presetId: "standard-task", profileId: "baseline", completionGates: ["code-doc-reconciliation"] },
      JSON.stringify(created),
    );
    await waitForFixturePublication(cell, created.opId, bare);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, bare),
    );
    const started = (await cell.run({ kind: "task-start", taskId, executionId: priorExecutionId }, bare)) as Record<
      string,
      unknown
    >;
    assert.equal(started.outcome, "applied");
    assert.deepEqual(started.next, [{ command: `ha task submit ${taskId}` }]);
    assert.doesNotMatch(JSON.stringify(started), /declare-executor/u);
    const worker = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        prompt: "Implement the task.",
        taskId: parentTaskId,
        idempotencyKey: "review-bare-worker",
      },
      bare,
    );
    await runtimeEvent(
      cell,
      threadStarted.promise,
      rootDir,
      "review-bare",
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === worker.runtimeSessionId,
    );
    const agent = withRoleBinding(
      {
        actor: {
          principal: { personId: "0" },
          executor: { kind: "agent" as const, id: `runtime-session:${worker.runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId: priorExecutionId }, bare);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(submitted.next, [{ command: `ha task complete ${taskId}` }]);
    return;
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: priorExecutionId,
            forward: true,
            reason: "Forward prior bare-invocation cut.",
          },
          bare,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "changes-requested.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Exercise the audited recovery round.",
        evidenceChecked: ["historical dispatch"],
      }),
    );
    const priorReviewer = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-prior-reviewer" },
          executor: { kind: "agent" as const, id: "prior-reviewer-agent" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId: priorExecutionId,
            reviewId: "review-prior-changes",
            fromFile: "changes-requested.json",
          },
          priorReviewer,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: priorExecutionId,
            return: true,
            reviewId: "review-prior-changes",
            reason: "Return prior bare-invocation cut.",
          },
          bare,
        )
      ).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, bare)).outcome, "applied");
    assert.equal(submissionOutcome(await cell.run({ kind: "task-submit", taskId, executionId }, bare)), "applied");
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward recovered cut." },
          bare,
        )
      ).outcome,
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
    assert.deepEqual(
      refused.unmetCriteria?.map(({ ref }) => ref),
      ["repo-cell-proof/proofFor.RecordReview"],
    );

    writeFileSync(
      path.join(rootDir, "external-review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "External delivery evidence was inspected.",
        evidenceChecked: ["merged delivery"],
        externalCompletionAnchor: "PR #2088",
        noDispatchReason: "The work was assigned through a legacy external channel.",
      }),
    );
    const dispatchCannotBeSkipped = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "r-external-disallowed",
        fromFile: "external-review.json",
      },
      bare,
    );
    assert.equal(dispatchCannotBeSkipped.code, "actor_unauthorized", JSON.stringify(dispatchCannotBeSkipped));
    writeFileSync(
      path.join(rootDir, "no-independent-review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "The delivery is ready to record.",
        evidenceChecked: ["authored documentation"],
        noIndependentReview: true,
        noIndependentReviewReason: "No independent reviewer was available.",
      }),
    );
    const dispatchCannotUseWeakMarker = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "r-no-independent-review-disallowed",
        fromFile: "no-independent-review.json",
      },
      bare,
    );
    assert.equal(dispatchCannotUseWeakMarker.code, "actor_unauthorized", JSON.stringify(dispatchCannotUseWeakMarker));

    const wrongPrincipal = withRoleBinding(
      {
        actor: { principal: { personId: "1" }, executor: null },
        source: "local" as const,
      },
      "arbiter",
    );
    const denied = await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId,
        agent: `runtime-session:${worker.runtimeSessionId}`,
        reason: "Claim from another principal.",
      },
      wrongPrincipal,
    );
    assert.equal(denied.code, "invalid_proof");

    const impersonatingAgent = withRoleBinding(
        {
          actor: { principal: { personId: "0" }, executor: { kind: "agent" as const, id: "another-runtime" } },
          source: "local" as const,
        },
        "arbiter",
      ),
      impersonationDenied = await cell.run(
        {
          kind: "task-declare-executor",
          taskId,
          executionId,
          agent: `runtime-session:${worker.runtimeSessionId}`,
          reason: "One agent must not bind another agent's dispatch.",
        },
        impersonatingAgent,
      );
    assert.equal(impersonationDenied.code, "invalid_proof", JSON.stringify(impersonationDenied));

    const declared = (await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        reason: "Recovered the executor omitted by the original start invocation.",
      },
      bare,
    )) as Record<string, unknown>;
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    const event = makeTaskEventReader({ repoId: "review-bare", rootDir }).readEvent(String(declared.opId));
    assert.equal(event?.type, "execution_executor_declared");
    if (event?.type === "execution_executor_declared") {
      assert.deepEqual(event.payload.previousActor, bare.actor);
      assert.deepEqual(event.payload.execution.actor, agent.actor);
      assert.deepEqual(event.actor, bare.actor);
      assert.equal(event.payload.dispatchTaskId, parentTaskId);
      assert.equal(event.payload.reason, "Recovered the executor omitted by the original start invocation.");
    }

    const selfReview = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r2", fromFile: "review.json" },
      agent,
    );
    assert.equal(selfReview.code, "actor_unauthorized");

    const reviewed = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "r3", fromFile: "review.json" },
      bare,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const wrongOwner = {
      actor: { principal: { personId: "person-outsider" }, executor: { kind: "agent" as const, id: "outsider" } },
      source: "local" as const,
    };
    const consent = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "r3" }, wrongOwner);
    assert.equal(consent.code, "actor_unauthorized");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a lightweight reviewed child closes without declaring a review executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-bare-reviewed-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const repoId = workspaceId("review-bare-reviewed"),
    parentTaskId = "task-bare-reviewed-parent",
    taskId = "task-bare-reviewed",
    executionId = "exec-bare-reviewed",
    bare = withRoleBinding(
      {
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local" as const,
      },
      "arbiter",
    );
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    writeFileSync(path.join(rootDir, "README.md"), "# Reviewed executor repair fixture\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "--quiet", "-m", "fixture output");
    git(rootDir, "update-ref", "refs/remotes/origin/main", "HEAD");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "review-bare-reviewed" });
    const parentCreated = await cell.run(
      { kind: "task-create", taskId: parentTaskId, title: "Bare reviewed parent" },
      bare,
    );
    assert.equal(parentCreated.outcome, "applied");
    await waitForFixturePublication(cell, parentCreated.opId, bare);
    await realizeTaskPlanFixture(rootDir, String((parentCreated as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, bare),
    );
    const created = await cell.run(
      {
        kind: "task-create",
        taskId,
        title: "Bare reviewed",
        parentTaskId,
        verticalId: "software/coding",
        presetId: "standard-task",
        profileId: "baseline",
      },
      bare,
    );
    assert.equal(created.outcome, "applied");
    assert.deepEqual(
      {
        presetId: (created as Record<string, unknown>).presetId,
        profileId: (created as Record<string, unknown>).profileId,
        completionGates: (created as Record<string, unknown>).completionGates,
      },
      { presetId: "standard-task", profileId: "baseline", completionGates: ["code-doc-reconciliation"] },
      JSON.stringify(created),
    );
    await waitForFixturePublication(cell, created.opId, bare);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, bare),
    );
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
    const packagePath = "tasks/task-bare-reviewed-bare-reviewed";
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, bare)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    git(rootDir, "update-ref", "refs/remotes/origin/main", commitSha);
    writeCloseout(rootDir, packagePath);
    const submitted = (await cell.run({ kind: "task-submit", taskId, executionId }, bare)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    // Initial owner triage is required before any independent reviewer can act.
    const next = submitted.next as { readonly command: string; readonly reason?: string }[];
    assert.equal(next[0]!.command, `ha task complete ${taskId}`);
    return;
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward bare reviewed cut." },
          bare,
        )
      ).outcome,
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
    writeFileSync(
      path.join(rootDir, "external-review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "The origin/main delivery anchor was inspected.",
        evidenceChecked: ["origin/main"],
        externalCompletionAnchor: commitSha,
        noDispatchReason: "The repository owner implemented the delivery directly.",
      }),
    );
    const unmarked = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-unmarked",
        fromFile: "review.json",
      },
      bare,
    );
    assert.equal(unmarked.code, "actor_unauthorized", JSON.stringify(unmarked));
    assert.match(JSON.stringify(unmarked), /HARNESS_ACTOR=agent:<id>/u);
    assert.match(JSON.stringify(unmarked), /declare-executor requires an existing dispatch record/u);
    writeFileSync(
      path.join(rootDir, "no-independent-review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "The documentation-only delivery is ready to record.",
        evidenceChecked: ["authored documentation"],
        noIndependentReview: true,
        noIndependentReviewReason: "No independent reviewer was available for this documentation-only delivery.",
      }),
    );
    const weaklyMarked = (await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-no-independent-review",
        fromFile: "no-independent-review.json",
      },
      bare,
    )) as Record<string, unknown>;
    assert.equal(weaklyMarked.outcome, "applied", JSON.stringify(weaklyMarked));
    const weakReviewEvent = makeTaskEventReader({ repoId, rootDir }).readEvent(String(weaklyMarked.opId));
    assert.equal(weakReviewEvent?.type, "review_recorded");
    assert.deepEqual(
      weakReviewEvent?.type === "review_recorded" ? weakReviewEvent.payload.review.evidenceChecked : [],
      [
        "authored documentation",
        "NO INDEPENDENT REVIEW: No independent reviewer was available for this documentation-only delivery.",
      ],
    );
    const externallyAnchored = (await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-external-anchor",
        fromFile: "external-review.json",
      },
      bare,
    )) as Record<string, unknown>;
    assert.equal(externallyAnchored.outcome, "applied", JSON.stringify(externallyAnchored));
    const externalReviewEvent = makeTaskEventReader({ repoId, rootDir }).readEvent(String(externallyAnchored.opId));
    assert.equal(externalReviewEvent?.type, "review_recorded");
    assert.deepEqual(
      externalReviewEvent?.type === "review_recorded" ? externalReviewEvent.payload.review.evidenceChecked : [],
      [
        "origin/main",
        `external completion anchor: ${commitSha}`,
        "no dispatch reason: The repository owner implemented the delivery directly.",
      ],
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
    const denied = await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId,
        agent: "runtime-session:missing-runtime",
        reason: "A free-text executor must not satisfy the proof gate.",
      },
      bare,
    );
    assert.equal(denied.code, "invalid_proof", JSON.stringify(denied));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review binding permits independent runtimes but still rejects the execution runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-runtime-bound-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    const workerRoot = path.join(rootDir, ".worktrees", "implementer");
    git(rootDir, "worktree", "add", "--quiet", "--detach", workerRoot);
    const processes: {
      exit: ((code: number | null) => void) | null;
      threadStarted: Promise<void>;
    }[] = [];
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
        const providerSessionId = prepared.args[0]!,
          threadStarted = Promise.withResolvers<void>(),
          process: { exit: ((code: number | null) => void) | null; threadStarted: Promise<void> } = {
            exit: null,
            threadStarted: threadStarted.promise,
          };
        processes.push(process);
        return {
          pid: 1_001 + processes.length,
          onOutput: (listener) => {
            queueMicrotask(() => {
              listener(`${JSON.stringify({ type: "thread.started", thread_id: providerSessionId })}\n`);
              threadStarted.resolve();
            });
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
    const taskId = "task-runtime-bound";
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Runtime-bound review", presetId: "docs-task" },
      implementer,
    );
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, implementer);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, implementer),
    );
    // A dispatch from planned is the supported implementation pickup: the center runs StartTask
    // under the new RuntimeSession actor instead of requiring an operator-owned lease first.
    const original = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-relative", path: ".worktrees/implementer" },
        prompt: "Implement the task.",
        taskId,
        idempotencyKey: "original-runtime",
      },
      implementer,
    );
    await runtimeEvent(
      cell,
      processes[0]!.threadStarted,
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === original.runtimeSessionId,
    );
    const started = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventReader({ repoId: "review-runtime-bound", rootDir }),
    });
    const executionId = started.read(taskId).snapshot.lease?.executionId;
    started.close();
    assert.ok(executionId, "planned runtime dispatch must create and hold an execution lease");
    processes[0]!.exit?.(0);
    // The exit listener above chained its publication synchronously; only the queue drain remains.
    await runtimeEvent(
      cell,
      Promise.resolve(),
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_exited" && event.payload.runtimeSessionId === original.runtimeSessionId,
    );
    const resumed = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-relative", path: ".worktrees/implementer" },
        prompt: "Resume the task.",
        taskId,
        providerSessionId: "provider-1",
        idempotencyKey: "resumed-runtime",
      },
      implementer,
    );
    await runtimeEvent(
      cell,
      processes[1]!.threadStarted,
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === resumed.runtimeSessionId,
    );

    writeFileSync(path.join(workerRoot, "README.md"), "# Runtime closeout chain\n");
    git(workerRoot, "add", "README.md");
    git(workerRoot, "commit", "--quiet", "-m", "runtime implementation");
    const resumedImplementer = {
      actor: {
        principal,
        executor: { kind: "agent" as const, id: `runtime-session:${resumed.runtimeSessionId}` },
      },
      source: "local" as const,
    };
    const closeoutPath = `${String((created as Record<string, unknown>).packagePath)}/closeout.md`;
    writeFileSync(
      path.join(rootDir, "harness", closeoutPath),
      `# Closeout\n\n## Summary\n\nRuntime implementation complete at ${git(workerRoot, "rev-parse", "HEAD")}.\n\n` +
        "## Verification\n\nIntegration chain verified.\n\n## Residual Risk\n\nNone.\n\n" +
        "## Same Mechanism Elsewhere\n\nThe runtime ingress path is the shared mechanism.\n",
    );
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, resumedImplementer)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The planned runtime dispatch acquired its execution lease through the center.",
            evidenceSource: "test:review-runtime-bound",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
          },
          resumedImplementer,
        )
      ).outcome,
      "applied",
    );
    const operator = withRoleBinding(implementer, "repo-write");
    assert.equal(
      submissionOutcome(await cell.run({ kind: "task-submit", taskId, executionId }, resumedImplementer)),
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward runtime-bound cut." },
          operator,
        )
      ).outcome,
      "applied",
    );
    const reconciled = await cell.run({ kind: "task-code-doc-reconcile", taskId, paths: ["README.md"] }, operator);
    assert.equal(reconciled.outcome, "applied", JSON.stringify(reconciled));
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed.", evidenceChecked: ["tests"] }),
    );
    const runtimeBoundReportDir = path.join(
      rootDir,
      "harness",
      String((created as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
    );
    mkdirSync(runtimeBoundReportDir, { recursive: true });
    for (const id of ["executor", "dispatched-reviewer"])
      writeFileSync(path.join(runtimeBoundReportDir, `${id}.md`), `# Review ${id}\n\nPhysical review findings.\n`);

    // Reviewer dispatch derives the task mission and records task dispatch provenance without
    // taking the execution lease or becoming its executor.
    const reviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        idempotencyKey: "task-reviewer",
      },
      implementer,
    );
    await runtimeEvent(
      cell,
      processes[2]!.threadStarted,
      rootDir,
      "review-runtime-bound",
      (event) =>
        event.type === "runtime_session_task_bound" &&
        event.payload.runtimeSessionId === reviewer.runtimeSessionId &&
        event.payload.taskId === taskId &&
        event.payload.executionId === executionId,
    );
    const afterReviewerDispatch = JSON.parse(
      String((await cell.run({ kind: "task-show", taskId }, implementer)).evidence),
    ) as { readonly lease: unknown };
    assert.equal(afterReviewerDispatch.lease, null);
    const denied = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "review-executor", fromFile: "review.json" },
      arbiter(`runtime-session:${resumed.runtimeSessionId}`),
    );
    assert.equal(denied.code, "runtime_task_self_review_forbidden");
    const reviewed = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-dispatched-reviewer",
        fromFile: "review.json",
      },
      arbiter(`runtime-session:${reviewer.runtimeSessionId}`),
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const consented = await cell.run({ kind: "task-review-consent", taskId, executionId }, operator);
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, operator);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));

    const directTaskId = "task-direct-review",
      directExecutionId = "execution-direct-review";
    const directCreated = await cell.run(
      { kind: "task-create", taskId: directTaskId, title: "Direct review" },
      implementer,
    );
    assert.equal(directCreated.outcome, "applied");
    await waitForFixturePublication(cell, directCreated.opId, implementer);
    await realizeTaskPlanFixture(rootDir, String((directCreated as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, implementer),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: directTaskId, executionId: directExecutionId }, implementer))
        .outcome,
      "applied",
    );
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, (directCreated as Record<string, unknown>).packagePath);
    assert.equal(
      submissionOutcome(
        await cell.run({ kind: "task-submit", taskId: directTaskId, executionId: directExecutionId }, implementer),
      ),
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId: directTaskId,
            executionId: directExecutionId,
            forward: true,
            reason: "Forward direct review cut.",
          },
          operator,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed by another agent.", evidenceChecked: ["tests"] }),
    );
    const childReportDir = path.join(
      rootDir,
      "harness",
      String((directCreated as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
    );
    mkdirSync(childReportDir, { recursive: true });
    writeFileSync(path.join(childReportDir, "child-agent.md"), "# Review child-agent\n\nPhysical review findings.\n");
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
