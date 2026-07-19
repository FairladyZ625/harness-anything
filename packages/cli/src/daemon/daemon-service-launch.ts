import type { LocalDaemonTarget } from "./client.ts";
import { readOption } from "../cli/parse-options.ts";
import {
  assertValidDaemonLaunchArgv,
  DaemonLaunchPreflightError,
  preflightDaemonLaunch,
  resolveDaemonLaunchSpec,
  type DaemonLaunchConfiguration
} from "./daemon-launch-spec.ts";

export function resolveAuthorityManifestOption(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  assertValidDaemonLaunchArgv(args);
  const environmentValue = env.HARNESS_AUTHORITY_MANIFEST?.trim();
  return readOption(args, "--authority-manifest") ?? (environmentValue ? environmentValue : undefined);
}

export async function prepareDaemonServiceLaunch(input: {
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly args: ReadonlyArray<string>;
  readonly target: LocalDaemonTarget;
  readonly socketPath: string;
  readonly authorityManifest?: string;
  readonly entrypoint: string;
}): Promise<DaemonLaunchConfiguration> {
  assertValidDaemonLaunchArgv(input.args);
  const restored = resolveDaemonLaunchSpec(input.target.userRoot, input.socketPath, {
    authorityManifest: input.authorityManifest,
    authoredRoot: input.layoutOverrides?.authoredRoot
  }).options;
  const launchConfiguration = currentDaemonServiceLaunchConfiguration({
    ...input,
    authorityManifest: restored.authorityManifest,
    layoutOverrides: restored.authoredRoot === undefined
      ? input.layoutOverrides
      : { ...input.layoutOverrides, authoredRoot: restored.authoredRoot }
  });
  try {
    await preflightDaemonLaunch(launchConfiguration);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (restored.authorityManifest === undefined
      && error instanceof DaemonLaunchPreflightError
      && error.code === "authority-manifest-registry-incomplete") {
      throw new Error(
        `${message}. Missing required option --authority-manifest. `
        + "Start with: ha daemon start --service --user-root <user-root> --authority-manifest <path>"
      );
    }
    throw error;
  }
  return launchConfiguration;
}

function currentDaemonServiceLaunchConfiguration(input: {
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly target: LocalDaemonTarget;
  readonly socketPath: string;
  readonly authorityManifest?: string;
  readonly entrypoint: string;
}): DaemonLaunchConfiguration {
  return {
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    entrypoint: input.entrypoint,
    args: [
      "--root",
      input.target.canonicalRoot,
      ...(input.layoutOverrides?.authoredRoot !== undefined ? ["--authored-root", input.layoutOverrides.authoredRoot] : []),
      "daemon",
      "serve",
      "--repo",
      input.target.repoId,
      "--socket",
      input.socketPath,
      "--user-root",
      input.target.userRoot,
      "--idle-ms",
      "0",
      ...(input.authorityManifest !== undefined ? ["--authority-manifest", input.authorityManifest] : [])
    ]
  };
}
