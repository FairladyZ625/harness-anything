import { daemonAutostartRootLifetimeEnvironmentVariable } from "../lifecycle/daemon-root-lifetime.ts";

export interface DaemonServerHostTarget {
  readonly userRoot: string;
  readonly daemonId: string;
}

export function daemonServerHostEnvironment(
  base: NodeJS.ProcessEnv,
  target: DaemonServerHostTarget
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.HARNESS_DAEMON_MODE;
  delete env.HARNESS_DIRECT_WRITE_REASON;
  delete env[daemonAutostartRootLifetimeEnvironmentVariable];
  return {
    ...env,
    HARNESS_DAEMON_SERVER_HOST: "1",
    HARNESS_DAEMON_USER_ROOT: target.userRoot,
    HARNESS_DAEMON_ID: target.daemonId
  };
}
