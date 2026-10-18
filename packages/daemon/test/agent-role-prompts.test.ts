// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import { assembleAgentPrompt, assembleUnboundPrompt } from "../src/runtime-spawn-mission.ts";
import { requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";

for (const role of ["worker", "reviewer"] as const)
  test(`${role} assembled prompts route human requests through the owner under execution scope`, () => {
    const principal = {
      personId: "person-worker",
      repoId: "repo",
      runtimeSessionId: "runtime-worker",
      dispatchId: "dispatch-worker",
      taskId: "task-worker",
      executionId: "execution-worker",
      role: role === "worker" ? ("implementation" as const) : ("reviewer" as const),
      source: "local" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const request = (kind: string) => {
      const { method } = commandDescriptorForAction(kind);
      requireExecutionRequestScope(principal, method, {
        repo: { repoId: principal.repoId },
        payload:
          method === "repo.task.run" ? { action: { kind, taskId: principal.taskId } } : { taskId: principal.taskId },
      });
    };
    assert.throws(() => request("relation-relate"), { code: "execution_credential_rejected" });
    if (role === "reviewer")
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(principal, "repo.task.read", {
          repo: { repoId: principal.repoId },
          payload: { action: { kind: "decision-show", decisionId: "dec-other" } },
        }),
      );
    if (role === "worker")
      for (const kind of ["task-progress-append", "fact-record", "doc-submit"])
        assert.doesNotThrow(() => request(kind));
    else
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(principal, "repo.task.run", {
          repo: { repoId: principal.repoId },
          payload: { action: { kind: "task-review-execution", taskId: principal.taskId } },
        }),
      );

    const mission = "Report the exact acceptance request for this task.";
    const prompts = [
      assembleAgentPrompt({ id: role, name: role, instructions: "Do the work.", runtimes: [], role }, mission),
      assembleUnboundPrompt(mission, role),
    ];
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /an awaits Relation when the dispatch allows ledger writes/u);
      assert.match(prompt, /Only when the dispatch explicitly grants relation writes/u);
      assert.match(prompt, /Ledger, doc, or fact write permission does not grant relation writes/u);
      assert.match(prompt, /report the exact ask.*task progress, fact, closeout, or review report/su);
      assert.match(prompt, /owner to register the awaits Relation/u);
    }
  });

test("authorized coordinator prompts retain the conditional awaits command", () => {
  const prompt = assembleUnboundPrompt("Coordinate the task with explicit relation write permission.", "commander");
  assert.match(prompt, /Only when the dispatch explicitly grants relation writes.*ha relation relate/su);
  assert.match(prompt, /--source-ref task\/<task-id>.*--target-ref person\/<person-id> --type awaits/su);
  assert.match(prompt, /--expected-version 0/u);
  assert.match(prompt, /ha agenda/u);
});

for (const role of ["worker", "commander", "reviewer"] as const)
  test(`${role} dispatches include the host infrastructure boundary`, () => {
    const prompt = assembleAgentPrompt(
      {
        id: role,
        name: role,
        instructions: "Do the assigned work.",
        runtimes: [{ type: "codex" }],
        role,
      },
      "Run the targeted test.",
    );

    assert.match(prompt, /must not operate host virtualization, networking, or system services/u);
    assert.match(prompt, /`prlctl`, `VBoxManage`, `sudo`, `systemctl`, `ip link`, or `networksetup`/u);
    assert.match(prompt, /stop and report the blocker/u);
  });

const writeGrants = [
  "mutate only the declared execution surface",
  "stage only owned files",
  "Use the repository's configured commit identity",
  "make code changes only in the worker repository root",
  "Park uncommitted work with a temporary WIP commit",
  "Do not use `git stash` in concurrent work",
  "branch `<task-id>` in `.worktrees/<task-id>`",
  "Before handoff, rebase onto the latest default branch",
  "Leave a local conventional commit",
];

