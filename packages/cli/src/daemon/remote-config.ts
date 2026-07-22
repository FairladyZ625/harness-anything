import { createHarnessRuntimeContext, type HarnessLayoutOverrides } from "@harness-anything/kernel";
import type { ProjectHarnessDaemonRemoteSettings } from "../commands/project-settings-identity.ts";
import { readUserHarnessSettings, type ProjectHarnessSettings } from "../commands/settings.ts";

export interface RemoteDaemonConfig {
  readonly host: string;
  readonly remoteHaPath: string;
  readonly remoteRoot: string;
  readonly repoId: string;
}

/**
 * Resolves the remote connection from three layers so a configured checkout
 * needs no exported environment at all: the environment stays the operational
 * override, personal settings carry what differs per operator (their own
 * ~/.ssh/config alias), and the shared project file carries what the whole
 * team points at. Every layer is optional; only the resolved result has to be
 * complete.
 */
export function readRemoteConfig(
  env: NodeJS.ProcessEnv,
  rootDir: string,
  projectSettings: ProjectHarnessSettings | undefined,
  layoutOverrides?: HarnessLayoutOverrides
): RemoteDaemonConfig {
  const shared = projectSettings?.daemon?.remote;
  const personal = readUserDaemonRemoteSettings(rootDir, layoutOverrides);
  return {
    host: requiredRemoteSetting(
      [env.HARNESS_DAEMON_SSH_HOST, personal?.host, shared?.host],
      "HARNESS_DAEMON_SSH_HOST",
      "host"
    ),
    remoteHaPath: firstConfigured([env.HARNESS_DAEMON_REMOTE_HA, personal?.haPath, shared?.haPath]) ?? "ha",
    remoteRoot: requiredRemoteSetting(
      [env.HARNESS_DAEMON_REMOTE_ROOT, personal?.root, shared?.root],
      "HARNESS_DAEMON_REMOTE_ROOT",
      "root"
    ),
    repoId: firstConfigured([env.HARNESS_DAEMON_REPO_ID, personal?.repoId, shared?.repoId]) ?? "canonical"
  };
}

export function remoteDaemonSshArgs(remote: RemoteDaemonConfig): ReadonlyArray<string> {
  return [remote.host, remote.remoteHaPath, "daemon", "connect", "--stdio"];
}

export function remoteDaemonUnavailableHint(remote: RemoteDaemonConfig): string {
  return `Remote daemon unavailable. Start the persistent daemon on ${remote.host} with '${remote.remoteHaPath} daemon start --service' and verify '${remote.remoteHaPath} daemon status'.`;
}

function readUserDaemonRemoteSettings(
  rootDir: string,
  layoutOverrides?: HarnessLayoutOverrides
): ProjectHarnessDaemonRemoteSettings | undefined {
  const settings = readUserHarnessSettings(createHarnessRuntimeContext(rootDir, layoutOverrides), "daemon-client-mode");
  if (!settings.ok) throw new Error(settings.result.error?.hint ?? "Personal daemon settings are invalid.");
  return settings.settings.daemonRemote;
}

function firstConfigured(candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

function requiredRemoteSetting(candidates: ReadonlyArray<string | undefined>, envName: string, field: string): string {
  const value = firstConfigured(candidates);
  if (value !== undefined) return value;
  throw new Error(
    `Remote daemon ${field} is not configured. Set settings.daemon.remote.${field} in harness/harness.yaml, ` +
    `daemon.remote.${field} in .harness/user-settings.json, or export ${envName}.`
  );
}
