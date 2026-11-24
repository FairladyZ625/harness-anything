// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { readDispatchStreamHeader } from "../src/daemon-host/dispatch-stream.ts";
import { taskPrPublicationNote } from "../src/daemon-host/runtime-spawn-mission.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { latestSquadStates } from "./squad-run-state.fixture.ts";
import { git } from "./task-surface.fixtures.ts";
import { assertChildrenClosed, binding, createSuiteHost, openFixture } from "./task-squad-orchestration.fixture.ts";

const suiteHost = createSuiteHost("delivery-shared");

test("canonical squad dispatch rows expose the run owner for leaders and children", { timeout: 90_000 }, async (t) => {
  const fixture = await openFixture(t, "canonical-run-owner", { host: suiteHost });
  await fixture.plan(["a.txt"], ["b.txt"]);
  const running = await fixture.waitStatus(
    (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((worker) => worker.runtimeSessionId),
  );
  const taskIds = [fixture.taskId, ...running.workerAttempts.map((worker) => worker.taskId!)],
    dispatches = (await Promise.all(taskIds.map((taskId) => fixture.cell.read("repo.task.dispatches", { taskId }))))
      .flatMap((result) => result.dispatches)
      .sort((left, right) => left.dispatchId.localeCompare(right.dispatchId)),
    expectedDispatchIds = [
      ...running.leaderTurns.map((turn) => turn.dispatchId),
      ...running.workerAttempts.map((worker) => worker.dispatchId!),
    ].sort();
  assert.deepEqual(
    dispatches.map((dispatch) => dispatch.dispatchId),
    expectedDispatchIds,
    "the public query must include the leader and both workers before checking their owner",
  );
  assert.deepEqual(
    dispatches.map((dispatch) => ({ dispatchId: dispatch.dispatchId, squadRunId: dispatch.squadRunId ?? null })),
    expectedDispatchIds.map((dispatchId) => ({ dispatchId, squadRunId: running.squadRunId })),
    "canonical run ownership must reach the generic incident consumer through the public dispatch query",
  );
  const ownerRow = dispatches.find((dispatch) =>
      running.leaderTurns.some((turn) => turn.dispatchId === dispatch.dispatchId),
    ),
    workerRows = dispatches.filter(
      (dispatch) => !running.leaderTurns.some((turn) => turn.dispatchId === dispatch.dispatchId),
    );
  assert.deepEqual(
    ownerRow?.squadChildTaskIds,
    running.workerAttempts.map((worker) => worker.taskId!).sort(),
    "the run owner row must name the child tasks it dispatched",
  );
  assert.ok(
    workerRows.every((dispatch) => dispatch.squadChildTaskIds === undefined),
    "only the run owner row carries the child list; a worker row must not fan out",
  );
});

for (const restart of [false, true])
  test(
    `targeted task publishes while same-squad child stays local (restart=${restart})`,
    { timeout: 90_000 },
    async (t) => {
      // Each independent repository has its own identity in the shared fixture realm.
      const fixture = await openFixture(t, `publication-owner-${restart}`, restart ? {} : { host: suiteHost });
      await fixture.plan(["a.txt"], ["b.txt"]);
      const running = await fixture.waitStatus(
        (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
      );
      const child = running.workerAttempts[0],
        taskId = "task_direct-targeted",
        created = await fixture.cell.run(
          {
            kind: "task-create",
            taskId,
            title: "Direct targeted",
            presetId: "standard-task",
          },
          binding,
        );
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(fixture.cell, created.opId, binding);
      await realizeTaskPlanFixture(fixture.root, String((created as Record<string, unknown>).packagePath), (planPath) =>
        fixture.cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal((await fixture.cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
      // Starting a repository-diff task materializes its task-named publication branch.
      const cwd = path.join(fixture.root, ".worktrees", taskId);
      const direct = await fixture.cell.spawnRuntime(
        {
          runtimeInstanceId: "stub",
          agentId: "leader",
          targetAgentId: "one",
          taskId,
          cwd: { scope: "repo-relative", path: `.worktrees/${taskId}` },
          prompt: "Deliver the directly targeted task.",
          dispatchKey: "direct-targeted",
        },
        binding,
      );
      const childHeader = readDispatchStreamHeader(fixture.root, child.dispatchId!)!,
        directHeader = readDispatchStreamHeader(fixture.root, String(direct.dispatchId))!;
      assert.equal(childHeader.squadId, "squad");
      assert.equal(directHeader.squadId, childHeader.squadId);
      assert.equal(childHeader.publicationOwner, "commander");
      assert.equal(directHeader.publicationOwner, "runtime");
      for (const directory of [
        fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd,
        cwd,
      ]) {
        writeFileSync(path.join(directory, "a.txt"), "delivery\n");
        git(directory, "add", "a.txt");
        git(directory, "commit", "-qm", "feat: targeted delivery");
      }
      await fixture.finish(child.dispatchId!, "child delivery", 0, restart);
      await fixture.finish(String(direct.dispatchId), "direct delivery", 0, restart);
      if (restart) await fixture.reopen();
      await fixture.waitStatus((state) => state.workerCallbackCount >= 1);
      // The child callback only proves the child outcome event projected. The targeting dispatch
      // settles on its own process exit (scheduled after provider.exit returns), so wait for its
      // canonical outcome before asserting the row or reading its settlement report.
      await fixture.until(
        async () =>
          ((await fixture.cell.read("repo.task.dispatches", { taskId })).dispatches[0]?.outcome ?? null) !== null
            ? true
            : null,
        "targeting dispatch records a terminal outcome",
      );
      await fixture.cell.settlePendingMaterialization("publication owner");
      const rows = (await fixture.cell.read("repo.task.dispatches", { taskId })).dispatches;
      assert.equal(rows[0]?.outcome, "succeeded");
      const childRows = (await fixture.cell.read("repo.task.dispatches", { taskId: child.taskId! })).dispatches;
      assert.equal(childRows[0]?.outcome, "succeeded");
      assert.equal(
        readFileSync(path.join(fixture.root, "harness", childRows[0].reportPath!), "utf8").trim(),
        `child delivery\n\nTask ${child.taskId} is not submitted: runtime success and task submission are separate states. ` +
          `The owner can recover this delivered closeout with: ha task submit ${child.taskId} --as-owner`,
      );
      const report = readFileSync(path.join(fixture.root, "harness", rows[0].reportPath!), "utf8");
      assert.match(report, new RegExp(`Worker branch pushed at settlement: ${taskId} @`, "u"));
      assert.equal(
        git(fixture.bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${taskId}`),
        git(cwd, "rev-parse", "HEAD"),
      );
      assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${child.taskId}`), "");
    },
  );

test(
  "squad children submit independently, resume one leader and integrate a verified local-remote delivery",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await openFixture(t, "delivery");
    const planningLeader = (await fixture.status()).leaderTurns[0].runtimeSessionId;
    assert.equal(fixture.task(fixture.taskId).snapshot.lease?.actor.executor?.id, `runtime-session:${planningLeader}`);
    await fixture.plan(["src/a.txt"], ["docs/"]);
    const running = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
    );
    const planningEvents = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.root }).read().events;
    const leaderRelease = planningEvents.findIndex(
      (event) =>
        event.type === "lease_released" &&
        event.taskId === fixture.taskId &&
        event.payload.releasedLease.actor.executor?.id === `runtime-session:${planningLeader}`,
    );
    const coordinatorReacquire = planningEvents.findIndex(
      (event, index) =>
        index > leaderRelease &&
        event.type === "execution_started" &&
        event.taskId === fixture.taskId &&
        event.actor.executor?.id === "coordinator",
    );
    assert.ok(
      leaderRelease >= 0 && coordinatorReacquire > leaderRelease,
      "leader release must precede coordinator callback reacquisition",
    );
    const staleLeaderWrite = await fixture.cell.run(
      {
        kind: "task-progress-append",
        taskId: fixture.taskId,
        text: "stale planning leader",
        executor: { kind: "agent", id: `runtime-session:${planningLeader}` },
      },
      binding,
    );
    assert.equal(staleLeaderWrite.code, "executor_binding_invalid");
    const [first, second] = running.workerAttempts;
    assert.ok(first.taskId && second.taskId && first.executionId && second.executionId);
    assert.notEqual(first.taskId, second.taskId);
    assert.notEqual(first.executionId, second.executionId);
    assert.notEqual(first.taskId, fixture.taskId);
    for (const child of running.workerAttempts) {
      const row = fixture.task(child.taskId!);
      assert.equal(row.snapshot.lease?.executionId, child.executionId);
      const context = await fixture.cell.read("repo.tasks.runtimeContext.read", { taskId: child.taskId! });
      assert.equal(context.snapshot.workspace?.kind, "worktree");
      assert.equal(
        fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)?.cwd,
        path.resolve(fixture.root, context.snapshot.workspace!.path),
        "the worker must commit in the same bound worktree that task submit reads",
      );
      assert.match(
        readFileSync(path.join(fixture.root, "harness", row.packagePath!, "task_plan.md"), "utf8"),
        /worker mission/u,
      );
    }
    const heads: string[] = [];
    for (const [index, child] of running.workerAttempts.entries()) {
      assert.ok(child.worktree);
      const target = index === 0 ? "src/a.txt" : "docs/b.txt";
      mkdirSync(
        path.dirname(
          path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, target),
        ),
        { recursive: true },
      );
      writeFileSync(
        path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, target),
        `child ${index}\n`,
      );
      if (index === 1)
        writeFileSync(
          path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "outside.txt"),
          "ownership finding\n",
        );
      git(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "add", ".");
      git(
        fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd,
        "commit",
        "-qm",
        `docs: child ${index} delivery`,
      );
      heads.push(
        git(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "rev-parse", "HEAD"),
      );
      await fixture.submit(child, heads[index], index === 1);
      await fixture.finish(child.dispatchId!, "child delivery");
      if (index === 0) {
        await fixture.waitStatus((state) => state.workerCallbackCount === 1);
        assert.equal((await fixture.status()).leaderTurns.length, 1, "one live child keeps the leader suspended");
      }
    }
    const resumed = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
    assert.equal(resumed.workerCallbackCount, 2);
    assert.deepEqual(
      latestSquadStates(fixture.root).get(resumed.squadRunId)?.workerAttempts[1].ownershipCheck?.outsidePaths,
      ["outside.txt"],
    );
    assert.equal(
      git(fixture.providers.find((provider) => provider.dispatchId === second.dispatchId)!.cwd, "rev-parse", "HEAD"),
      heads[1],
      "finding does not roll back delivery",
    );
    for (const child of resumed.workerAttempts) {
      assert.equal(fixture.task(child.taskId!).snapshot.lease, null);
      const submitted = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.root })
        .read()
        .events.filter((event) => event.type === "execution_submitted" && event.taskId === child.taskId);
      assert.equal(submitted.length, 1);
    }
    // Duplicate process notifications must not create another leader turn.
    for (const child of resumed.workerAttempts)
      fixture.providers.find((p) => p.dispatchId === child.dispatchId)!.exit!(0);
    await fixture.cell.settlePendingMaterialization("duplicate child notifications");
    assert.equal((await fixture.status()).leaderTurns.length, 2);
    const leader = fixture.providers.find((p) => p.dispatchId === resumed.leaderTurns[1].dispatchId)!;
    assert.match(leader.prompt, /outside\.txt/u);
    // The leader carries the commander delivery contract for the CEO, not the worker delivery
    // loop; a docs-task (task-package-artifact) leader also omits repository-diff PR instructions.
    assert.match(leader.prompt, /delivery contract with the CEO/u);
    assert.equal(leader.prompt.includes(taskPrPublicationNote), false);
    assert.doesNotMatch(
      leader.prompt,
      /ha task push <task-id>|ha task pr <task-id>|task delivery commands|Do not merge/u,
    );
    await fixture.cell.settlePendingMaterialization("before public integration");
    git(fixture.root, "checkout", "-qb", "codex/mission-delivery");
    for (const head of heads) git(fixture.root, "cherry-pick", head);
    assert.equal(readFileSync(path.join(fixture.root, "src/a.txt"), "utf8"), "child 0\n");
    assert.equal(readFileSync(path.join(fixture.root, "docs/b.txt"), "utf8"), "child 1\n");
    const bare = fixture.bare;
    assert.equal(
      git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      "",
      "child settlement leaves the configured remote unpublished",
    );
    git(fixture.root, "push", "origin", "codex/mission-delivery");
    assert.equal(git(bare, "rev-parse", "refs/heads/codex/mission-delivery"), git(fixture.root, "rev-parse", "HEAD"));
    assert.equal(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/codex/squad-"), "");
    await fixture.finish(
      leader.dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Delivery\n\nIntegrated child evidence; local PR command verified.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    // dec_B3A15CC2/CH1: attribution follows the actual handoffs, not the first leader's terminal event.
    assertChildrenClosed(fixture, running.workerAttempts);
    const finalExecution = fixture.task(fixture.taskId).snapshot.executions.at(-1)!;
    assert.equal(finalExecution.actor.executor?.id, "coordinator");
    assert.notEqual(finalExecution.actor.executor?.id, `runtime-session:${planningLeader}`);
    assert.equal(
      (await fixture.cell.run({ kind: "task-release", taskId: fixture.taskId }, binding)).outcome,
      "applied",
    );
    await fixture.cell.settlePendingMaterialization("squad owner closeout");
    writeFileSync(
      path.join(fixture.root, "harness", fixture.task(fixture.taskId).packagePath!, "closeout.md"),
      `## Summary\nIntegrated child delivery ${git(fixture.root, "rev-parse", "HEAD")}.\n## Verification\nChild commits and synthesis checked.\n` +
        "## Residual Risk\nNo external PR created.\n## Same Mechanism Elsewhere\nExplicit handoff attribution.\n",
    );
    const ownerBinding = { ...binding, actor: { ...binding.actor, executor: null } };
    const settled = await fixture.cell.run({ kind: "task-settle", taskId: fixture.taskId }, ownerBinding);
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    assert.deepEqual(fixture.task(fixture.taskId).snapshot.executions.at(-1)?.actor, finalExecution.actor);
    const recoveredSubmit = await fixture.cell.run({ kind: "task-settle", taskId: fixture.taskId }, ownerBinding);
    assert.equal(recoveredSubmit.outcome, "applied", JSON.stringify(recoveredSubmit));
    assert.equal(
      recoveredSubmit.opId,
      settled.opId,
      "owner resumes the same submission without restamping the planning leader",
    );
    const launches = fixture.providers.length;
    await fixture.reopen();
    // Reopening restores the same canonical run without launching another leader.
    const recovered = await fixture.status();
    assert.equal(recovered.status, "converged");
    assert.equal(recovered.leaderTurns.length, 2);
    assert.equal(fixture.providers.length, launches, "reopening the center must not dispatch another leader");
  },
);
