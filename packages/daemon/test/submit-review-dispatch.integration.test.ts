// harness-test-tier: integration
import { revokeTestPolicyActions, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import {
  executionId,
  fixture,
  owner,
  principal,
  reviewerExecutionBinding,
  taskId,
} from "./task-completion-review.fixture.ts";
import { reviewDispatchKey } from "../src/daemon-host/task-review-dispatch.ts";
import { dispatchStreamPath } from "../src/daemon-host/dispatch-stream.ts";

type ChildFixture = Awaited<ReturnType<typeof fixture>>;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Publish a WIP cut, then replace it locally with a different final commit the branch lacks. */
function publishSupersededWipCut(f: ChildFixture, worktree: string): { readonly wip: string; readonly frozen: string } {
  const baseline = gitIn(worktree, "rev-parse", "HEAD"),
    origin = path.join(f.root, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", origin]);
  gitIn(f.root, "remote", "add", "origin", origin);
  gitIn(f.root, "push", "-q", "origin", "main:main");
  writeFileSync(path.join(worktree, "wip.txt"), "superseded WIP cut\n");
  gitIn(worktree, "add", "wip.txt");
  gitIn(worktree, "commit", "-qm", "test: superseded WIP cut");
  const wip = gitIn(worktree, "rev-parse", "HEAD");
  gitIn(worktree, "push", "-q", "origin", `HEAD:refs/heads/${taskId}`);
  // The final cut replaces the WIP commit instead of extending it, so the two histories
  // diverge: the checkout is "behind" the published branch and holds a commit it lacks.
  gitIn(worktree, "reset", "--hard", baseline);
  writeFileSync(path.join(worktree, "final.txt"), "frozen delivery\n");
  gitIn(worktree, "add", "final.txt");
  gitIn(worktree, "commit", "-qm", "test: final frozen cut");
  return { wip, frozen: gitIn(worktree, "rev-parse", "HEAD") };
}

/** Freeze a missing reviewer so submit cannot auto-dispatch; install the real one for the manual lane. */
async function submitWithDeferredReview(f: ChildFixture): Promise<Record<string, unknown>> {
  await f.install();
  const settings = await f.runPrincipal({
    kind: "settings-update",
    roles: { defaultReviewer: "missing-reviewer" },
    dispatchKey: "freeze-missing-for-review-checkout",
  });
  assert.equal(settings.outcome, "applied", JSON.stringify(settings));
  const submitted = (await f.submit()) as Record<string, unknown>;
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  assert.equal(
    f.launches.length,
    0,
    `the missing reviewer must not launch: ${JSON.stringify(submitted.warnings ?? [])}`,
  );
  return submitted;
}

test("a low-risk submit freezes no dispatch and never launches a reviewer", { timeout: 20_000 }, async () => {
  const f = await fixture(false, true, true, false, false, {
    autoSubmit: false,
    create: { riskTier: "low" },
  });
  try {
    await f.install();
    const submitted = await f.submit(),
      next = (submitted as { readonly next?: readonly { readonly command?: string }[] }).next ?? [];
    assert.deepEqual(
      next.map((entry) => entry.command),
      [`ha task complete ${taskId}`],
      "an artifact-only low-risk submit names the one remaining step to done and has no branch to publish",
    );
    assert.equal(f.launches.length, 0, "low-risk submissions must not dispatch at submit");
    assert.equal(
      f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
      0,
      "no reviewer dispatch event may be recorded for a low-risk cut",
    );
    // The state a resuming agent reads must agree with the receipt instead of showing no next step.
    const shown = await f.run({ kind: "task-show", taskId }),
      evidence = JSON.parse(String(shown.evidence)) as {
        readonly completionBlocker: unknown;
        readonly completionNext: { readonly action?: string } | null;
      };
    assert.equal(evidence.completionBlocker, null);
    assert.equal(evidence.completionNext?.action, `ha task complete ${taskId}`);
  } finally {
    await f.close();
  }
});

test(
  "a copied reviewer declaration whose skills are absent cannot take the default seat",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    try {
      // Reproduce a repository that copied the host's enhanced closeout-reviewer: the declaration
      // names skills/self-iteration, which exists only in the host checkout. The install boundary
      // must refuse it; otherwise the automatic submit dispatch seats it and dies in the spawner.
      const installError = await f
        .run({
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "closeout-reviewer",
            name: "Copied host reviewer",
            instructions: "Review the submitted cut.",
            runtimes: [{ type: "codex", model: "review-model" }],
            instance: "review-first",
            role: "reviewer",
            skills: [{ id: "self-iteration", path: "skills/self-iteration" }],
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (installError !== null) {
        assert.equal((installError as { code?: string }).code, "agent_skill_not_found");
        assert.match(String((installError as Error).message), /skills\/self-iteration/u);
      }
      const submitted = (await f.submit()) as Record<string, unknown>,
        warnings = JSON.stringify(submitted.warnings ?? []);
      assert.doesNotMatch(
        warnings,
        /Agent skill "self-iteration" was not found/u,
        `the copied reviewer must not take the seat: ${warnings}`,
      );
      assert.equal(f.launches.length, 1, "the default reviewer starts from the bundled declaration");
      assert.match(f.launches[0]!.prompt, /closeout-reviewer/u);
    } finally {
      await f.close();
    }
  },
);

test(
  "submit automatically dispatches the accepted cut and complete never dispatches a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    try {
      await f.install();
      const submitted = (await f.submit()) as Record<string, unknown>;
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(f.launches.length, 1, "submit must dispatch the reviewer without owner forward");
      assert.equal(
        f.events().filter((event) => event.type === "execution_submitted").length,
        1,
        "the accepted submission is recorded before dispatch",
      );
      const resumed = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
      assert.equal(f.launches.length, 1, "resumed submit shares the cut dispatch identity");
      assert.match(JSON.stringify(resumed.warnings), /already holds review dispatch .*no new reviewer was dispatched/u);
      const completed = await f.complete();
      assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test("submit and amend dispatch their own frozen cuts without owner forward", { timeout: 20_000 }, async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    const reportPath = path.join(f.root, "harness", f.packagePath, "artifacts", "independent.md");
    writeFileSync(reportPath, "Corrected job=41; SQL range 0–336h.\n");
    await f.submit();
    assert.equal(f.launches.length, 1);
    const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
    writeFileSync(
      closeoutPath,
      readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
    );
    let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
    for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
      await waitForFixturePublication(f.cell(), amended.opId, owner);
      amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
    }
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.equal(f.launches.length, 2, "amend dispatches the replacement cut through the same port");
    const dispatches = f
      .events()
      .filter(
        (event) => event.type === "runtime_dispatch_requested" && !event.payload.dispatchKey.includes(":fallback:"),
      );
    assert.equal(dispatches.length, 2);
    const dispatch = dispatches[1]!;
    assert.ok(dispatch.type === "runtime_dispatch_requested");
    const read = await f
      .cell()
      .run(
        { kind: "doc-show", path: `${f.packagePath}/artifacts/independent.md`, raw: true },
        reviewerExecutionBinding(dispatch.payload.runtimeSessionId, dispatch.payload.dispatchId),
      );
    assert.equal(read.outcome, "applied", JSON.stringify(read));
    assert.equal(read.evidence, "Corrected job=41; SQL range 0–336h.\n");
    assert.match(f.launches[0]!.prompt, /ha task show.*--json/u);
    assert.doesNotMatch(
      f.launches[0]!.prompt,
      /# Living Deliverable Protocol|最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u,
      "reviewer dispatches carry no worker delivery protocols",
    );
  } finally {
    await f.close();
  }
});

test(
  "submit dispatches its reviewer when the published task branch still points at a replaced WIP commit",
  { timeout: 30_000 },
  async () => {
    // The worker's delivery order is commit → submit → push. A WIP commit pushed earlier can
    // therefore be the remote task branch's only tip while the frozen cut replaces it locally.
    // Review dispatch must not require the checkout to be behind that published branch.
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      create: { presetId: "standard-task" },
    });
    try {
      await f.install();
      const worktree = path.join(f.root, ".worktrees", taskId),
        { frozen } = publishSupersededWipCut(f, worktree),
        submitted = (await f.submit()) as Record<string, unknown>;
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(
        f.launches.length,
        1,
        `the frozen cut must dispatch one reviewer: ${JSON.stringify(submitted.warnings ?? [])}`,
      );
      assert.notEqual(f.launches[0]!.cwd, worktree, "the reviewer does not reuse the mutable task worktree");
      assert.equal(
        gitIn(f.launches[0]!.cwd, "rev-parse", "HEAD"),
        frozen,
        "the reviewer snapshot is the frozen commit",
      );
      assert.equal(gitIn(worktree, "rev-parse", "HEAD"), frozen, "the worker checkout remains untouched");
      assert.doesNotMatch(JSON.stringify(submitted.warnings ?? []), /task_worktree_diverged|is behind/u);
    } finally {
      await f.close();
    }
  },
);

