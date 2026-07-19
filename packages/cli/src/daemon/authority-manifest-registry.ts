import {
  projectDaemonRepoRegistration,
  readDaemonRegistry,
  registerDaemonRepo,
  type DaemonRegistry,
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
  return projectAuthorityManifestRegistry(manifestPath, userRoot).registry.repos
    .filter((repo) => repo.state === "enabled")
    .map(({ state: _state, ...repo }) => repo);
}

export function persistAuthorityManifestPointer(manifestPath: string, userRoot: string): void {
  const { manifest } = projectAuthorityManifestRegistry(manifestPath, userRoot);
  for (const repo of manifest.repos) {
    registerDaemonRepo({
      userRoot,
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      authorityManifestPath: manifestPath
    });
  }
}

function projectAuthorityManifestRegistry(manifestPath: string, userRoot: string): {
  readonly manifest: ReturnType<typeof loadAuthorityProductionManifest>;
  readonly registry: DaemonRegistry;
} {
  const manifest = loadAuthorityProductionManifest(manifestPath);
  let registry = readDaemonRegistry({ userRoot });
  for (const repo of manifest.repos) {
    registry = projectDaemonRepoRegistration(registry, {
      userRoot,
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      authorityManifestPath: manifestPath
    }).registry;
  }
  return { manifest, registry };
}
