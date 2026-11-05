import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

/** A real submitted, review-exempt cut in the caller's disposable GUI fixture. */
export async function prepareGuiReworkCut(fixture) {
  const taskId = "task-gui-rework",
    title = "本轮安排 GUI 验收",
    executionId = "execution-gui-rework";
  const run = async (action) => {
    const receipt = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      { repo: { repoId: fixture.repoId }, payload: { action } },
      1000,
      30000,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    return receipt;
  };
  const created = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.task.create",
    {
      repo: { repoId: fixture.repoId },
      payload: { taskId, title, presetId: "standard-task", riskTier: "low" },
    },
    1000,
    30000,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const visible = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.task.read",
    {
      repo: { repoId: fixture.repoId },
      payload: {
        action: {
          kind: "receipt-show",
          opId: created.opId,
          waitFor: ["git_verified", "worktree_visible"],
          timeoutMs: 5000,
        },
      },
    },
    1000,
    10000,
  );
  assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible));
  await realizeTaskPlanFixture(
    fixture.rootDir,
    created.packagePath,
    (planPath) => run({ kind: "doc-submit", paths: [planPath] }),
    title,
  );
  writeFileSync(
    path.join(fixture.rootDir, "harness", created.packagePath, "closeout.md"),
    "# Closeout\n\n## Summary\n\nA real GUI cut for arranging one returned round.\n\n## Verification\n\nThe isolated GUI bridge checks the canonical target and arrangement receipt.\n\n## Residual Risk\n\nThis fixture never publishes externally.\n\n## Same Mechanism Elsewhere\n\nOne owner intent must name the submitted cut it acts on.\n",
  );
  await run({ kind: "task-start", taskId, executionId });
  writeFileSync(path.join(fixture.rootDir, "gui-rework-delivery.txt"), "An isolated delivery for GUI takeover.\n");
  execFileSync("git", ["-C", fixture.rootDir, "add", "gui-rework-delivery.txt"]);
  execFileSync(
    "git",
    [
      "-C",
      fixture.rootDir,
      "-c",
      "user.name=GUI Fixture",
      "-c",
      "user.email=gui-fixture@example.invalid",
      "commit",
      "-m",
      "test: submit GUI rework fixture",
    ],
    { stdio: "pipe" },
  );
  const commitSha = execFileSync("git", ["-C", fixture.rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await run({ kind: "task-submit", taskId, executionId, commitSha });
  return { taskId, executionId, title, packagePath: created.packagePath };
}
