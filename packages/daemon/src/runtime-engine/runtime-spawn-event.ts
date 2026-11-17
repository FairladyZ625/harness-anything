import { submissionDigest, type AgentRuntimeEventV1 } from "@harness-anything/kernel";

type DispatchPayload = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>["payload"];

export function runtimeDispatchRequestedPayload(
  base: Omit<
    DispatchPayload,
    | "resumedFromDispatchId"
    | "taskId"
    | "executionId"
    | "attemptGroupId"
    | "attemptIndex"
    | "agentId"
    | "agentName"
    | "squadId"
    | "cwd"
    | "role"
    | "reviewTarget"
  >,
  context: {
    readonly resumedFromDispatchId?: string;
    readonly taskBinding?: { readonly taskId: string; readonly executionId: string };
    readonly attemptGroupId: string;
    readonly attemptIndex: number;
    readonly agent?: { readonly id: string; readonly name: string };
    readonly squadId?: string;
    readonly cwd: string;
    readonly role?: string;
    readonly decisionReviewTarget?: DispatchPayload["reviewTarget"];
    readonly reviewerSubmission?: Parameters<typeof submissionDigest>[0];
  },
): DispatchPayload {
  const reviewTarget =
    context.decisionReviewTarget ??
    (context.reviewerSubmission && context.taskBinding
      ? {
          kind: "task" as const,
          taskId: context.taskBinding.taskId,
          executionId: context.taskBinding.executionId,
          digest: submissionDigest(context.reviewerSubmission),
        }
      : undefined);
  return {
    ...base,
    ...(context.resumedFromDispatchId ? { resumedFromDispatchId: context.resumedFromDispatchId } : {}),
    ...(context.taskBinding
      ? { taskId: context.taskBinding.taskId, executionId: context.taskBinding.executionId }
      : {}),
    attemptGroupId: context.attemptGroupId,
    attemptIndex: context.attemptIndex,
    ...(context.agent ? { agentId: context.agent.id, agentName: context.agent.name } : {}),
    ...(context.squadId ? { squadId: context.squadId } : {}),
    cwd: context.cwd,
    ...(context.role ? { role: context.role } : {}),
    ...(reviewTarget ? { reviewTarget } : {}),
  };
}
