// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { createRuntimeFixture, published, run } from "./runtime-cli.fixtures.ts";

// CEO ruling 2026-10-11 (task_603cb40efa645d06812b1df7ba goal 5): a work whose subtask started
// presents active through the kernel's single presentation-status derivation — the same read model
// `ha work list` and the GUI overview consume. The root's own event status stays planned (its
// completion stays explicit); only the presented status derives from the subtree.
test("ha work list presents a planned work as active once a subtask starts", async (context) => {
  const { root, env } = createRuntimeFixture(context);
  gitRepository(root);
  const decisionProposal = run(root, env, [
      "decision",
      "propose",
      "--json-input",
      JSON.stringify({
        title: "Work status fixture direction",
        question: "Should the work status fixture be anchored to an accepted direction?",
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["cli"], productLines: [] },
        chosen: [{ id: "CH1", text: "Anchor the fixture work to its accepted direction" }],
        rejected: [{ id: "RJ1", text: "Leave the fixture work unlinked", whyNot: "The root would have no source" }],
        claims: [],
        fulfillments: [],
      }),
      "--body",
      "# Work status fixture direction\n\n## Background\n\nThe fixture exercises derived work presentation.\n\n## Tradeoffs\n\nAn accepted direction keeps the root's source inspectable.\n\n## Conclusion\n\nAnchor the fixture work to the accepted direction.\n",
    ]),
    decisionId = String((JSON.parse(String(decisionProposal.evidence)) as { readonly decisionId: string }).decisionId);
  assert.equal(decisionProposal.outcome, "applied", JSON.stringify(decisionProposal));
  const acceptedDecision = run(root, env, [
    "decision",
    "accept",
    decisionId,
    "--rationale",
    "The fixture records an effective work direction.",
    "--judgment-only",
    "The fixture only needs an accepted direction for its work root.",
  ]);
  assert.equal(acceptedDecision.outcome, "applied", JSON.stringify(acceptedDecision));
  const seed = (taskId: string, title: string, extra: readonly string[] = []) => {
    const created = run(root, env, ["task", "create", "--id", taskId, "--admin", "--title", title, ...extra]),
      packagePath = String(created.packagePath);
    published(root, env, created);
    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedTaskPlan(title));
    run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    return taskId;
  };
  const work = seed("task-work-status-root", "工作状态派生验收", ["--task-class", "work", "--decision", decisionId]);
  seed("task-work-status-slice", "切片一", ["--work", work]);
  const statusOf = () => {
    const listed = run(root, env, ["work", "list", "--all"]) as unknown as {
      readonly rows: readonly { readonly taskId: string; readonly status: string }[];
    };
    return listed.rows.find((row) => row.taskId === work)!.status;
  };
  assert.equal(statusOf(), "planned", "a work whose members have not started stays planned");
  const started = run(root, env, ["task", "start", "task-work-status-slice", "--execution-id", "exec-work-status"]);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  assert.equal(statusOf(), "active", "a subtask start moves the presented work status to active");
  // The presentation derives active, but the root itself never runs an execution: task show reports
  // no executions and points at the subtree for completion instead of a root-level lifecycle move.
  const shown = run(root, env, ["task", "show", work]) as unknown as { readonly evidence: string };
  assert.match(String(shown.evidence), /"executions":\[\]/u, "the root runs no execution of its own");
  assert.match(
    String(shown.evidence),
    /A work root's status derives from its subtree; complete or cancel its child tasks instead/u,
  );
});

function gitRepository(repo: string): void {
  const remote = path.join(path.dirname(repo), "origin.git");
  git(path.dirname(repo), "init", "--bare", "-q", remote);
  git(repo, "config", "user.name", "Work Status Demo");
  git(repo, "config", "user.email", "work-status@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "demo\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  git(repo, "branch", "-M", "main");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
