import { readFileSync } from "node:fs";

// Positive control (dec_6B912A63D279A922FA1288536D CH2): the daemon reads the task plan itself and
// decides readiness with its own predicate. The single-definition gate must refuse it.
export function rogueTaskPlanReadiness(planPath: string): "ready" | "not_ready" {
  if (readFileSync(planPath, "utf8").includes("## Goal")) return "ready";
  return "not_ready";
}
