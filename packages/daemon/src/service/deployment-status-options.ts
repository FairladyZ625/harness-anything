import type { DaemonDeploymentStatus } from "@harness-anything/application";
import { calculateDaemonArtifactIdentity } from "../protocol/daemon-artifact-identity.ts";
import { captureDaemonDeploymentStatus } from "../protocol/daemon-deployment-identity.ts";

const emptyArtifactIdentity = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export interface DaemonDeploymentStatusBuild {
  readonly entrypoint: string;
  readonly loadedIdentity: string;
}

export function createDaemonBuildIdentityWitness(build: DaemonDeploymentStatusBuild): {
  readonly read: () => { readonly loadedIdentity: string; readonly installedIdentity: string };
  readonly assertCurrent: () => void;
} {
  const deploymentStatus = daemonDeploymentStatusOptions(build);
  const read = () => ({
    loadedIdentity: build.loadedIdentity,
    installedIdentity: deploymentStatus.readInstalledIdentity()
  });
  return {
    read,
    assertCurrent: () => {
      let identity: ReturnType<typeof read>;
      try {
        identity = read();
      } catch (error) {
        throw new Error(
          `DAEMON_BUILD_IDENTITY_UNAVAILABLE: Daemon cannot verify that its running code matches the current dist build (${error instanceof Error ? error.message : String(error)}); mixed-version writes are disabled. Run \`ha daemon start --service\`.`
        );
      }
      if (identity.loadedIdentity !== identity.installedIdentity) {
        throw new Error(
          `DAEMON_BUILD_STALE: Daemon code version ${identity.loadedIdentity} does not match current dist version ${identity.installedIdentity}; mixed-version writes are disabled. Run \`ha daemon start --service\`.`
        );
      }
    }
  };
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
