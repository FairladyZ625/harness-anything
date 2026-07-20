import path from "node:path";
import type { LocalDaemonTarget } from "./local-json-rpc-client.ts";

export const daemonLaunchOptionsResolvedFlag = "--launch-options-resolved";

export interface DaemonLaunchConfiguration {
  readonly execPath: string;
  readonly execArgv: ReadonlyArray<string>;
  readonly entrypoint: string;
  readonly args: ReadonlyArray<string>;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
}

export interface DaemonLaunchConfigurationInput {
  readonly target: Pick<LocalDaemonTarget, "canonicalRoot" | "repoId" | "socketPath" | "userRoot">;
  readonly entrypoint: string;
  readonly idleExitMs: number;
  readonly execPath?: string;
  readonly execArgv?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly authoredRoot?: string;
  readonly authorityManifest?: string;
  readonly launchOptionsResolved?: boolean;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
}

export function createDaemonLaunchConfiguration(
  input: DaemonLaunchConfigurationInput
): DaemonLaunchConfiguration {
  const environmentAuthorityManifest = nonEmptyEnvironmentValue(input.env?.HARNESS_AUTHORITY_MANIFEST)
    ?? (input.env === undefined ? nonEmptyEnvironmentValue(process.env.HARNESS_AUTHORITY_MANIFEST) : undefined);
  const environmentAuthoredRoot = nonEmptyEnvironmentValue(input.env?.HARNESS_AUTHORED_ROOT)
    ?? (input.env === undefined ? nonEmptyEnvironmentValue(process.env.HARNESS_AUTHORED_ROOT) : undefined);
  const authorityManifest = input.authorityManifest
    ?? (environmentAuthorityManifest ? path.resolve(environmentAuthorityManifest) : undefined);
  const authoredRoot = input.authoredRoot
    ?? (environmentAuthoredRoot ? path.resolve(input.target.canonicalRoot, environmentAuthoredRoot) : undefined);
  return {
    execPath: input.execPath ?? process.execPath,
    execArgv: [...(input.execArgv ?? process.execArgv)],
    entrypoint: input.entrypoint,
    args: [
      "--root", input.target.canonicalRoot,
      ...(authoredRoot !== undefined ? ["--authored-root", authoredRoot] : []),
      "daemon", "serve",
      "--repo", input.target.repoId,
      "--socket", input.target.socketPath,
      "--user-root", input.target.userRoot,
      "--idle-ms", String(input.idleExitMs),
      ...(authorityManifest !== undefined ? ["--authority-manifest", authorityManifest] : []),
      ...(input.launchOptionsResolved ? [daemonLaunchOptionsResolvedFlag] : [])
    ],
    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
    ...(input.daemonGeneration !== undefined ? { daemonGeneration: input.daemonGeneration } : {})
  };
}

/** Legacy RPC/control projection is exactly the original four-key launch contract. */
export function projectDaemonLaunchConfiguration(
  configuration: DaemonLaunchConfiguration,
  includeGenerationAxes = false
): DaemonLaunchConfiguration {
  return {
    execPath: configuration.execPath,
    execArgv: [...configuration.execArgv],
    entrypoint: configuration.entrypoint,
    args: [...configuration.args],
    ...(includeGenerationAxes && configuration.machineId !== undefined
      ? { machineId: configuration.machineId } : {}),
    ...(includeGenerationAxes && configuration.daemonGeneration !== undefined
      ? { daemonGeneration: configuration.daemonGeneration } : {})
  };
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
