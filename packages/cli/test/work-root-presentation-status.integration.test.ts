// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { acceptedWorkDecision, openBootstrappedRepoCell } from "../../daemon/test/repo-settings.fixture.ts";
import { withPolicyGroup } from "../../daemon/test/keycloak-policy.fixtures.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { createRuntimeFixture, published, run } from "./runtime-cli.fixtures.ts";
import { installIdentities, runAsync, runMaybe, seedTask } from "./runtime-cli.fixtures.ts";

// CEO ruling 2026-10-11 (task_603cb40efa645d06812b1df7ba goal 5): a work whose subtask started
// presents active through the kernel's single presentation-status derivation — the same read model
// `ha work list` and the GUI overview consume. The root's own event status stays planned (its
// completion stays explicit); only the presented status derives from the subtree.
test("ha work list presents a planned work as active once a subtask starts", async (context) => {
  const { root, env } = createRuntimeFixture(context);
  gitRepository(root);
  assert.equal(run(root, env, ["daemon", "stop"]).ok, true);
  let decisionId: string;
  try {
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId("runtime-cli"),
      rootDir: canonicalRoot(root),
      ownerId: "work-root-presentation-status",
    });
    try {
      decisionId = await acceptedWorkDecision(
        cell,
        withPolicyGroup(
          { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const },
          "contributor",
        ),
        "work-root-presentation-status",
      );
    } finally {
      await cell.close();
    }
  } finally {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
  }
  const seed = (taskId: string, title: string, extra: readonly string[] = []) => {
    const created = run(root, env, ["task", "create", "--id", taskId, "--admin", "--title", title, ...extra]),
      packagePath = String(created.workspacePackagePath);
    published(root, env, created);
    writeFileSync(path.join(root, packagePath, "task_plan.md"), realizedTaskPlan(title));
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

test(
  "Concurrent fact writes preserve runtime progress attribution and task wait artifacts",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    installIdentities(fixture.parent, fixture.root, fixture.env);
    const { root, env } = fixture;
    const { taskId, executionId, packagePath } = seedTask(root, env, "progress");
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const concurrentProjectionReads = await Promise.all([
        ...Array.from({ length: 6 }, (_, index) =>
          runAsync(root, env, [
            "fact",
            "record",
            taskId,
            "--statement",
            `Concurrent projection observation ${String(index + 1)}`,
            "--source",
            `test:runtime-cli-concurrency:${String(index + 1)}`,
          ]),
        ),
        runAsync(root, env, [
          "agent",
          "run",
          "terra",
          "--prompt",
          `progress-middle:${taskId}`,
          "--cwd",
          ".",
          "--task",
          taskId,
          "--no-stream",
        ]),
      ]),
      factWrites = concurrentProjectionReads.slice(0, 6),
      progressResult = concurrentProjectionReads[6]!;
    assert.equal(
      factWrites.every((result) => result.status === 0 && result.receipt.outcome === "applied"),
      true,
      JSON.stringify(factWrites),
    );
    // The progress worker appends checkpoints but delivers no commit or submission, so it settles
    // unknown and its no-stream exit is 1 (F-4C182EEE); the attribution assertions below are unchanged.
    assert.equal(progressResult.status, 1, `${progressResult.stderr}\n${JSON.stringify(progressResult.receipt)}`);
    context.diagnostic(
      `projection readiness concurrency: ${JSON.stringify({ factWrites: factWrites.length, runtime: progressResult.receipt.outcome })}`,
    );
    const progressRun = progressResult.receipt,
      progressDispatchId = String((progressRun.spawn as Record<string, unknown>).dispatchId),
      shownProgress = JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence)) as {
        progress: Array<{
          actor: { executor: unknown };
          payload: { text: string; evidence: unknown[]; runtimeSessionId?: string };
        }>;
      },
      runtimeExecutor = { kind: "agent", id: `runtime-session:${progressRun.runtimeSessionId}` };
    assert.deepEqual(
      shownProgress.progress.map((event) => event.payload.text),
      ["Provider checkpoint one.", "Provider checkpoint two."],
    );
    assert.equal(
      shownProgress.progress.every((event) => event.payload.evidence.length === 1),
      true,
    );
    assert.deepEqual(
      shownProgress.progress.map((event) => event.actor.executor),
      [runtimeExecutor, runtimeExecutor],
    );
    assert.deepEqual(
      shownProgress.progress.map((event) => event.payload.runtimeSessionId),
      [progressRun.runtimeSessionId, progressRun.runtimeSessionId],
    );
    const unrelatedProgress = runMaybe(root, { ...env, HARNESS_ACTOR: "agent:unrelated-runtime" }, [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "Unrelated checkpoint.",
      "--evidence",
      "test:reports/runtime-progress.txt:unrelated",
    ]);
    assert.equal(unrelatedProgress.status, 1);
    assert.equal(unrelatedProgress.receipt.code, "progress_lease_required");
    const taskWait = runMaybe(root, env, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
    assert.equal(taskWait.status, 1, `${taskWait.stderr}\n${JSON.stringify(taskWait.receipt)}`);
    assert.equal(taskWait.receipt.outcome, "stopped");
    const waitedRow = (taskWait.receipt.dispatches as Array<Record<string, unknown>>).find(
      (row) => row.dispatchId === progressDispatchId,
    );
    assert.equal(waitedRow?.exitCode, 0);
    assert.equal(waitedRow?.dispatchPath, `${packagePath}/artifacts/dispatches/${progressDispatchId}.json`);
    assert.equal(waitedRow?.reportPath, `${packagePath}/artifacts/reports/${progressDispatchId}.md`);
  },
);
