import type { ParsedCommand } from "./types.ts";

export function receiptCommandKind(action: ParsedCommand["action"]): string {
  switch (action.kind) {
    case "task-show":
      return action.view === "summary" ? "task-show" : `task-${action.view}`;
    case "session-show":
      return action.view === "summary" ? "session-show" : "session-trace";
    case "decision-transition":
      return `decision-${action.transition}`;
    case "doc-sync":
      return `doc-sync-${action.mode}`;
    case "external-snapshot":
      return `snapshot-${action.provider}`;
    case "external-list":
      return `list-${action.provider}`;
    case "preset-entrypoint":
      return `preset-${action.entrypointType}`;
    default:
      return action.kind;
  }
}
