import { execFileSync } from "node:child_process";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "task-review-closeout",
  feature: "task-review-closeout",
  lane: "isolated",
  description: "An in-review task exposes its independent review panel and canonical board column.",
  async run({ page, fixture, shot }) {
    const taskId = "task-gui-smoke",
      executionId = "execution-gui-review",
      scope = { repo: { repoId: fixture.repoId } };
    await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.start",
      { ...scope, payload: { taskId, executionId } },
      1_000,
    );
    execFileSync("git", ["add", "-A"], { cwd: fixture.rootDir });
    execFileSync("git", ["commit", "-m", "test: seed GUI review fixture"], { cwd: fixture.rootDir });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.rootDir, encoding: "utf8" }).trim();
    await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.submit",
      {
        ...scope,
        payload: {
          taskId,
          executionId,
          submission: {
            completionClaim: "GUI review panel is ready for independent judgment.",
            deliverables: ["Task review panel"],
            outputs: ["packages/gui/src/renderer/components/taskDetail/TaskReviewPanel.tsx"],
            verificationNotes: ["isolated Electron scenario"],
            knownGaps: [],
            residualRisks: [],
            commitSha,
          },
        },
      },
      1_000,
    );
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-column-in_review").waitFor();
    await page.getByTestId("board-task-card").first().waitFor();
    await shot("task-review-board");
    await page.getByTestId("board-task-card").first().click();
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByRole("tab", { name: /收口|Closeout/u }).click();
    await page.getByTestId("task-review-panel").waitFor();
    await shot("task-review-detail");
  },
};
