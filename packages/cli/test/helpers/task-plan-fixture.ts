import { writeFileSync } from "node:fs";
import path from "node:path";

export function writeSubstantiveTaskPlan(rootDir: string, packagePath: string): void {
  writeFileSync(path.join(rootDir, packagePath, "task_plan.md"), [
    "# Substantive Plan",
    "",
    "Task Contract: harness-task v1",
    "",
    "## Brief",
    "",
    "Exercise the lifecycle behavior covered by this test.",
    "",
    "## Goal",
    "",
    "Produce the concrete state transition and verify its receipt.",
    "",
    "## Context",
    "",
    "Use the isolated CLI fixture and its generated task package.",
    "",
    "## Constraints",
    "",
    "Keep writes inside the temporary test root.",
    "",
    "## Checkpoint",
    "",
    "Stop if the expected lifecycle precondition cannot be established.",
    "",
    "## CI/Gate Authority Stop Condition",
    "",
    "This fixture does not modify gate authority surfaces.",
    "",
    "## Implementation Plan",
    "",
    "- Prepare the task, execute the transition, and assert the result.",
    "",
    "## Verification",
    "",
    "- Assert the command receipt and persisted task state.",
    ""
  ].join("\n"), "utf8");
}
