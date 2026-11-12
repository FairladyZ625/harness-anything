import { lifecycleSummaryFor } from "../../daemon/test/dispatch-lifecycle-read.fixtures.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";

/** Test DTOs use the kernel's policy projection, just like the daemon wire producer. */
export function lifecycleFixture(
  status: "running" | "succeeded" | "failed" | "cancelled" | "stopped" | "unknown" = "running",
): NonNullable<AgentRuntimeSessionDto["lifecycle"]> {
  return lifecycleSummaryFor({
    runtimeSessionId: "test-session",
    dispatchId: "test-dispatch",
    process: status === "running" ? "alive" : "exited",
    attemptSettled: status !== "running",
    outcome: status === "running" ? null : status,
  });
}
