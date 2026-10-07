import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatchSession } from "./dispatch-read.ts";

/** Share the complete dispatch/attempt joins, not just the runtime session table. */
export function repositoryRuntimeReads(
  projection: TaskProjection,
  store: Pick<CanonicalEventStore, "readContentBlob">,
  now?: () => string,
) {
  return makeAgentRuntimeReadModel({
    readAttemptChain: (id) => readRuntimeAttemptChain(id, projection),
    readDispatch: (taskId, dispatchId) => readTaskDispatchSession(projection, taskId, dispatchId),
    readDispatches: ({ sessions, events }) => readSessionGroupDispatches({ sessions, events, projection }),
    projection,
    store,
    ...(now ? { now } : {}),
  });
}