test(
  "a reviewer dispatched without a task worktree is created at the frozen delivery commit",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      create: { presetId: "standard-task" },
    });
    try {
      const worktree = path.join(f.root, ".worktrees", taskId),
        { wip, frozen } = publishSupersededWipCut(f, worktree);
      await submitWithDeferredReview(f);
      // A node that takes the review over has no checkout at all, but its task branch may survive
      // at the replaced WIP cut. The branch is preserved under a new name; the checkout must still
      // be the frozen commit rather than whatever the stale branch names.
      gitIn(f.root, "worktree", "remove", "--force", worktree);
      gitIn(f.root, "branch", "-f", taskId, wip);
      const dispatched = (await f.run({
        kind: "task-dispatch-review",
        taskIds: [taskId],
        agentId: "closeout-reviewer",
      })) as Record<string, unknown>;
      assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1, JSON.stringify(dispatched));
      assert.notEqual(f.launches[0]!.cwd, worktree);
      assert.equal(
        gitIn(f.launches[0]!.cwd, "rev-parse", "HEAD"),
        frozen,
        "a fresh reviewer snapshot is created at the frozen cut",
      );
      assert.equal(gitIn(f.root, "rev-parse", `refs/heads/${taskId}`), wip, "the stale task branch is untouched");
    } finally {
      await f.close();
    }
  },
);

