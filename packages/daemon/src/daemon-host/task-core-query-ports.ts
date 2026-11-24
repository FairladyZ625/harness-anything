import path from "node:path";
import { existsSync } from "node:fs";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { localGitObjectRefStore } from "@harness-anything/storage";
import type { TaskCoreQueryPorts } from "@harness-anything/application/internal/queries/task-query-ports.ts";
import { taskLineageExecutorCandidates } from "./dispatch-read.ts";
import { readIncidentActionReceipt } from "./decision-incident-receipt.ts";
import { readReckoningAgenda } from "./reckoning-agenda-read.ts";
import { isolateDaemonTaskSnapshotRows } from "./protocol/daemon-protocol.contract.ts";
import { deliveryContainment, rebaseEquivalentDelivery } from "./task-delivery-containment.ts";
import { isLinkedWorktree, readWorktreeSetupSucceeded } from "./worktree-setup.ts";
import { readDispatchRuling } from "../runtime-engine/runtime-ruling.ts";
import { runProcessText } from "./process-port.ts";

/** Live host probes. Cloud callers omit the port object instead of using this binding. */
export const daemonTaskCoreQueryPorts: TaskCoreQueryPorts = {
  linkedWorktree: isLinkedWorktree,
  taskPlanPresent: (rootDir, packagePath) =>
    existsSync(path.join(resolveHarnessLayout(rootDir).authoredRoot, packagePath, "task_plan.md")),
  readWorktreeSetupSucceeded,
  git: {
    hasCommit: (rootDir, sha) => localGitObjectRefStore.hasCommit(rootDir, sha),
    isAncestor: (rootDir, ancestor, descendant) => localGitObjectRefStore.isAncestor(rootDir, ancestor, descendant),
    rebaseEquivalentDelivery,
    deliveryContainment,
  },
  gitDiff: (rootDir, baselineRef, commitSha) =>
    runProcessText(
      "git",
      ["diff", "--no-ext-diff", "--no-color", "--unified=3", baselineRef, commitSha, "--"],
      rootDir,
      undefined,
      10_000,
    ),
  readIncidentActionReceipt,
  readReckoningAgenda,
  readDispatchRuling,
  executorDeclarationCandidates: (projection, taskId, executionId) =>
    taskLineageExecutorCandidates({ projection, taskId, executionId }).exact.map((candidate) => candidate.executorId),
  isolateRows: isolateDaemonTaskSnapshotRows,
};
