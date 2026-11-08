import { readFileSync } from "node:fs";
import { assertTransitionDocumentReady, type MarkdownDocumentContract } from "@harness-anything/kernel";

// Positive control: calling the kernel judgment does not launder a local file read. The plan bytes
// must come from the canonical read port, so this scope is a new site the baseline does not list.
export function edgePlanReadiness(planPath: string, contract: MarkdownDocumentContract): void {
  assertTransitionDocumentReady("task.plan", readFileSync(planPath, "utf8"), contract);
}
