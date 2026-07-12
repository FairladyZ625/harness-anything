import { Effect } from "effect";
import { runAdoptMultica, runSnapshotMultica } from "../adopt.ts";
import {
  runLegacyCopySafeDocsEffect,
  runLegacyIndex,
  runLegacyIntakePlan,
  runLegacyScan,
  runLegacyVerify,
  runMigratePlan,
  runMigrateRunEffect,
  runMigrateStructureEffect,
  runMigrateVerify
} from "../migration.ts";
import { runMigrateAnchors } from "../anchor-backfill.ts";
import { runMigrateFactExecution } from "../fact-execution-migration.ts";
import { runMigrateAttribution } from "../attribution-backfill.ts";
import { runMigrateProvenance } from "./provenance-backfill.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type MigrationAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  {
    readonly kind:
      | "adopt-multica"
      | "snapshot-multica"
      | "migrate-plan"
      | "migrate-structure"
      | "migrate-anchors"
      | "migrate-fact-execution"
      | "migrate-attribution"
      | "migrate-provenance"
      | "migrate-run"
      | "migrate-verify"
      | "legacy-scan"
      | "legacy-intake-plan"
      | "legacy-copy-safe-docs"
      | "legacy-index"
      | "legacy-verify"
  }
>;

export const runMigrationCommand: CommandRunner = (context, command) => {
  const action = command.action as MigrationAction;
  switch (action.kind) {
    case "adopt-multica":
      return runAdoptMultica(context.layoutInput, action, context.makeWriteCoordinator);
    case "snapshot-multica":
      return runSnapshotMultica(action);
    case "migrate-plan":
      return Effect.sync(() => runMigratePlan(context.layoutInput, action));
    case "migrate-structure":
      return runMigrateStructureEffect(context.layoutInput, action, context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "legacy-migration" }));
    case "migrate-anchors":
      return runMigrateAnchors(context, context.layoutInput, action);
    case "migrate-fact-execution":
      return runMigrateFactExecution(context, context.layoutInput, action);
    case "migrate-attribution":
      return runMigrateAttribution(context, command);
    case "migrate-provenance":
      return runMigrateProvenance(context, context.layoutInput, action);
    case "migrate-run":
      return runMigrateRunEffect(context.layoutInput, action, context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "legacy-migration" }));
    case "migrate-verify":
      return Effect.sync(() => runMigrateVerify(context.layoutInput, action));
    case "legacy-scan":
      return Effect.sync(() => runLegacyScan(context.layoutInput, action));
    case "legacy-intake-plan":
      return Effect.sync(() => runLegacyIntakePlan(context.layoutInput, action));
    case "legacy-copy-safe-docs":
      return runLegacyCopySafeDocsEffect(context.layoutInput, action, context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "legacy-migration" }));
    case "legacy-index":
      return Effect.sync(() => runLegacyIndex(context.layoutInput, action));
    case "legacy-verify":
      return Effect.sync(() => runLegacyVerify(context.layoutInput, action));
  }
};
