// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCell } from "../src/repo-cell.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
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
        idempotencyKey: "author-runtime",
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
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId: authoringExecutionId, forward: true, reason: "Forward cut." },
          spawnOperator,
        )
      ).outcome,
      "applied",
    );

    // The cut's reviewer dispatch binds to the authoring execution; it must never carry attribution.
    const cutReviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        idempotencyKey: "cut-reviewer-1",
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
      JSON.stringify({ verdict: "changes_requested", reason: "Rework the cut.", evidenceChecked: ["tests"] }),
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
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: authoringExecutionId,
            return: true,
            reviewId: "cha",
            reason: "Return the cut.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );

    // Recovery round: a bare owner execution with executor=null whose only dispatch is a reviewer.
    const recoveryExecutionId = "exec-recovery";
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: recoveryExecutionId }, owner)).outcome,
      "applied",
    );
    writeFileSync(path.join(workerRoot, "README.md"), "# Recovery delivery\n");
    git(workerRoot, "commit", "--quiet", "-am", "recovery delivery");
    const recoveryCommit = git(workerRoot, "rev-parse", "HEAD");
    writeCloseout(rootDir, packagePath);
    assert.equal(
      submissionOutcome(
        await cell.run(
          { kind: "task-submit", taskId, executionId: recoveryExecutionId, commitSha: recoveryCommit },
          owner,
        ),
      ),
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: recoveryExecutionId,
            forward: true,
            reason: "Forward recovery.",
          },
          spawnOperator,
        )
      ).outcome,
      "applied",
    );
    const recoveryReviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        idempotencyKey: "cut-reviewer-2",
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

    const declared = (await cell.run(
      {
        kind: "task-declare-executor",
        taskId,
        executionId: recoveryExecutionId,
        reason: "Restore the author omitted by the bare recovery round.",
      },
      owner,
    )) as Record<string, unknown>;
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(declared.opId));
    assert.equal(event?.type, "execution_executor_declared");
    if (event?.type === "execution_executor_declared") {
      assert.deepEqual(event.payload.execution.actor.executor, {
        kind: "agent",
        id: `runtime-session:${author.runtimeSessionId}`,
      });
      assert.equal(event.payload.dispatchTaskId, taskId);
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
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward reviewer-only cut." },
          spawnOperator,
        )
      ).outcome,
      "applied",
    );
    const reviewer = await cell.spawnRuntime(
      {
        runtimeInstanceId: "review-runtime",
        cwd: { scope: "repo-root" },
        taskId,
        role: "reviewer",
        idempotencyKey: "reviewer-only-cut",
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
    assert.match(JSON.stringify(refused), /no non-reviewer runtime dispatch/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
