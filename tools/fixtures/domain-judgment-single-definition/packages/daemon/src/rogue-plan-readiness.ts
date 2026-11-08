import { readFileSync } from "node:fs";
import path from "node:path";

// Positive control (dec_6B912A63D279A922FA1288536D CH2): the daemon reads the task plan itself and
// decides readiness with its own predicate. The single-definition gate must refuse it.
export function rogueTaskPlanReadiness(authoredRoot: string): "ready" | "not_ready" {
  if (readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8").includes("## Goal")) return "ready";
  return "not_ready";
}
