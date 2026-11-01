import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatchSession } from "./dispatch-read.ts";

/** Share the complete dispatch/attempt joins, not just the runtime session table. */
export function repositoryRuntimeReads(
  projection: TaskProjection,
  store: Pick<CanonicalEventStore, "readContentBlob">,
  now?: () => string,
  /** Harness root holding dispatch streams; the only source of provider-reported context fill. */
  rootDir?: string,
  activityEvidence = true,
) {
  return makeAgentRuntimeReadModel({
    readAttemptChain: (id) => readRuntimeAttemptChain(id, projection),
    readDispatch: (taskId, dispatchId) => readTaskDispatchSession(projection, taskId, dispatchId),
    readDispatches: ({ sessions, events }) => readSessionGroupDispatches({ sessions, events, projection }),
    projection,
    store,
    ...(rootDir === undefined ? {} : { rootDir }),
    activityEvidence,
    ...(now ? { now } : {}),
  });
}
