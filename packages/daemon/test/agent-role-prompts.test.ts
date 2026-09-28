// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import { assembleAgentPrompt, assembleUnboundPrompt } from "../src/runtime-spawn-mission.ts";

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
  assert.match(prompt, /stop if that cut changes/u);
  assert.match(prompt, /Do not amend or adjudicate the target/u);
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
});

test("unbound reviewer dispatch does not inherit implementation permissions", () => {
  const prompt = assembleUnboundPrompt("Review the pinned delivery.", "reviewer");
  assert.match(prompt, /# Reviewer Role/u);
  for (const grant of writeGrants) assert.equal(prompt.includes(grant), false, grant);
});

for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} worker stops at local delivery`, () => {
    const prompt = assembleUnboundPrompt("Implement the assigned package.", role);
    assert.match(prompt, /Stop at a local commit/u);
    assert.match(prompt, /Do not push branches or open PRs/u);
    assert.match(prompt, /Squad child branches are not published at settlement/u);
    assert.doesNotMatch(prompt, /gh pr create/u);
  });

test("commander owns verified integration and PR delivery without merge authority", () => {
  const prompt = assembleUnboundPrompt("Integrate the mission.", "commander");
  assert.match(
    prompt,
    /Integrate each child branch into the task branch `<task-id>`.*preserves the child commit SHA/su,
  );
  assert.match(prompt, /Do not cherry-pick or rebase child commits/u);
  assert.match(prompt, /targeted and integration regressions.*final integrated commit/u);
  assert.match(prompt, /git push origin <task-id>/u);
  assert.match(prompt, /gh pr create.*complete bilingual PR/u);
  assert.match(prompt, /\.github\/pull_request_template\.md/u);
  assert.match(prompt, /ha task adjudicate --forward/u);
  assert.match(prompt, /Do not merge.*CEO/u);
  assert.doesNotMatch(prompt, /Stop at a local commit|runtime publishes worker/u);
  assert.doesNotMatch(prompt, /if stashing is unavoidable/u);
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
