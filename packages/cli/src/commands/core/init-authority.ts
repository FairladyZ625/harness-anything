import { existsSync } from "node:fs";
import path from "node:path";
import {
  enrollAuthorityRepo,
  loadAuthorityProductionManifest
} from "@harness-anything/daemon";
import { registerDaemonRepo } from "@harness-anything/kernel";

export type InitAuthorityBootstrapReport =
  | {
    readonly schema: "init-authority-bootstrap/v1";
    readonly repoId: string;
    readonly peoplePath: "harness/people.yaml";
    readonly machinePeoplePath: string;
    readonly manifestPath: string;
    readonly keyRegistryPath: string;
    readonly keyStateDirectory: string;
    readonly serviceStateRoot: string;
    readonly daemonRegistryPath: string;
    readonly enrollment: "created" | "existing";
  }
  | {
    readonly schema: "init-authority-bootstrap/skipped";
    readonly reason: string;
  };

export function bootstrapInitAuthority(input: {
  readonly rootDir: string;
  readonly userRoot: string;
  readonly machinePeoplePath: string;
}): InitAuthorityBootstrapReport {
  const initialRegistration = registerDaemonRepo({
    userRoot: input.userRoot,
    canonicalRoot: input.rootDir
  });
  const repoId = initialRegistration.repo.repoId;
  const serviceStateRoot = path.join(input.userRoot, "authority-service-state");
  const manifestPath = path.join(serviceStateRoot, "authority-production.json");
  const existing = existsSync(manifestPath)
    ? loadAuthorityProductionManifest(manifestPath).repos.find((repo) => repo.canonicalRoot === initialRegistration.repo.canonicalRoot)
    : undefined;
  if (existing && existing.repoId !== repoId) {
    throw new Error(`AUTHORITY_INIT_REPO_ID_MISMATCH:${existing.repoId}:${repoId}`);
  }
  let authority;
  try {
    authority = existing ?? enrollAuthorityRepo({
      repoId,
      repoRoot: initialRegistration.repo.canonicalRoot,
      manifestPath,
      serviceStateRoot
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^AUTHORITY_(?:KEY_STORE_FORBIDDEN_ROOT|REPO_SERVICE_STATE_MUST_BE_EXTERNAL)(?::|$)/u.test(message)) {
      return {
        schema: "init-authority-bootstrap/skipped",
        reason: message
      };
    }
    throw error;
  }
  const registered = registerDaemonRepo({
    userRoot: input.userRoot,
    canonicalRoot: input.rootDir,
    repoId,
    authorityManifestPath: manifestPath
  });
  return {
    schema: "init-authority-bootstrap/v1",
    repoId,
    peoplePath: "harness/people.yaml",
    machinePeoplePath: input.machinePeoplePath,
    manifestPath: registered.repo.authorityManifestPath ?? manifestPath,
    keyRegistryPath: authority.keyRegistryPath,
    keyStateDirectory: authority.keyStateDirectory,
    serviceStateRoot,
    daemonRegistryPath: registered.registryPath,
    enrollment: existing ? "existing" : "created"
  };
}
