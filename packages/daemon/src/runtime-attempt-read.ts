import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { AgentRuntimeAttemptChainDto } from "./runtime-attempt-contract.ts";
import { readTaskDispatchRow } from "./dispatch-read.ts";

/** Explicit history detail; lists and point dispatch reads never expand the attempt chain. */
export function readRuntimeAttemptChain(
  runtimeSessionId: string,
  projection: TaskProjectionQueries,
): AgentRuntimeAttemptChainDto | undefined {
  const target = projection.readRuntimeDispatchesBySession(runtimeSessionId)[0]?.event;
  if (!target?.payload.attemptGroupId) return undefined;
  const groupId = target.payload.attemptGroupId;
  return {
    attemptGroupId: groupId,
    attempts: projection
      .readRuntimeDispatchesByAttemptGroup(groupId)
      .map(({ event }) => readTaskDispatchRow(projection, event))
      .map(
        ({
          dispatchId,
          runtimeSessionId,
          attemptIndex,
          provider,
          classification,
          reason,
          faultClass,
          resetAt,
          resume,
          nextAction,
          fallbackState,
          lifecycle,
          nextDispatchId,
        }) => ({
          dispatchId,
          runtimeSessionId,
          attemptIndex,
          provider,
          classification,
          reason,
          ...(faultClass ? { faultClass } : {}),
          ...(resetAt ? { resetAt } : {}),
          ...(resume ? { resume } : {}),
          ...(nextAction ? { nextAction } : {}),
          fallbackState,
          lifecycle,
          nextDispatchId,
        }),
      )
      .sort((a, b) => a.attemptIndex - b.attemptIndex),
  };
}
