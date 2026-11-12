import type { TaskProjection } from "@harness-anything/kernel";
import { runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

/** Publish the seeded analytics cases as canonical read-port fixtures as well as transcript data. */
export function tokenUsageProjection(
  rootDir: string,
): Pick<TaskProjection, "readRuntimeDispatchPage" | "readDispatchLifecycle"> {
  return {
    readRuntimeDispatchPage: () => ({ rows: [], nextCursor: null, done: true }),
    readDispatchLifecycle: (query) =>
      lifecycleReadForSync(
        readDispatchStreamHeaders(rootDir, true).map((header) => {
          const summary = readDispatchStreamSummary(rootDir, header.dispatchId),
            terminal = summary?.terminalOutcome?.payload;
          return {
            dispatchId: header.dispatchId,
            runtimeSessionId: header.runtimeSessionId,
            attemptSettled: summary?.process?.exited === true,
            process: summary?.process?.exited ? "exited" : "unknown",
            outcome: terminal ? runtimeSessionOutcomeFromEvidence(terminal) : "unknown",
          };
        }),
      )(query),
  };
}