test("a reviewer ignores a stale worker worktree and reviews the frozen snapshot", { timeout: 30_000 }, async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    create: { presetId: "standard-task" },
  });
  try {
    const worktree = path.join(f.root, ".worktrees", taskId),
      { frozen } = publishSupersededWipCut(f, worktree);
    await submitWithDeferredReview(f);
    // Another node may still hold an old checkout of this task. The review uses an independent
    // snapshot, so it must not reject or inspect that tree.
    gitIn(worktree, "reset", "--hard", `${frozen}~1`);
    const dispatched = (await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "closeout-reviewer",
    })) as Record<string, unknown>;
    assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
    assert.equal(f.launches.length, 1, "a stale worker checkout must not block the reviewer");
    assert.equal(gitIn(f.launches[0]!.cwd, "rev-parse", "HEAD"), frozen);
    assert.notEqual(gitIn(worktree, "rev-parse", "HEAD"), frozen);
  } finally {
    await f.close();
  }
});

test("a reviewer never moves a task branch checked out by another worktree", { timeout: 30_000 }, async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    create: { presetId: "standard-task" },
  });
  try {
    const worktree = path.join(f.root, ".worktrees", taskId),
      { wip, frozen } = publishSupersededWipCut(f, worktree);
    await submitWithDeferredReview(f);
    gitIn(f.root, "worktree", "remove", "--force", worktree);
    // A peer worktree owns the task branch at the replaced WIP cut. Renaming or moving that
    // branch would rewrite the peer's symbolic HEAD and break its delivery path.
    const peer = path.join(f.root, "peer-worktree");
    gitIn(f.root, "worktree", "add", peer, taskId);
    gitIn(peer, "reset", "--hard", wip);
    const peerEntry = () => {
      const entry = gitIn(f.root, "worktree", "list", "--porcelain")
        .split("\n\n")
        .find((block) => block.startsWith(`worktree ${peer}\n`));
      assert.ok(entry, "the peer worktree is registered");
      return entry;
    };
    const peerBefore = peerEntry();
    assert.equal(gitIn(peer, "symbolic-ref", "HEAD"), `refs/heads/${taskId}`);
    assert.equal(gitIn(peer, "rev-parse", "HEAD"), wip);
    const dispatched = (await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "closeout-reviewer",
    })) as Record<string, unknown>;
    assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
    assert.equal(f.launches.length, 1, "a branch owned by another worktree must not block a reviewer");
    assert.equal(gitIn(peer, "branch", "--show-current"), taskId, "the peer keeps its branch name");
    assert.equal(gitIn(peer, "symbolic-ref", "HEAD"), `refs/heads/${taskId}`, "the peer keeps its symbolic HEAD");
    assert.equal(gitIn(peer, "rev-parse", "HEAD"), wip, "the peer keeps its HEAD commit");
    assert.equal(peerEntry(), peerBefore, "the peer worktree entry keeps its branch, HEAD and config identity");
    assert.equal(gitIn(f.launches[0]!.cwd, "rev-parse", "HEAD"), frozen);
    assert.notEqual(frozen, wip);
  } finally {
    await f.close();
  }
});

