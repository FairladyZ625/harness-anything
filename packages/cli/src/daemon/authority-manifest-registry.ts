import { realpathSync } from "node:fs";
import path from "node:path";
import {
  readDaemonRegistry,
  registerDaemonRepo,
  type DaemonRegistryRepo
} from "../../../kernel/src/index.ts";
import { loadAuthorityProductionManifest } from "./authority-production-state.ts";

export type AuthorityManifestRegistryRepo = Pick<
  DaemonRegistryRepo,
  "repoId" | "canonicalRoot" | "displayName" | "authorityManifestPath"
>;

export function authorityManifestServeRepos(
  manifestPath: string,
  userRoot: string
): ReadonlyArray<AuthorityManifestRegistryRepo> {
  const manifest = loadAuthorityProductionManifest(manifestPath);
  const canonicalManifestPath = realpathSync(manifestPath);
  const registered = readDaemonRegistry({ userRoot }).repos;
  const projected: Array<AuthorityManifestRegistryRepo & { state: DaemonRegistryRepo["state"] }> = registered.map((repo) => ({
    repoId: repo.repoId,
    canonicalRoot: repo.canonicalRoot,
    displayName: repo.displayName,
    state: repo.state,
    ...(repo.authorityManifestPath ? { authorityManifestPath: repo.authorityManifestPath } : {})
  }));
  for (const manifestRepo of manifest.repos) {
    const canonicalRoot = realpathSync(manifestRepo.canonicalRoot);
    const existingByRoot = projected.find((repo) => canonicalRegistryRoot(repo.canonicalRoot) === canonicalRoot);
    if (existingByRoot) {
      if (existingByRoot.repoId !== manifestRepo.repoId) {
        throw new Error(`canonical root is already registered as repoId "${existingByRoot.repoId}"`);
      }
      const index = projected.indexOf(existingByRoot);
      projected[index] = {
        ...existingByRoot,
        displayName: path.basename(canonicalRoot),
        state: "enabled",
        authorityManifestPath: canonicalManifestPath
      };
      continue;
    }
    const conflictingRepo = projected.find((repo) => repo.repoId === manifestRepo.repoId);
    if (conflictingRepo) {
      throw new Error(`repoId "${manifestRepo.repoId}" is already registered for ${conflictingRepo.canonicalRoot}`);
    }
    projected.push({
      repoId: manifestRepo.repoId,
      canonicalRoot,
      displayName: path.basename(canonicalRoot),
      state: "enabled",
      authorityManifestPath: canonicalManifestPath
    });
  }
  return projected
    .filter((repo) => repo.state === "enabled")
    .map(({ state: _state, ...repo }) => repo);
}

export function persistAuthorityManifestPointer(manifestPath: string, userRoot: string): void {
  const manifest = loadAuthorityProductionManifest(manifestPath);
  for (const repo of manifest.repos) {
    registerDaemonRepo({
      userRoot,
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      authorityManifestPath: manifestPath
    });
  }
}

function canonicalRegistryRoot(rootDir: string): string {
  try {
    return realpathSync(rootDir);
  } catch {
    return rootDir;
  }
}
