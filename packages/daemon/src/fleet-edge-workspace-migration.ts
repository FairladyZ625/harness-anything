import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { oidcCenterSelections } from "./oidc-center-selection.ts";

/** Relocate only edge-owned paths that were rooted in the old workspace's join layout. */
export function migrateFleetEdgeWorkspace(oldRoot: string, newRoot: string, repoId: string, userRoot?: string): void {
  const sourceRoot = path.resolve(oldRoot),
    targetRoot = path.resolve(newRoot);
  if (sourceRoot === targetRoot) return;
  const config = readFleetEdgeConfig(targetRoot);
  if (!config) return;
  if (config.repoId !== repoId)
    throw codedError(
      "fleet_edge_config_missing",
      `Workspace ${targetRoot} has no matching fleet-edge.json for repository ${repoId}. Restore the edge config, then retry the root update.`,
    );
  const selection =
    userRoot === undefined
      ? undefined
      : oidcCenterSelections(userRoot).read(sourceRoot, {
          repoId: config.repoId,
          host: config.host,
          port: config.port,
          caPath: config.caPath,
          ...(config.servername ? { servername: config.servername } : {}),
        });

  const relocatedCaPath = relocateAbsolutePath(config.caPath, sourceRoot, targetRoot),
    caPath = relocatedCaPath ?? config.caPath,
    oldDefaultViewRoot = `${sourceRoot}-view`,
    newDefaultViewRoot = `${targetRoot}-view`,
    relocatedWorkspaceView = relocateAbsolutePath(config.viewRoot, sourceRoot, targetRoot),
    relocatedDefaultView = relocateAbsolutePath(config.viewRoot, oldDefaultViewRoot, newDefaultViewRoot),
    viewRoot = relocatedWorkspaceView ?? relocatedDefaultView ?? config.viewRoot;

  if (relocatedCaPath !== null && !existsSync(relocatedCaPath))
    throw codedError(
      "fleet_edge_ca_unavailable",
      `The migrated edge CA file is missing at ${caPath}; restore it in the new workspace, then retry the root update.`,
    );
  const moveView = relocatedDefaultView !== null;
  if (moveView) moveDefaultView(oldDefaultViewRoot, newDefaultViewRoot);
  if (relocatedCaPath !== null || viewRoot !== config.viewRoot) {
    try {
      writeFleetEdgeConfig(targetRoot, { ...config, caPath, viewRoot });
    } catch (error) {
      if (moveView && existsSync(newDefaultViewRoot) && !existsSync(oldDefaultViewRoot))
        /* @gate-identity state-store/task.replica-view-relocation */ renameSync(
          newDefaultViewRoot,
          oldDefaultViewRoot,
        );
      throw error;
    }
  }
  if (selection !== undefined && userRoot !== undefined) oidcCenterSelections(userRoot).write(targetRoot, selection);
}

function relocateAbsolutePath(value: string, sourceRoot: string, targetRoot: string): string | null {
  if (!path.isAbsolute(value)) return null;
  const resolved = path.resolve(value),
    relative = path.relative(sourceRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative === "" ? targetRoot : path.join(targetRoot, relative);
}

function moveDefaultView(source: string, target: string): void {
  const sourceExists = existsSync(source),
    targetExists = existsSync(target);
  if (!sourceExists) return;
  if (targetExists)
    throw codedError(
      "fleet_edge_migration_conflict",
      `Both replica directories exist at ${source} and ${target}; resolve the duplicate mirror data, then retry the root update.`,
    );
  /* @gate-identity state-store/task.replica-view-relocation */ renameSync(source, target);
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
