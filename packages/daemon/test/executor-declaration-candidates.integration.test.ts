// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";

import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCell } from "../src/repo-cell.ts";
import { grantTestPolicyGroups, revokeTestPolicyActions, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import {
  commitDelivery,
  git,
  initRepo,
  runtimeEvent,
  reviewRuntimeInstance,
  submissionOutcome,
  writeCloseout,
  writeSettingsFixture,
} from "./review-independence.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

type SpawnedProcess = {
  exit: ((code: number | null) => void) | null;
  threadStarted: Promise<void>;
};

function openRuntimeStubCell(rootDir: string, repoId: string, processes: SpawnedProcess[]): Promise<RepoCell> {
  let providerSequence = 0;
  return openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "daemon-test",
    runtimeDaemonRoute: { userRoot: rootDir, daemonId: "daemon-test", endpoint: path.join(rootDir, "daemon.sock") },
    runtimeInstances: () => [reviewRuntimeInstance],
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
        spawned: SpawnedProcess = { exit: null, threadStarted: threadStarted.promise };
      processes.push(spawned);
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
          spawned.exit = listener;
        },
        terminate: () => spawned.exit?.(0),
      };
    },
  });
}

// The reported defect: an owner-amended recovery execution with executor=null offered only the
// closeout-reviewer sessions dispatched onto that execution as declare-executor candidates, while
// the iteration-0 authoring dispatch fell out of the candidate set. Following the hint would have
// registered the reviewer as the executor — the very attribution executor declaration exists to
// judge for reviewer independence.
test("declare-executor traces the authoring dispatch across executions and never offers a reviewer", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-executor-candidates-")),
    processes: SpawnedProcess[] = [],
    repoId = "executor-candidates";
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    const workerRoot = path.join(rootDir, ".worktrees", "implementer");
    git(rootDir, "worktree", "add", "--quiet", "--detach", workerRoot);
    cell = await openRuntimeStubCell(rootDir, repoId, processes);
    const fixtureSettings = await cell.read("repo.settings.read");
    assert.deepEqual(
      fixtureSettings.settings.runtime?.allowedInstances,
      ["review-runtime"],
      JSON.stringify(fixtureSettings),
    );
    const person = { personId: "person-owner" },
      owner = withPolicyGroup(
        withPolicyGroup({ actor: { principal: person, executor: null }, source: "local" as const }, "maintainer"),
        "contributor",
      ),
      spawnOperator = withPolicyGroup(
        {
          actor: { principal: person, executor: { kind: "agent" as const, id: "spawn-operator" } },
          source: "local" as const,
        },
        "admin",
      ),
      taskId = "task-executor-candidates";
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Executor candidates", presetId: "docs-task" },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );

    // Iteration 0: the authoring dispatch creates and holds the execution.
    const author = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-relative", path: ".worktrees/implementer" },
        prompt: "Implement the task.",
        taskId,
        dispatchKey: "author-runtime",
      },
      spawnOperator,
    );
    await runtimeEvent(
      cell,
      processes[0]!.threadStarted,
      rootDir,
      repoId,
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === author.runtimeSessionId,
    );
    const projection = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventReader({ repoId, rootDir }),
    });
    const authoringExecutionId = projection.read(taskId).snapshot.lease?.executionId;
    projection.close();
    assert.ok(authoringExecutionId, "the authoring dispatch must create and hold an execution");
    const authorActor = withPolicyGroup(
      {
        actor: {
          principal: person,
          executor: { kind: "agent" as const, id: `runtime-session:${author.runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "admin",
    );
    writeFileSync(path.join(workerRoot, "README.md"), "# Authoring delivery\n");
    git(workerRoot, "add", "README.md");
    git(workerRoot, "commit", "--quiet", "-m", "authoring delivery");
    writeCloseout(rootDir, packagePath);
    assert.equal(
      submissionOutcome(
        await cell.run({ kind: "task-submit", taskId, executionId: authoringExecutionId }, authorActor),
      ),
      "applied",
    );

    // The cut's reviewer dispatch binds to the authoring execution; it must never carry attribution.
    const cutReviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        dispatchKey: "cut-reviewer-1",
      },
      spawnOperator,
    );
    await runtimeEvent(
      cell,
      processes[1]!.threadStarted,
      rootDir,
      repoId,
      (event) =>
        event.type === "runtime_session_task_bound" &&
        event.payload.runtimeSessionId === cutReviewer.runtimeSessionId &&
        event.payload.executionId === authoringExecutionId,
    );
    const reviewReportDir = path.join(rootDir, "harness", packagePath, "artifacts", "reports");
    mkdirSync(reviewReportDir, { recursive: true });
    writeFileSync(path.join(reviewReportDir, "cha.md"), "# Review cha\n\nPhysical review findings.\n");
    writeFileSync(
      path.join(rootDir, "changes-requested.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Rework the cut.",
        evidenceChecked: ["tests"],
        findings: [{ findingId: "fixture-finding", blocking: true, text: "Fixture review requires another pass." }],
        resolutions: [],
      }),
    );
    const cutReviewerActor = withPolicyGroup(
      withPolicyGroup(
        {
          actor: {
            principal: { personId: "person-cut-reviewer" },
            executor: { kind: "agent" as const, id: `runtime-session:${cutReviewer.runtimeSessionId}` },
          },
          source: "local" as const,
        },
        "maintainer",
      ),
      "contributor",
    );
    // The verdict itself reopens the round; denying the reviewing principal's runtime-spawn keeps
    // the automatic worker continuation from launching in this stub cell, so the recovery round
    // below starts like any other (a reviewer never needs to spawn).
    revokeTestPolicyActions("person-cut-reviewer", "executor-candidates", ["runtime-spawn"]);
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId: authoringExecutionId,
            reviewId: "cha",
            fromFile: "changes-requested.json",
          },
          cutReviewerActor,
        )
      ).outcome,
      "applied",
    );
    grantTestPolicyGroups(["person-cut-reviewer"], "maintainer");

    // Recovery round: a bare owner execution with executor=null whose only dispatch is a reviewer.
    const recoveryExecutionId = "exec-recovery";
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: recoveryExecutionId }, owner)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-respond-review",
            taskId,
            executionId: recoveryExecutionId,
            jsonInput: JSON.stringify({
              responses: [
                {
                  reviewId: "cha",
                  findingId: "fixture-finding",
                  disposition: "adopt",
                  rationale: "The recovery execution addresses the blocking fixture finding.",
                },
              ],
            }),
          },
          owner,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(path.join(workerRoot, "README.md"), "# Recovery delivery\n");
    git(workerRoot, "commit", "--quiet", "-am", "recovery delivery");
    const recoveryCommit = git(workerRoot, "rev-parse", "HEAD");
    writeCloseout(rootDir, packagePath);
    const recoverySubmit = (await cell.run(
      { kind: "task-submit", taskId, executionId: recoveryExecutionId, commitSha: recoveryCommit },
      owner,
    )) as Record<string, unknown>;
    assert.equal(submissionOutcome(recoverySubmit), "applied", JSON.stringify(recoverySubmit));
    const recovered = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventReader({ repoId, rootDir }),
    });
    try {
      assert.deepEqual(
        recovered.read(taskId).snapshot.executions.find((execution) => execution.executionId === recoveryExecutionId)
          ?.actor.executor,
        { kind: "agent", id: `runtime-session:${author.runtimeSessionId}` },
      );
    } finally {
      recovered.close();
    }

    const recoveryReviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        dispatchKey: "cut-reviewer-2",
      },
      spawnOperator,
    );
    await runtimeEvent(
      cell,
      processes[2]!.threadStarted,
      rootDir,
      repoId,
      (event) =>
        event.type === "runtime_session_task_bound" &&
        event.payload.runtimeSessionId === recoveryReviewer.runtimeSessionId &&
        event.payload.executionId === recoveryExecutionId,
    );

    const events = makeTaskEventReader({ repoId, rootDir }).read().events,
      declaration = events.find(
        (event) =>
          event.type === "execution_executor_declared" && event.payload.execution.executionId === recoveryExecutionId,
      );
    assert.equal(declaration?.type, "execution_executor_declared");
    if (declaration?.type === "execution_executor_declared") {
      assert.deepEqual(declaration.payload.execution.actor.executor, {
        kind: "agent",
        id: `runtime-session:${author.runtimeSessionId}`,
      });
      assert.equal(declaration.payload.dispatchTaskId, taskId);
      assert.match(declaration.payload.reason, /Automatically attributed/u);
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// Negative control: with no authoring dispatch anywhere on the lineage, a reviewer session is not
// a fallback executor — the declaration must refuse instead of registering the reviewer.
test("declare-executor refuses when the lineage only ever hosted reviewer dispatches", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-executor-reviewer-only-")),
    processes: SpawnedProcess[] = [],
    repoId = "executor-reviewer-only";
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    cell = await openRuntimeStubCell(rootDir, repoId, processes);
    const fixtureSettings = await cell.read("repo.settings.read");
    assert.deepEqual(
      fixtureSettings.settings.runtime?.allowedInstances,
      ["review-runtime"],
      JSON.stringify(fixtureSettings),
    );
    const person = { personId: "person-owner" },
      owner = withPolicyGroup(
        withPolicyGroup({ actor: { principal: person, executor: null }, source: "local" as const }, "maintainer"),
        "contributor",
      ),
      spawnOperator = withPolicyGroup(
        {
          actor: { principal: person, executor: { kind: "agent" as const, id: "spawn-operator" } },
          source: "local" as const,
        },
        "admin",
      ),
      taskId = "task-reviewer-only",
      executionId = "exec-reviewer-only";
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Reviewer only", presetId: "docs-task" },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, packagePath);
    assert.equal(
      submissionOutcome(
        await cell.run(
          { kind: "task-submit", taskId, executionId, commitSha: git(rootDir, "rev-parse", "HEAD") },
          owner,
        ),
      ),
      "applied",
    );

    const reviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        dispatchKey: "reviewer-only-cut",
      },
      spawnOperator,
    );
    await runtimeEvent(
      cell,
      processes[0]!.threadStarted,
      rootDir,
      repoId,
      (event) =>
        event.type === "runtime_session_task_bound" &&
        event.payload.runtimeSessionId === reviewer.runtimeSessionId &&
        event.payload.executionId === executionId,
    );

    const refused = (await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId,
        reason: "The reviewer session is the only dispatch on this lineage.",
      },
      owner,
    )) as Record<string, unknown>;
    assert.equal(refused.code, "invalid_proof", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /no authoring dispatch to replay/u);
    // A reviewer's bare session id is the same identity as its runtime-session: executor id; the
    // refusal must not be bypassable by choosing the spelling that skips the executor prefix.
    for (const alias of [
      reviewer.runtimeSessionId,
      `runtime-session:${reviewer.runtimeSessionId}`,
      `agent:runtime-session:${reviewer.runtimeSessionId}`,
    ]) {
      const aliasRefused = (await cell.run(
        {
          kind: "task-declare-executor",
          taskId,
          executionId,
          agent: alias,
          reason: "A reviewer spelling must not become the author.",
        },
        owner,
      )) as Record<string, unknown>;
      assert.equal(aliasRefused.code, "invalid_proof", `${alias}: ${JSON.stringify(aliasRefused)}`);
      assert.match(JSON.stringify(aliasRefused), /reviewer identity/u, alias);
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The reported defect: the owner authored the work outside the ledger (no runtime dispatch at all)
// and submitted it with --as-owner. `ha task show` advertised `ha task declare-executor`, but that
// command's proof requires a dispatch record, so the advertised next step could never run. The one
// executable step for an executorless, un-reviewed cut is the independent review itself; once it is
// recorded the missing executor no longer blocks.
test("a dispatchless owner submission declares its external agent and doctor follows the same state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-executor-dispatchless-")),
    repoId = "executor-dispatchless",
    taskId = "task-executor-dispatchless",
    executionId = "exec-dispatchless",
    reviewId = "dispatchless-review",
    externalAgent = "codex-gpt-6.1-sol";
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir, "strict");
    cell = await openRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: "daemon-test",
    });
    const person = { personId: "person-owner" },
      owner = withPolicyGroup(
        withPolicyGroup({ actor: { principal: person, executor: null }, source: "local" as const }, "maintainer"),
        "contributor",
      ),
      reviewer = withPolicyGroup(
        withPolicyGroup(
          {
            actor: {
              principal: { personId: "person-independent-reviewer" },
              executor: { kind: "agent" as const, id: "independent-review-agent" },
            },
            source: "local" as const,
          },
          "maintainer",
        ),
        "contributor",
      );
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Dispatchless owner delivery", presetId: "standard-task" },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, packagePath);
    assert.equal(submissionOutcome(await cell.run({ kind: "task-submit", taskId, executionId }, owner)), "applied");

    const shown = (await cell.run({ kind: "task-show", taskId }, owner)) as Record<string, unknown>,
      evidence = JSON.parse(String(shown.evidence)) as {
        readonly executions: readonly {
          readonly executionId: string;
          readonly actor: { readonly executor: unknown };
        }[];
        readonly completionNext: { readonly action: string } | null;
        readonly completionBlocker: { readonly code: string } | null;
      };
    assert.equal(
      evidence.executions.find((execution) => execution.executionId === executionId)?.actor.executor,
      null,
      "the fixture must reproduce the reported dispatchless (executor=null) execution",
    );
    assert.equal(evidence.completionBlocker?.code, "executor_missing", JSON.stringify(evidence.completionBlocker));
    assert.equal(
      evidence.completionNext?.action,
      `ha task declare-executor ${taskId} --execution-id ${executionId} --agent <agent-id> ` +
        "--reason <auditable-recovery-reason>",
      "an executorless cut with no dispatch must point at the owner declaration it can actually run",
    );

    // The owner's explicit agent id and reason are the attribution record for out-of-ledger work.
    const declared = await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId,
        agent: externalAgent,
        reason: "The owner ran this work outside the ledger with this agent.",
      },
      owner,
    );
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));

    const attributed = (await cell.run({ kind: "task-show", taskId }, owner)) as Record<string, unknown>,
      attributedEvidence = JSON.parse(String(attributed.evidence)) as {
        readonly executions: readonly {
          readonly executionId: string;
          readonly actor: { readonly executor: unknown };
        }[];
        readonly completionBlocker: { readonly code: string } | null;
      };
    assert.deepEqual(
      attributedEvidence.executions.find((execution) => execution.executionId === executionId)?.actor.executor,
      { kind: "agent", id: externalAgent },
      "the declaration must persist the claimed agent on the execution",
    );
    assert.notEqual(attributedEvidence.completionBlocker?.code, "executor_missing");
    assert.equal(await doctorCheck(cell, owner, "executor-undeclared").then((check) => check.status), "ok");

    writeFileSync(
      path.join(rootDir, "dispatchless-review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "The independent reviewer inspected the dispatchless owner delivery.",
        evidenceChecked: ["focused regression test"],
        findings: [],
        resolutions: [],
      }),
    );
    const reviewReportDir = path.join(rootDir, "harness", packagePath, "artifacts", "reports");
    mkdirSync(reviewReportDir, { recursive: true });
    writeFileSync(
      path.join(reviewReportDir, `${reviewId}.md`),
      "# Review dispatchless-review\n\nThe independent reviewer inspected the owner delivery.\n",
    );
    const reviewed = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId,
        fromFile: "dispatchless-review.json",
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    const after = (await cell.run({ kind: "task-show", taskId }, owner)) as Record<string, unknown>,
      afterEvidence = JSON.parse(String(after.evidence)) as {
        readonly completionBlocker: { readonly code: string } | null;
      };
    assert.notEqual(
      afterEvidence.completionBlocker?.code,
      "executor_missing",
      "recording the independent review settles the independence judgment the missing executor stood for",
    );
    assert.equal(
      (await doctorCheck(cell, owner, "executor-undeclared")).status,
      "ok",
      "doctor must not keep demanding attribution after the review already judged the cut",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function doctorCheck(
  cell: RepoCell,
  actor: Parameters<RepoCell["run"]>[1],
  checkId: string,
): Promise<{ readonly status: string; readonly count: number }> {
  const receipt = (await cell.run({ kind: "doctor-health" }, actor)) as Record<string, unknown>,
    checks = receipt.checks as readonly { readonly id: string; readonly status: string; readonly count: number }[],
    check = checks.find((candidate) => candidate.id === checkId);
  assert.ok(check, `doctor check ${checkId} missing: ${JSON.stringify(receipt.checks)}`);
  return check;
}

// A parent's authoring dispatch is not proof that the parent authored the child: the child may have
// been produced outside the ledger. An agent delegate must be able to record the child's real
// external author without impersonating it, and the parent dispatch must not auto-attribute at submit.
test("an agent delegate records a child's external author despite an unrelated parent dispatch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-executor-parent-lineage-")),
    repoId = "executor-parent-lineage",
    parentTaskId = "task-parent-lineage",
    childTaskId = "task-child-lineage",
    childExecutionId = "exec-child-lineage",
    processes: SpawnedProcess[] = [];
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir, "strict");
    const workerRoot = path.join(rootDir, ".worktrees", "implementer");
    git(rootDir, "worktree", "add", "--quiet", "--detach", workerRoot);
    cell = await openRuntimeStubCell(rootDir, repoId, processes);
    const person = { personId: "person-owner" },
      owner = withPolicyGroup(
        withPolicyGroup({ actor: { principal: person, executor: null }, source: "local" as const }, "maintainer"),
        "contributor",
      ),
      spawnOperator = withPolicyGroup(
        {
          actor: { principal: person, executor: { kind: "agent" as const, id: "spawn-operator" } },
          source: "local" as const,
        },
        "admin",
      ),
      delegatingAgent = withPolicyGroup(
        withPolicyGroup(
          {
            actor: { principal: person, executor: { kind: "agent" as const, id: "delegating-agent" } },
            source: "local" as const,
          },
          "maintainer",
        ),
        "contributor",
      );

    const parent = await cell.run(
      {
        kind: "task-create",
        taskId: parentTaskId,
        title: "Parent with an authoring dispatch",
        presetId: "standard-task",
      },
      owner,
    );
    assert.equal(parent.outcome, "applied", JSON.stringify(parent));
    await waitForFixturePublication(cell, parent.opId, owner);
    const parentPackagePath = String((parent as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, parentPackagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    const parentAuthor = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-relative", path: ".worktrees/implementer" },
        prompt: "Author the parent.",
        taskId: parentTaskId,
        dispatchKey: "parent-author",
      },
      spawnOperator,
    );
    await runtimeEvent(
      cell,
      processes[0]!.threadStarted,
      rootDir,
      repoId,
      (event) =>
        event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === parentAuthor.runtimeSessionId,
    );

    const child = await cell.run(
      {
        kind: "task-create",
        taskId: childTaskId,
        title: "Child authored outside the ledger",
        presetId: "standard-task",
        parentTaskId,
      },
      owner,
    );
    assert.equal(child.outcome, "applied", JSON.stringify(child));
    await waitForFixturePublication(cell, child.opId, owner);
    const childPackagePath = String((child as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, childPackagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: childTaskId, executionId: childExecutionId }, owner)).outcome,
      "applied",
    );
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, childPackagePath);
    assert.equal(
      submissionOutcome(
        await cell.run({ kind: "task-submit", taskId: childTaskId, executionId: childExecutionId }, owner),
      ),
      "applied",
    );

    const shown = (await cell.run({ kind: "task-show", taskId: childTaskId }, owner)) as Record<string, unknown>,
      evidence = JSON.parse(String(shown.evidence)) as {
        readonly executions: readonly {
          readonly executionId: string;
          readonly actor: { readonly executor: unknown };
        }[];
        readonly completionNext: { readonly action: string } | null;
        readonly completionBlocker: { readonly code: string } | null;
      };
    assert.equal(
      evidence.executions.find((execution) => execution.executionId === childExecutionId)?.actor.executor,
      null,
      "submit must not auto-attribute a parent dispatch to a child execution",
    );
    assert.equal(evidence.completionBlocker?.code, "executor_missing", JSON.stringify(evidence.completionBlocker));
    assert.equal(
      evidence.completionNext?.action,
      `ha task declare-executor ${childTaskId} --execution-id ${childExecutionId} --agent <agent-id> ` +
        "--reason <auditable-recovery-reason>",
      "an execution with no exact dispatch must offer the external declaration, not a parent candidate",
    );

    const declared = await cell.run(
      {
        kind: "task-declare-executor",
        taskId: childTaskId,
        executionId: childExecutionId,
        agent: "external-owner-agent",
        reason: "The owner ran this child outside the ledger with this agent.",
      },
      delegatingAgent,
    );
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(declared.opId));
    assert.equal(event?.type, "execution_executor_declared");
    if (event?.type === "execution_executor_declared") {
      assert.deepEqual(event.actor, delegatingAgent.actor, "the event records who declared");
      assert.deepEqual(event.payload.execution.actor.executor, { kind: "agent", id: "external-owner-agent" });
      assert.equal(event.payload.dispatchTaskId, undefined, "an external declaration has no dispatch to replay");
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
