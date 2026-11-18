import { readRuntimeAttemptChain } from "./runtime-attempt-read.ts";
import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readSessionGroupDispatches, readTaskDispatchSession } from "./dispatch-read.ts";

/** Share the complete dispatch/attempt joins, not just the runtime session table. */
export function repositoryRuntimeReads(
  projection: TaskProjection,
  store: Pick<CanonicalEventStore, "readContentBlob">,
  now?: () => string,
  /** Harness root holding dispatch streams; the only source of provider-reported context fill. */
  rootDir?: string,
  includeRemainingCount = false,
) {
  return makeAgentRuntimeReadModel({
    readAttemptChain: (id) => readRuntimeAttemptChain(id, projection),
    readDispatch: (taskId, dispatchId) => readTaskDispatchSession(projection, taskId, dispatchId),
    readDispatches: ({ sessions, events, shallow }) =>
      readSessionGroupDispatches({ sessions, events, projection, ...(shallow ? { shallow } : {}) }),
    projection,
    store,
    ...(rootDir === undefined ? {} : { rootDir }),
    includeRemainingCount,
    ...(now ? { now } : {}),
  });
}
