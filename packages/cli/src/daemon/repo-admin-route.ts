import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  resolveLocalDaemonEndpoint,
} from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";
import { withAutostart } from "./with-autostart.ts";

export function isRepoAdminMethod(method: string): boolean {
  return ["daemon.repo.unbind", "daemon.repo.purge", "daemon.repo.backup", "daemon.repo.restoreDrill"].includes(method);
}

export function runRepoAdminCommand(input: {
  readonly command: ThinCommand;
  readonly env: NodeJS.ProcessEnv;
  readonly request: (target: RepoAdminTarget, method: string, params: JsonObject) => Promise<JsonObject>;
  readonly launch: (target: RepoAdminTarget) => DaemonLaunchSpec;
  readonly autostartOptions: (target: RepoAdminTarget) => Parameters<typeof withAutostart>[3];
}): Promise<JsonObject> {
  const userRoot = daemonUserRoot(input.env),
    daemonId = daemonIdFromEnv(input.env),
    socketPath = resolveLocalDaemonEndpoint({
      userRoot,
      daemonId,
      env: input.env,
      repoId: input.env.HARNESS_DAEMON_REPO_ID,
      canonicalRoot: input.env.HARNESS_CANONICAL_ROOT ?? input.command.rootDir,
    }),
    target = { userRoot, daemonId, socketPath },
    { kind: _kind, ...actionParams } = input.command.action,
    params =
      input.command.method === "daemon.repo.backup" || input.command.method === "daemon.repo.restoreDrill"
        ? { rootDir: input.command.rootDir, ...actionParams }
        : actionParams;
  return withAutostart(
    () => input.request(target, input.command.method, params as JsonObject),
    () => input.launch(target),
    socketPath,
    input.autostartOptions(target),
  );
}

type RepoAdminTarget = { readonly userRoot: string; readonly daemonId: string; readonly socketPath: string };
