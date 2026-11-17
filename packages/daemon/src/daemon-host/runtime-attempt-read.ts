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
      .map((row) => ({
        dispatchId: row.dispatchId,
        runtimeSessionId: row.runtimeSessionId,
        attemptIndex: row.attemptIndex,
        provider: row.provider,
        classification: row.classification,
        reason: row.reason,
        ...(row.faultClass ? { faultClass: row.faultClass } : {}),
        ...(row.resetAt ? { resetAt: row.resetAt } : {}),
        ...(row.resume ? { resume: row.resume } : {}),
        ...(row.nextAction ? { nextAction: row.nextAction } : {}),
        // Previous-version wire output only; remove 2026-12-07.
        fallbackState: row.fallbackState,
        lifecycle: row.lifecycle,
        nextDispatchId: row.nextDispatchId,
      }))
      .sort((a, b) => a.attemptIndex - b.attemptIndex),
  };
}
