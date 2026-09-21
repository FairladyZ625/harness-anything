import type { ScheduleRunOutcome } from "@harness-anything/kernel";
import type { RuntimeExitOutcome } from "./runtime-provider-fault.ts";

const outcomeProtocol = [
  "# Schedule outcome protocol",
  "Your final response's last non-empty line must be exactly one of:",
  "HARNESS-OUTCOME: succeeded",
  "HARNESS-OUTCOME: failed",
].join("\n");

export function scheduleMissionWithOutcomeProtocol(mission: string): string {
  return `${mission.trimEnd()}\n\n${outcomeProtocol}`;
}

export function scheduleOutcomeFromRuntime(
  runtimeOutcome: RuntimeExitOutcome,
  finalText: string | null,
): ScheduleRunOutcome {
  if (runtimeOutcome !== "succeeded") return runtimeOutcome;
  const lastNonEmptyLine = finalText?.split(/\r?\n/u).findLast((line) => line.trim().length > 0);
  if (lastNonEmptyLine === "HARNESS-OUTCOME: succeeded") return "succeeded";
  if (lastNonEmptyLine === "HARNESS-OUTCOME: failed") return "failed";
  return "unknown";
}