test("complete bundled reviewer prompt confines writes to its review receipt", () => {
  const reviewer = readBundledAgentDeclaration("closeout-reviewer");
  assert.ok(reviewer);
  const prompt = assembleAgentPrompt(
    { ...reviewer, prompts: ["Inspect the pinned delivery."] },
    "Review the pinned execution and report its verdict.",
    "Honor the declared completion gates.",
    [{ id: "review", sourceDir: "/skills/review", skillFile: "/skills/review/SKILL.md" }],
  );
  assert.match(prompt, /# Reviewer Role/u);
  assert.match(prompt, /code repository is read-only.*Do not modify code, stage files, create commits/u);
  assert.match(prompt, /exact review target named in the mission/u);
  assert.match(prompt, /For a Task.*pinned execution.*For a Decision.*reviewContentDigest/su);
  assert.match(prompt, /Write only the structured review report.*dispatch-assigned artifacts\/reports paths/u);
  assert.match(prompt, /For a Task use ha task review-execution; for a Decision use ha decision review/u);
  assert.match(prompt, /read the PR checks directly with the hosting-platform CLI and your own platform credentials/u);
  assert.match(prompt, /`gh pr checks <PR-number>` and `gh run view <run-id> --log-failed`/u);
  assert.match(prompt, /checks are for the pinned delivery commit/u);
  assert.match(prompt, /Pending checks are not green/u);
  assert.doesNotMatch(prompt, /ha task ci/u);
  assert.match(prompt, /stop if that cut changes/u);
  assert.match(prompt, /Do not amend or adjudicate the target/u);
  assert.doesNotMatch(prompt, /ha task push|git push/u);
  assert.match(prompt, /# Required Skills.*review: \/skills\/review\/SKILL.md/su);
  assert.match(prompt, /Honor the declared completion gates/u);
  assert.doesNotMatch(prompt, /# Implementation Permissions|# Worker Role|# Commander Context/u);
  for (const grant of writeGrants) assert.equal(prompt.includes(grant), false, grant);
});

for (const role of [undefined, "worker", "commander"] as const)
  test(`${role ?? "undeclared"} role keeps implementation permissions`, () => {
    const prompt = assembleAgentPrompt(
      { id: "implementer", name: "Implementer", instructions: "Implement the task.", runtimes: [], role },
      "Implement the bounded change.",
    );
    for (const grant of writeGrants) assert.equal(prompt.includes(grant), true, grant);
    assert.doesNotMatch(prompt, /# Reviewer Role/u);
  });

test("task-bound unbound dispatch retains worker implementation permissions", () => {
  const prompt = assembleUnboundPrompt("Implement the bounded change.");
  for (const grant of writeGrants) assert.equal(prompt.includes(grant), true, grant);
  assert.match(prompt, /# Worker Role/u);
  // The simplicity rules live in the inlined block: a worktree does not carry the repository agent entry.
  assert.match(prompt, /A fix deletes or narrows by default/u);
  assert.match(prompt, /Do not add a hash, checksum, re-validation/u);
});

test("unbound reviewer dispatch does not inherit implementation permissions", () => {
  const prompt = assembleUnboundPrompt("Review the pinned delivery.", "reviewer");
  assert.match(prompt, /# Reviewer Role/u);
  for (const grant of writeGrants) assert.equal(prompt.includes(grant), false, grant);
});

for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} worker publishes the task branch and reads platform checks directly`, () => {
    const prompt = assembleUnboundPrompt("Implement the assigned package.", role);
    assert.match(
      prompt,
      /Deliver at a local commit\. A Squad child stops there and hands its commits back to the Commander\./u,
    );
    assert.match(prompt, /Squad child branches are not published at settlement/u);
    assert.match(prompt, /ha task push <task-id>/u);
    assert.match(prompt, /ha task pr <task-id>/u);
    assert.match(prompt, /daemon pushes exactly this task's branch with the dispatch-held credential/u);
    assert.match(prompt, /do not run `git push` yourself and never push another ref/u);
    assert.match(prompt, /gh pr checks <PR-number> --watch/u);
    assert.match(prompt, /gh run view <run-id> --log-failed/u);
    assert.match(prompt, /confirm the checks are for your pushed delivery SHA/u);
    assert.match(prompt, /Pending checks are not green/u);
    assert.match(prompt, /compare the same test on\s+origin\/main's latest CI/u);
    assert.match(prompt, /main-red failures are recorded\s+in the closeout, not fixed and not waited on/u);
    assert.match(prompt, /If your platform CLI cannot read the\s+checks, report the error and mark CI unverified/u);
    assert.match(prompt, /Do not merge/u);
    assert.doesNotMatch(prompt, /ha task ci|ci\.headSha|not_started/u);
    assert.doesNotMatch(prompt, /gh pr create/u);
    assert.doesNotMatch(prompt, /git push origin/u);
  });

test("commander owns verified integration and PR delivery without merge authority", () => {
  const prompt = assembleUnboundPrompt("Integrate the mission.", "commander");
  assert.match(
    prompt,
    /Integrate each child branch into the task branch `<task-id>`.*preserves the child commit SHA/su,
  );
  assert.match(prompt, /Do not cherry-pick or rebase child commits/u);
  assert.match(prompt, /targeted and integration regressions.*final integrated commit/u);
  // The delivery loop is the same constant the Worker Role carries: the daemon holds the Git
  // credential; workers read platform checks with their own platform CLI credentials.
  assert.match(prompt, /ha task push <task-id>/u);
  assert.match(prompt, /ha task pr <task-id>/u);
  assert.match(prompt, /gh pr checks <PR-number> --watch/u);
  assert.match(prompt, /gh run view <run-id> --log-failed/u);
  assert.doesNotMatch(prompt, /ha task ci|ci\.headSha/u);
  assert.match(prompt, /daemon pushes exactly this task's branch with the dispatch-held credential/u);
  assert.match(prompt, /If your platform CLI cannot read the\s+checks, report the error and mark CI unverified/u);
  assert.match(prompt, /ha task adjudicate --forward/u);
  assert.match(prompt, /Do not merge.*CEO/u);
  assert.doesNotMatch(prompt, /git push origin/u);
  assert.doesNotMatch(prompt, /gh pr create/u);
  assert.doesNotMatch(prompt, /if stashing is unavoidable/u);
});

test("worker and commander prompts quote one identical delivery-loop block", () => {
  const delivery =
      /- A task-bound worker publishes its own delivery[\s\S]*?- Do not merge; final merge authority belongs to the CEO\./,
    workerMatch = delivery.exec(assembleUnboundPrompt("Implement the assigned package.")),
    commanderMatch = delivery.exec(assembleUnboundPrompt("Integrate the mission.", "commander"));
  assert.ok(workerMatch && commanderMatch, "both roles carry the delivery block");
  assert.equal(workerMatch![0], commanderMatch![0]);
  // The reviewer never publishes and must not see the delivery commands at all.
  assert.equal(delivery.test(assembleUnboundPrompt("Review the cut.", "reviewer")), false);
});

for (const role of [undefined, "worker", "commander"] as const)
  test(`${role ?? "undeclared"} dispatches carry the host-neutral wait discipline`, () => {
    const prompt = assembleUnboundPrompt("Dispatch and integrate.", role);
    assert.match(prompt, /`ha runtime status <id> --wait`.*`ha squad status <id> --wait`.*blocks until settlement/su);
    assert.match(
      prompt,
      /background command if your\s+host wakes you when one exits; otherwise run it in the foreground/u,
    );
    assert.match(prompt, /`ha runtime status <id> <id> --wait` \(it returns when the first settles; `--all`/u);
    assert.match(prompt, /read the dispatch report \(`ha task dispatches <task-id>`\) before acting/u);
  });

test("reviewers, who never dispatch, do not carry the wait discipline", () => {
  assert.doesNotMatch(assembleUnboundPrompt("Review the cut.", "reviewer"), /blocks until settlement/u);
});

test("commander folds child waits and leaves Squad callbacks to Harness", () => {
  const prompt = assembleUnboundPrompt("Integrate the mission.", "commander");
  assert.match(
    prompt,
    /Inside a Squad run, Harness spawns your workers and calls you back.*return the waiting decision/su,
  );
  assert.match(prompt, /wait on all of them in one `ha runtime status <id> <id> --wait`.*nextAction lists/su);
});

for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} worker hands back through the closeout sections, not a duplicate report`, () => {
    const prompt = assembleUnboundPrompt("Implement the assigned package.", role);
    assert.match(prompt, /hand-back is that package's `closeout\.md`/u);
    assert.match(prompt, /human-readable delivery, verification, residual-risk, and same-mechanism evidence/su);
    assert.match(prompt, /Do not hand-copy delivery SHA, baseline SHA, or production delta/u);
    assert.doesNotMatch(prompt, /full 40-character delivery commit SHA/u);
    assert.match(prompt, /`ha doc sync --submit --task <task-id>`/u);
    assert.match(prompt, /Do not restate it in `artifacts\/report\.md`/u);
  });

test("reviewer and commander output contracts do not take the worker closeout hand-back", () => {
  for (const role of ["reviewer", "commander"] as const)
    assert.doesNotMatch(assembleUnboundPrompt("Do the mission.", role), /closeout\.md/u, role);
});

for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} worker applies injected decision scope before stopping`, () => {
    const prompt = assembleUnboundPrompt("Implement the assigned package.", role);
    assert.match(
      prompt,
      /Before stopping at a protected surface, check the injected Decision-Derived Execution Surface/u,
    );
    assert.match(prompt, /preserve and complete negative cases.*cite the decision id.*changed gate files/su);
    assert.match(prompt, /outside it or at a hard prohibition, stop and report the exact request/u);
    assert.match(prompt, /Without that section, existing task boundaries apply/u);
  });
