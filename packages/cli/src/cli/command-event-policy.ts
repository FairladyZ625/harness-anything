import { commandSpecMap, type CommandKind } from "./command-spec/index.ts";
import type { RuntimeEventPolicy } from "./command-spec/types.ts";
import type { ParsedCommand } from "./types.ts";

export type { RuntimeEventPolicy } from "./command-spec/types.ts";

const conflictMarkerPreflightByKind = commandSpecMap((entry) => entry.eventPolicy.conflictMarkerPreflight);

const runtimeEventPolicyByKind = commandSpecMap((entry) => entry.eventPolicy.runtimeEvent);

const taskPrincipalRequiredKinds = new Set<string>([
  "status-set",
  "task-archive",
  "task-claim",
  "task-code-doc-reconcile",
  "task-complete",
  "task-delete",
  "task-release",
  "task-reopen",
  "task-review",
  "task-consent-record",
  "task-review-execution",
  "task-supersede"
]);

export function requiresConflictMarkerPreflight(action: ParsedCommand["action"] | CommandKind): boolean {
  if (typeof action !== "string" && action.kind === "task-show" && action.view === "tree") return true;
  if (typeof action !== "string" && action.kind === "doc-sync" && action.mode === "submit") return true;
  return conflictMarkerPreflightByKind[commandKind(action)];
}

export function runtimeEventPolicyForAction(action: ParsedCommand["action"] | CommandKind): RuntimeEventPolicy {
  const kind = commandKind(action);
  const policy = runtimeEventPolicyByKind[kind];
  if (policy !== "auto") return policy;
  return typeof action === "string" || !isDryRun(action) ? "auto" : "none";
}

export function taskPrincipalRequiredForAction(action: ParsedCommand["action"] | CommandKind): boolean {
  return taskPrincipalRequiredKinds.has(commandKind(action));
}

function commandKind(action: ParsedCommand["action"] | CommandKind): CommandKind {
  return (typeof action === "string" ? action : action.kind) as CommandKind;
}

function isDryRun(action: ParsedCommand["action"]): boolean {
  return "dryRun" in action && action.dryRun === true;
}