test(
  "forward's explicit reviewer overrides the cut's frozen claim and reports the argument source",
  {
    timeout: 30_000,
  },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    try {
      await f.install();
      const settings = await f.runPrincipal({
        kind: "settings-update",
        roles: { defaultReviewer: "missing-reviewer" },
        dispatchKey: "freeze-missing",
      });
      assert.equal(settings.outcome, "applied", JSON.stringify(settings));
      assert.equal((await f.submit()).outcome, "applied");
      // The frozen claim (missing-reviewer) beats the repository default at submit, so the
      // auto-dispatch fails and lands its recovery step; the explicit dispatch-review argument
      // then selects the installed reviewer (owner ruling 2026-09-21 precedence, now on the
      // one dispatch port).
      const state = (await f.cell().read("repo.tasks.list")).rows.find((row) => row.taskId === taskId);
      assert.equal(state?.snapshot.task?.status, "in_review");
      assert.equal(f.launches.length, 0);
      const selected = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.equal(selected.outcome, "applied", JSON.stringify(selected));
      assert.equal(f.launches.length, 1);
      assert.match(String(f.launches[0]!.prompt), /Independently review task/u);
    } finally {
      await f.close();
    }
  },
);

test("one reviewer per cut: a live dispatch owns the lane, and a replaced reviewer waits for its end", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    assert.equal(
      (
        await f.run({
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "alternate-reviewer",
            name: "Alternate reviewer",
            instructions: "Independently inspect the submitted cut.",
            runtimes: [{ type: "codex", model: "review-model" }],
            instance: "review-first",
            role: "reviewer",
          },
        })
      ).outcome,
      "applied",
    );
    await f.submit();
    assert.equal(f.launches.length, 1);
    // A cut holds one active reviewer: --agent cannot jump the queue while the automatic
    // reviewer's session is live (dec_E369B861 CH3 keeps dispatch-review the one port).
    const jumpQueue = (await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "alternate-reviewer",
    })) as Record<string, unknown>;
    assert.equal(jumpQueue.outcome, "op_rejected", JSON.stringify(jumpQueue));
    assert.equal(jumpQueue.code, "review_dispatch_failed", JSON.stringify(jumpQueue));
    assert.match(
      String(jumpQueue.rejectionExplanation),
      /already holds review dispatch .+ by agent closeout-reviewer/u,
    );
    assert.match(String(jumpQueue.rejectionExplanation), /after that review session ends/u);
    assert.equal(f.launches.length, 1);
    // Re-selecting the holding reviewer is idempotent on its own dispatch identity.
    const retry = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    assert.equal(f.launches.length, 1, "the retry reuses the holding reviewer's dispatch");
    // Once the automatic reviewer's session ends, the explicit selection owns the next attempt.
    const holding = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(holding?.type === "runtime_dispatch_requested");
    f.failPending();
    await f.awaitOutcome(holding.payload.runtimeSessionId);
    const selected = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "alternate-reviewer" });
    assert.equal(selected.outcome, "applied", JSON.stringify(selected));
    assert.equal(f.launches.length, 2);
    const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
    assert.deepEqual(
      dispatches.map((event) => event.payload.agentId),
      ["closeout-reviewer", "alternate-reviewer"],
    );
    assert.match(String(dispatches.at(-1)!.payload.dispatchKey), /:reviewer:alternate-reviewer$/u);
  } finally {
    await f.close();
  }
});

