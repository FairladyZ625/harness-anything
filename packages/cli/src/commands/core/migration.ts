import { Effect } from "effect";
import { runAdoptMultica, runSnapshotMultica } from "../adopt.ts";
import {
  runLegacyCopySafeDocs,
  runLegacyIndex,
  runLegacyIntakePlan,
  runLegacyScan,
  runLegacyVerify,
  runMigratePlan,
  runMigrateRun,
  runMigrateStructure,
  runMigrateVerify
} from "../migration.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type MigrationAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  {
    readonly kind:
      | "adopt-multica"
      | "snapshot-multica"
      | "migrate-plan"
      | "migrate-structure"
      | "migrate-run"
      | "migrate-verify"
      | "legacy-scan"
      | "legacy-intake-plan"
      | "legacy-copy-safe-docs"
      | "legacy-index"
      | "legacy-verify"
  }
>;

export const runMigrationCommand: CommandRunner = (_context, command) => {
  const action = command.action as MigrationAction;
  switch (action.kind) {
    case "adopt-multica":
      return runAdoptMultica(command.rootDir, action);
    case "snapshot-multica":
      return runSnapshotMultica(action);
    case "migrate-plan":
      return Effect.sync(() => runMigratePlan(command.rootDir, action));
    case "migrate-structure":
      return Effect.sync(() => runMigrateStructure(command.rootDir, action));
    case "migrate-run":
      return Effect.sync(() => runMigrateRun(command.rootDir, action));
    case "migrate-verify":
      return Effect.sync(() => runMigrateVerify(command.rootDir, action));
    case "legacy-scan":
      return Effect.sync(() => runLegacyScan(command.rootDir, action));
    case "legacy-intake-plan":
      return Effect.sync(() => runLegacyIntakePlan(command.rootDir, action));
    case "legacy-copy-safe-docs":
      return Effect.sync(() => runLegacyCopySafeDocs(command.rootDir, action));
    case "legacy-index":
      return Effect.sync(() => runLegacyIndex(command.rootDir, action));
    case "legacy-verify":
      return Effect.sync(() => runLegacyVerify(command.rootDir, action));
  }
};
