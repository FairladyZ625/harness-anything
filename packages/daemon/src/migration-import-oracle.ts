import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout } from "@harness-anything/kernel";
import {
  readMigrationProjectionOracleAtPath,
  isMigrationImportRecord,
  type MigrationProjectionOracle,
} from "@harness-anything/storage";
import { inspectMigrationSourceEvents, rebuildMigrationProjectionOracle } from "./migration-import-oracle-rebuild.ts";
export function readMigrationProjectionOracle(sourceRoot: string): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    databasePath = path.join(layout.localRoot, "cache", "task.sqlite"),
    inspection = inspectMigrationSourceEvents(sourceRoot);
  let oracle: MigrationProjectionOracle;
  if (!existsSync(databasePath)) oracle = rebuildMigrationProjectionOracle(sourceRoot, inspection);
  else
    try {
      oracle = {
        ...readMigrationProjectionOracleAtPath(
          sourceRoot,
          databasePath,
          "same-cut-projection",
          inspection.observations,
        ),
        normalizedRelationMigrationEntities: inspection.normalizedRelationMigrationEntities,
      };
    } catch (error) {
      if (!hasErrorCode(error, "migration_projection_oracle_cut_mismatch")) throw error;
      consumeKnownError(error);
      oracle = rebuildMigrationProjectionOracle(sourceRoot, inspection);
    }
  return overlayAgentDeclarations(sourceRoot, oracle);
}

function overlayAgentDeclarations(sourceRoot: string, oracle: MigrationProjectionOracle): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    agentsRoot = path.join(layout.authoredRoot, "agents"),
    agents = new Map(oracle.agents),
    entityKeys = new Set(oracle.entityKeys);
  let names: readonly string[];
  try {
    names = readdirSync(agentsRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    consumeKnownError(error);
    return oracle;
  }
  for (const name of names) {
    const target = path.join(agentsRoot, name),
      source = `agents/${name}`;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(target, "utf8")) as unknown;
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
    if (!isMigrationImportRecord(value) || typeof value.id !== "string") continue;
    const held = agents.get(value.id);
    agents.set(value.id, {
      agentId: value.id,
      workspaceRevision: held?.workspaceRevision ?? 0,
      value,
      sourceAnchor: {
        source,
        occurredAt: held?.sourceAnchor.occurredAt ?? statSync(target).mtime.toISOString(),
      },
    });
    entityKeys.add(`agent\0${value.id}`);
  }
  return { ...oracle, agents, entityKeys };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