test("legacy base-key dispatch for an alternate reviewer is reused by reroute and dispatch-review", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "strict",
  });
  try {
    const configured = await f.runPrincipal({
      kind: "settings-update",
      roles: { defaultReviewer: "missing-reviewer" },
      dispatchKey: "freeze-missing-reviewer",
    });
    assert.equal(configured.outcome, "applied", JSON.stringify(configured));
    await f.submit();
    assert.equal(f.launches.length, 0, "the frozen reviewer is not installed, so submit has no dispatch row");
    const installed = await f.run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "alternate-reviewer",
        name: "Alternate reviewer",
        instructions: "Independently inspect the submitted cut.",
        runtimes: [{ type: "codex", model: "review-model" }],
        instance: "review-first",
        role: "reviewer",
      },
    });
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const shown = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        executions: Parameters<typeof reviewDispatchKey>[1][];
      },
      execution = shown.executions.find((item) => item.executionId === executionId);
    assert.ok(execution?.submission);
    const legacyKey = reviewDispatchKey(taskId, execution);
    const legacy = await f.cell().spawnRuntime(
      {
        agentId: "alternate-reviewer",
        role: "reviewer",
        taskId,
        executionId,
        cwd: { scope: "repo-root" },
        dispatchKey: legacyKey,
        prompt: "Review the bound submission cut.",
      },
      owner,
    );
    assert.equal(legacy.outcome, "applied", JSON.stringify(legacy));
    assert.equal(f.launches.length, 1);
    const legacyEvent = f
      .events()
      .find((event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchKey === legacyKey);
    assert.ok(legacyEvent?.type === "runtime_dispatch_requested");

    // The dispatch-review lane recognizes the live legacy dispatch and reuses its identity
    // (the manual reroute rode the same key shape before the forward command retired).
    const retry = await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "alternate-reviewer",
    });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    const step = (retry as Record<string, unknown>).dispatches as {
      outcome: string;
      dispatchId: string;
      runtimeSessionId: string;
    }[];
    assert.equal(step[0]?.outcome, "already_dispatched", JSON.stringify(step[0]));
    assert.equal(step[0]?.dispatchId, legacyEvent.payload.dispatchId);
    assert.equal(step[0]?.runtimeSessionId, legacyEvent.payload.runtimeSessionId);
    assert.equal(f.launches.length, 1, "dispatch-review must recognize the legacy key as well");

    f.failPending();
    await f.awaitOutcome(legacyEvent.payload.runtimeSessionId);
    const nextAttempt = await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "alternate-reviewer",
    });
    assert.equal(nextAttempt.outcome, "applied", JSON.stringify(nextAttempt));
    assert.equal(f.launches.length, 2, "an ended migrated dispatch advances to its next attempt");
    const nextEvent = f
      .events()
      .filter((event) => event.type === "runtime_dispatch_requested")
      .at(-1);
    assert.ok(nextEvent?.type === "runtime_dispatch_requested");
    assert.match(nextEvent.payload.dispatchKey, /:reviewer:alternate-reviewer:attempt1$/u);
  } finally {
    await f.close();
  }
});

