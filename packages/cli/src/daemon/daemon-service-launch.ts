import type { LocalDaemonTarget } from "./client.ts";
import { createDaemonLaunchConfiguration } from "@harness-anything/daemon";
import {
  DaemonLaunchPreflightError,
  preflightDaemonLaunch,
  resolveDaemonLaunchSpec,
  type DaemonLaunchConfiguration,
  type ParsedDaemonLaunchArgv
} from "./daemon-launch-spec.ts";

export async function prepareDaemonServiceLaunch(input: {
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly target: LocalDaemonTarget;
  readonly socketPath: string;
  readonly launchOptions: ParsedDaemonLaunchArgv;
  readonly entrypoint: string;
}): Promise<DaemonLaunchConfiguration> {
  const explicit = {
    ...(input.launchOptions.authorityManifest ? { authorityManifest: input.launchOptions.authorityManifest } : {}),
    ...(input.launchOptions.authoredRoot ? { authoredRoot: input.launchOptions.authoredRoot } : {})
  };
  const resolution = resolveDaemonLaunchSpec(input.target.userRoot, input.socketPath, explicit);
  const restored = resolution.options;
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
  return createDaemonLaunchConfiguration({
    target: { ...input.target, socketPath: input.socketPath },
    entrypoint: input.entrypoint,
    idleExitMs: 0,
    ...(input.layoutOverrides?.authoredRoot !== undefined
      ? { authoredRoot: input.layoutOverrides.authoredRoot }
      : {}),
    ...(input.authorityManifest !== undefined ? { authorityManifest: input.authorityManifest } : {}),
    launchOptionsResolved: true
  });
}
