import type { DaemonDeploymentStatus } from "@harness-anything/application";
import { calculateDaemonArtifactIdentity } from "../protocol/daemon-artifact-identity.ts";
import { captureDaemonDeploymentStatus } from "../protocol/daemon-deployment-identity.ts";

const emptyArtifactIdentity = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export interface DaemonDeploymentStatusBuild {
  readonly entrypoint: string;
  readonly loadedIdentity: string;
}

export function daemonDeploymentStatusOptions(build?: DaemonDeploymentStatusBuild): {
  readonly readInstalledIdentity: () => string;
  readonly readDeploymentStatus?: (installedIdentity: string) => DaemonDeploymentStatus;
} {
  if (!build) {
    return { readInstalledIdentity: () => emptyArtifactIdentity };
  }
  return {
    readInstalledIdentity: () => calculateDaemonArtifactIdentity(build.entrypoint).identity,
    readDeploymentStatus: (installedIdentity) => captureDaemonDeploymentStatus({
      entrypoint: build.entrypoint,
      loadedIdentity: build.loadedIdentity,
      installedIdentity,
      supervisor: process.env.HARNESS_DAEMON_SUPERVISOR
    })
  };
}