test(
  "resumed submit keeps frozen reviewer over settings and recovers dispatch through dispatch-review",
  {
    timeout: 30_000,
  },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    try {
      await f.install();
      const settings = await f.runPrincipal({
        kind: "settings-update",
        roles: { defaultReviewer: "missing-reviewer" },
        dispatchKey: "freeze-missing",
      });
      assert.equal(settings.outcome, "applied", JSON.stringify(settings));
      assert.equal((await f.submit()).outcome, "applied");
      assert.equal(
        (
          await f.runPrincipal({
            kind: "settings-update",
            roles: { defaultReviewer: "closeout-reviewer" },
            dispatchKey: "change-default",
          })
        ).outcome,
        "applied",
      );
      const resumed = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
      assert.match(JSON.stringify(resumed), /missing-reviewer/u);
      assert.match(JSON.stringify(resumed), /already in_review/u);
      assert.match(JSON.stringify(resumed), /ha task dispatch-review task-completion-review --agent missing-reviewer/u);
      const state = (await f.cell().read("repo.tasks.list")).rows.find((row) => row.taskId === taskId);
      assert.equal(state?.snapshot.task?.status, "in_review");
      assert.equal(f.launches.length, 0);
      assert.match(JSON.stringify(resumed), /CEO/u);
      await f.reopen();
      const agenda = await f.cell().read("repo.agenda.read", {}, owner);
      assert.ok(
        agenda.attentionItems.some((row) => row.ref === `task/${taskId}` && row.kind === "needs-handling"),
        JSON.stringify(agenda),
      );
      assert.match(agenda.summary, /CEO.*ha task dispatch-review task-completion-review/u);
      const recovered = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
      assert.equal(f.launches.length, 1);
      const afterRecovery = await f.cell().read("repo.agenda.read", {}, owner);
      assert.equal(
        afterRecovery.attentionItems.some((row) => row.ref === `task/${taskId}` && row.kind === "needs-handling"),
        false,
        JSON.stringify(afterRecovery),
      );
      const retry = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.match(JSON.stringify(retry), /already_dispatched/u);
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "amending an in-review cut dispatches the reviewer for the replaced cut once, through the forward's path",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false);
    try {
      await f.install();
      assert.equal(f.launches.length, 1, "the forward dispatches the first cut's reviewer");
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
      );
      const amend = async () => {
        let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
        for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
          await waitForFixturePublication(f.cell(), amended.opId, owner);
          amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
        }
        assert.equal(amended.outcome, "applied", JSON.stringify(amended));
        return amended as Record<string, unknown>;
      };
      const amended = await amend(),
        reviewDispatches = () =>
          f
            .events()
            .filter(
              (event) =>
                event.type === "runtime_dispatch_requested" && event.payload.dispatchKey.startsWith("task-review:"),
            );
      assert.equal(f.launches.length, 2, "the amended in-review cut gets its own reviewer dispatch");
      assert.equal(reviewDispatches().length, 2);
      const step = (amended.steps as readonly Record<string, unknown>[]).at(-1)!;
      assert.equal(typeof step.dispatchId, "string", JSON.stringify(amended));
      const dispatch = reviewDispatches().at(-1)!;
      assert.ok(dispatch.type === "runtime_dispatch_requested");
      assert.ok(dispatch.payload.dispatchKey.endsWith(":reviewer:closeout-reviewer"));
      const shown = await f
        .cell()
        .run(
          { kind: "task-show", taskId },
          reviewerExecutionBinding(dispatch.payload.runtimeSessionId, dispatch.payload.dispatchId),
        );
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const execution = JSON.parse(String(shown.evidence)).executions.find(
        (candidate: { executionId: string }) => candidate.executionId === executionId,
      );
      assert.match(execution.submission.completionClaim, /Amended reviewed delivery/u);
      await amend();
      assert.equal(f.launches.length, 2, "re-amending the same cut never opens a second concurrent review");
      assert.equal(reviewDispatches().length, 2);
    } finally {
      await f.close();
    }
  },
);

