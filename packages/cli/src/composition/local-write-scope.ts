import type { ParsedCommand } from "../cli/types.ts";

export type LocalCoordinatorScope = "migration" | "recovery" | "test-fixture";

type CliAction = ParsedCommand["action"];

/**
 * Legacy Intake and its compatibility migrations are an explicit local admin-import
 * road. Keep this list action-exact: command name prefixes do not grant local writes.
 */
export function isDeclaredLocalMigrationCommand(action: CliAction): boolean {
  switch (action.kind) {
    case "adopt-multica":
    case "migrate-plan":
    case "migrate-structure":
    case "migrate-anchors":
    case "migrate-fact-execution":
    case "migrate-retired-attribution-fields":
    case "migrate-provenance":
    case "migrate-run":
    case "migrate-verify":
    case "legacy-scan":
    case "legacy-intake-plan":
    case "legacy-copy-safe-docs":
    case "legacy-index":
    case "legacy-verify":
      return true;
    default:
      return false;
  }
}

/** Only migration actions that construct or consume a local write sink belong here. */
export function isDeclaredLocalMigrationWriteAction(action: CliAction): boolean {
  switch (action.kind) {
    case "adopt-multica":
    case "migrate-structure":
    case "migrate-anchors":
    case "migrate-fact-execution":
    case "migrate-retired-attribution-fields":
    case "migrate-provenance":
    case "migrate-run":
    case "legacy-copy-safe-docs":
      return true;
    default:
      return false;
  }
}
