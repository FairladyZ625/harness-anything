import { taskReviewAttributionPolicy } from "@harness-anything/kernel/internal/domain/task-submission-policy.ts";
import {
  isSameExecution,
  runtimeSessionIdFromActor,
  type ActorIdentity,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";

type AttributionProjection = Pick<TaskProjectionQueries, "readEventList" | "readLeaseIntervals">;

/** An evidence index, never an authorization decision. Read only indexed descriptors, not event
 * payloads (a submission event can contain tens of thousands of artifact anchors). The event
 * writer is the actor of that ledger action, not necessarily the actor described in its prose.
 * Both center and replica task-show reads use this assembler. */
export function readTaskReviewAttribution(projection: AttributionProjection, taskId: string, sourceRevision: number) {
  const page = projection.readEventList({
      entity: `task/${taskId}`,
      limit: taskReviewAttributionPolicy.defaultValue.pageLimit,
      revisionBound: sourceRevision + 1,
    }),
    intervals = projection.readLeaseIntervals(taskId);
  return {
    schema: "task-review-attribution/v1" as const,
    taskId,
    sourceRevision,
    actions: page.rows.map((row) => {
      const actor: ActorIdentity = {
        principal: { personId: row.actor.personId },
        executor: row.actor.executorId === null ? null : { kind: "agent", id: row.actor.executorId },
      };
      // The indexed intervals are in acquired-revision order. Locate the interval covering this
      // action in O(log L); same principal alone never binds a different executor to the lease.
      let low = 0,
        high = intervals.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (intervals[middle]!.acquiredRevision <= row.revision) low = middle + 1;
        else high = middle;
      }
      const candidate = intervals[low - 1],
        lease =
          candidate &&
          (candidate.releasedRevision === null || row.revision <= candidate.releasedRevision) &&
          isSameExecution(actor, candidate.holder.actor)
            ? candidate
            : null;
      return {
        action: row.type,
        occurredAt: row.occurredAt,
        actor,
        identityConfidence: "recorded" as const,
        executionId: lease?.executionId ?? null,
        runtimeSessionId: runtimeSessionIdFromActor(actor),
        evidence: { opId: row.opId, eventId: row.eventId, revision: row.revision },
        // A lease is execution evidence, not permission to call an external service. Inspect the
        // original event/receipt and the constraints effective when the action occurred.
        authorization: {
          confidence: "unverified" as const,
          lease: lease
            ? {
                acquiredRevision: lease.acquiredRevision,
                releasedRevision: lease.releasedRevision,
                expiresAt: lease.leaseExpiresAt,
              }
            : null,
        },
      };
    }),
    page: { hasMore: page.hasMore, nextCursor: page.nextCursor },
    // Authenticated authorship of an artifact/response does not authenticate the external
    // actions it describes. No default worker or owner identity is supplied for those actions.
    externalEvidence: { identityConfidence: "unverified" as const, actor: null },
  };
}