/** Cancel the one reviewer the fixture launched and wait for its terminal outcome to project. */
async function cancelLiveReview(f: ChildFixture) {
  const dispatch = f
    .events()
    .findLast((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
  assert.ok(dispatch?.type === "runtime_dispatch_requested", "the fixture launched no reviewer");
  const cancelled = await f.cell().cancelRuntime({ runtimeSessionId: dispatch.payload.runtimeSessionId }, principal);
  assert.equal(cancelled.detail, "cancelled", JSON.stringify(cancelled));
  assert.equal(await f.awaitOutcome(dispatch.payload.runtimeSessionId), "cancelled");
  return dispatch;
}

test(
  "an amendment after the prior review was cancelled dispatches the replacement cut",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    try {
      await f.install();
      await f.submit();
      assert.equal(f.launches.length, 1);
      const cancelled = await cancelLiveReview(f);
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Replacement after cancelled review "),
      );
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      assert.equal(f.launches.length, 2, "the replacement cut must dispatch its own reviewer");
      const replacement = f
        .events()
        .findLast((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
      assert.ok(replacement?.type === "runtime_dispatch_requested");
      assert.notEqual(replacement.payload.runtimeSessionId, cancelled.payload.runtimeSessionId);
      assert.notEqual(replacement.payload.dispatchKey, cancelled.payload.dispatchKey);
    } finally {
      await f.close();
    }
  },
);

test(
  "an amendment whose cut is unchanged after its review was cancelled reopens the review seat",
  { timeout: 20_000 },
  async () => {
    // The T6 field path: the cancelled reviewer settles without archiving its mission/dispatch
    // documents (a lost owner stream is the deterministic local shape), so the next amendment
    // re-derives the very same cut key. The cancelled dispatch row must not be mistaken for a
    // live seat: the automatic port has to advance the attempt chain, as dispatch-review does.
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      runtimePid: 2_147_483_646,
    });
    try {
      await f.install();
      await f.submit();
      assert.equal(f.launches.length, 1);
      const dispatch = f
        .events()
        .findLast((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      rmSync(dispatchStreamPath(f.root, dispatch.payload.dispatchId), { force: true });
      await f.reopen();
      const cancelled = await f
        .cell()
        .cancelRuntime({ runtimeSessionId: dispatch.payload.runtimeSessionId }, principal);
      assert.equal(cancelled.detail, "cancelled", JSON.stringify(cancelled));
      assert.equal(await f.awaitOutcome(dispatch.payload.runtimeSessionId), "cancelled");
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      assert.equal(f.launches.length, 2, "the cancelled review seat must be reopened by the amendment");
      const replacement = f
        .events()
        .findLast((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
      assert.ok(replacement?.type === "runtime_dispatch_requested");
      assert.notEqual(replacement.payload.runtimeSessionId, dispatch.payload.runtimeSessionId);
      assert.match(String(replacement.payload.dispatchKey), /:attempt1$/u);
    } finally {
      await f.close();
    }
  },
);

test("a resumed submit of an already-reviewed cut keeps the registered review", { timeout: 30_000 }, async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    runtimePid: 2_147_483_646,
  });
  try {
    await f.install();
    await f.submit();
    const dispatch = f
      .events()
      .findLast((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    // Register under the dispatch's own report/packet paths: automatic submission artifacts
    // exclude exactly those, so the resumed cut keeps the same digest and reaches the hook.
    const { dispatchId, runtimeSessionId } = dispatch.payload,
      report = `${f.packagePath}/artifacts/reports/${dispatchId}.md`,
      packet = `${f.packagePath}/artifacts/reports/${dispatchId}.json`;
    mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
    writeFileSync(path.join(f.root, "harness", report), "# Review\n\nApproved.\n");
    writeFileSync(
      path.join(f.root, "harness", packet),
      JSON.stringify({
        verdict: "approved",
        reason: "The submitted cut was checked.",
        evidenceChecked: ["README.md"],
        findings: [],
        resolutions: [],
      }),
    );
    const reviewed = await f.cell().run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: `review-${dispatchId}`,
        fromFile: `harness/${packet}`,
      },
      withPolicyGroup(
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
          },
          source: "local",
        },
        "admin",
      ),
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    // Settle the reviewer without archiving its mission/dispatch documents, so the cut digest
    // stays unchanged and the resumed submit reaches the automatic dispatch hook.
    rmSync(dispatchStreamPath(f.root, dispatchId), { force: true });
    await f.reopen();
    const cancelled = await f.cell().cancelRuntime({ runtimeSessionId }, principal);
    assert.equal(cancelled.detail, "cancelled", JSON.stringify(cancelled));
    assert.equal(await f.awaitOutcome(runtimeSessionId), "cancelled");
    const resumed = await f.run({ kind: "task-submit", taskId, executionId });
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    assert.equal(f.launches.length, 1, "a registered review must not be replaced by another reviewer");
    assert.match(JSON.stringify(resumed.warnings), /no new reviewer was dispatched/u);
  } finally {
    await f.close();
  }
});

// Keep this last: it revokes runtime-spawn for the rest of this test file's policy realm.
test("automatic submit dispatch cannot lend its authorization decision to runtime-spawn", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    revokeTestPolicyActions(owner.actor.principal.personId, "completion-review", ["runtime-spawn"]);
    const result = await f.submit();
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    assert.equal(f.launches.length, 0, "submit remains authorized, but reviewer launch has no permission");
    assert.equal(
      f.events().some((event) => event.type === "runtime_dispatch_requested"),
      false,
    );
  } finally {
    await f.close();
  }
});
