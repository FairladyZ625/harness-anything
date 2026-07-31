import type { DaemonDeploymentStatus } from "@harness-anything/application";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  calculateDaemonArtifactIdentity,
  daemonBuildProvenanceFilename,
  resolveDaemonArtifactRoot
} from "../protocol/daemon-artifact-identity.ts";
import { captureDaemonDeploymentStatus } from "../protocol/daemon-deployment-identity.ts";

const emptyArtifactIdentity = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export interface DaemonDeploymentStatusBuild {
  readonly entrypoint: string;
  readonly loadedIdentity: string;
}

export interface DaemonBuildIdentityWitness {
  readonly read: () => { readonly loadedIdentity: string; readonly installedIdentity: string };
  readonly assertCurrent: () => void;
}

export class DaemonBuildIdentityError extends Error {
  readonly code: "DAEMON_BUILD_STALE" | "DAEMON_BUILD_IDENTITY_UNAVAILABLE";

  constructor(code: DaemonBuildIdentityError["code"], message: string) {
    super(message);
    this.name = "DaemonBuildIdentityError";
    this.code = code;
  }
}

export function createDaemonBuildIdentityWitness(
  build: DaemonDeploymentStatusBuild,
  options: {
    readonly onBlocked?: (diagnostic: DaemonBuildIdentityError) => void;
    readonly readInstalledIdentity?: () => string;
  } = {}
): DaemonBuildIdentityWitness {
  const deploymentStatus = daemonDeploymentStatusOptions(build, { requireBuildProvenance: true });
  const readInstalledIdentity = options.readInstalledIdentity ?? deploymentStatus.readInstalledIdentity;
  let blocked = false;
  const read = () => ({
    loadedIdentity: build.loadedIdentity,
    installedIdentity: readInstalledIdentity()
  });
  return {
    read,
    assertCurrent: () => {
      let identity: ReturnType<typeof read>;
      try {
        identity = read();
      } catch (error) {
        return block(new DaemonBuildIdentityError(
          "DAEMON_BUILD_IDENTITY_UNAVAILABLE",
          `DAEMON_BUILD_IDENTITY_UNAVAILABLE: Daemon cannot verify that its running code matches the current dist build (${error instanceof Error ? error.message : String(error)}); mixed-version writes are disabled. Run \`ha daemon start --service\`.`
        ));
      }
      if (identity.loadedIdentity !== identity.installedIdentity) {
        return block(new DaemonBuildIdentityError(
          "DAEMON_BUILD_STALE",
          `DAEMON_BUILD_STALE: Daemon code version ${identity.loadedIdentity} does not match current dist version ${identity.installedIdentity}; mixed-version writes are disabled. Run \`ha daemon start --service\`.`
        ));
      }
      blocked = false;
    }
  };

  function block(diagnostic: DaemonBuildIdentityError): never {
    if (!blocked) {
      blocked = true;
      options.onBlocked?.(diagnostic);
    }
    throw diagnostic;
  }
}

export function daemonDeploymentStatusOptions(
  build?: DaemonDeploymentStatusBuild,
  options: { readonly requireBuildProvenance?: boolean } = {}
): {
  readonly readInstalledIdentity: () => string;
  readonly readDeploymentStatus?: (installedIdentity: string) => DaemonDeploymentStatus;
} {
  if (!build) {
    return { readInstalledIdentity: () => emptyArtifactIdentity };
  }
  const readInstalledIdentity = options.requireBuildProvenance === true
    ? createCachedInstalledIdentityReader(build.entrypoint)
    : () => calculateDaemonArtifactIdentity(build.entrypoint).identity;
  return {
    readInstalledIdentity,
    readDeploymentStatus: (installedIdentity) => captureDaemonDeploymentStatus({
      entrypoint: build.entrypoint,
      loadedIdentity: build.loadedIdentity,
      installedIdentity,
      supervisor: process.env.HARNESS_DAEMON_SUPERVISOR
    })
  };
}

function createCachedInstalledIdentityReader(entrypoint: string): () => string {
  const artifactRoot = resolveDaemonArtifactRoot(entrypoint);
  const provenancePath = path.join(artifactRoot, daemonBuildProvenanceFilename);
  let cached: { readonly signature: string; readonly identity: string } | undefined;
  return () => {
    if (!existsSync(provenancePath)) {
      cached = undefined;
      if (path.basename(artifactRoot) === "dist") {
        throw new Error(`daemon build identity file is unavailable: ${provenancePath}`);
      }
      return calculateDaemonArtifactIdentity(entrypoint).identity;
    }
    const provenanceStat = statSync(provenancePath, { bigint: true });
    const signature = [
      provenanceStat.dev,
      provenanceStat.ino,
      provenanceStat.size,
      provenanceStat.mtimeNs
    ].join(":");
    if (cached?.signature === signature) return cached.identity;
    const document = JSON.parse(readFileSync(provenancePath, "utf8")) as unknown;
    if (!isBuildProvenance(document)) {
      cached = undefined;
      throw new Error(`invalid daemon build identity file: ${provenancePath}`);
    }
    cached = { signature, identity: document.contentFingerprint };
    return cached.identity;
  };
}

function isBuildProvenance(value: unknown): value is {
  readonly schema: "daemon-build-provenance/v1";
  readonly contentFingerprint: string;
} {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === "daemon-build-provenance/v1"
    && typeof (value as Record<string, unknown>).contentFingerprint === "string"
    && /^sha256:[0-9a-f]{64}$/u.test((value as Record<string, unknown>).contentFingerprint as string);
}
