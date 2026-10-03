import path from "node:path";
import type { Snapshot } from "./repo-cell-types.ts";
import type { TaskWorkspaceView } from "./protocol/daemon-protocol-gui-types.ts";
import type { FleetTaskAction } from "./fleet/contract.ts";
import { pushWorkerBranch, readWorkerRemoteCommit } from "./runtime-worker-push.ts";
import { makeGitReadinessSource } from "./process-port.ts";

export type FleetDeliveryTask = Snapshot & { readonly workspace: TaskWorkspaceView | null };

export function assertFleetDeliveryHolder(
  snapshot: FleetDeliveryTask,
  input: { readonly nodeId: string; readonly personId: string; readonly executionId?: string },
): string {
  const lease = snapshot.lease;
  if (
    !lease ||
    typeof lease.source !== "object" ||
    lease.source.kind !== "node" ||
    lease.source.nodeId !== input.nodeId ||
    lease.actor.principal.personId !== input.personId ||
    (input.executionId !== undefined && lease.executionId !== input.executionId) ||
    lease.phase !== "held" ||
    Date.parse(lease.expiresAt) <= Date.now()
  )
    throw Object.assign(new Error("Delivery requires the current node, owner and execution lease."), {
      code: "lease_holder_mismatch",
    });
  return lease.executionId;
}

/** Publish before submit, with an exact remote CAS observed before the final holder read. */
export async function prepareEdgeTaskDelivery(input: {
  readonly workspaceRoot: string;
  readonly nodeId: string;

  readonly action: FleetTaskAction;
  readonly authorize: () => Promise<string>;
  readonly readTask: () => Promise<FleetDeliveryTask>;
}): Promise<FleetTaskAction> {
  const initial = await input.readTask();
  if (initial.workspace?.kind !== "worktree") return input.action;
  // A retry resumes the accepted cut through the center's existing source/actor checks.
  // It has no lease and must not publish a later, unsubmitted HEAD.
  const accepted = initial.executions.find(
    (execution) => execution.iteration === initial.task?.iteration && execution.submission !== null,
  );
  if (!initial.lease && accepted?.submission)
    return {
      ...input.action,
      executionId: input.action.executionId ?? accepted.executionId,
      commitSha: input.action.commitSha ?? accepted.submission.commitSha,
    };
  const taskId = String(input.action.taskId),
    expectedRemoteCommit = await readWorkerRemoteCommit(input.workspaceRoot, taskId),
    current = await input.readTask(),
    personId = await input.authorize(),
    executionId = assertFleetDeliveryHolder(current, {
      ...input,
      personId,
      executionId: typeof input.action.executionId === "string" ? input.action.executionId : undefined,
    }),
    cwd = path.join(input.workspaceRoot, initial.workspace.path),
    head = makeGitReadinessSource().run(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok || (input.action.commitSha !== undefined && input.action.commitSha !== head.stdout))
    throw Object.assign(new Error("Requested delivery must match the bound worker HEAD."), {
      code: "invalid_submission",
    });
  const push = await pushWorkerBranch({
    cwd,
    canonicalRoot: input.workspaceRoot,
    taskId,
    submittedCommitSha: head.stdout,
    expectedRemoteCommit,
  });
  if (!push.attempted || !push.ok)
    throw Object.assign(new Error(push.attempted ? push.detail : push.reason), { code: "delivery_publish_failed" });
  return { ...input.action, executionId, commitSha: head.stdout };
}
