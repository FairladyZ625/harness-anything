import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
} from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";
import { withAutostart } from "./with-autostart.ts";

export function runRepoAdminCommand(input: {
  readonly command: ThinCommand;
  readonly env: NodeJS.ProcessEnv;
  readonly request: (target: RepoAdminTarget, method: string, params: JsonObject) => Promise<JsonObject>;
  readonly launch: (target: RepoAdminTarget) => DaemonLaunchSpec;
  readonly autostartOptions: (target: RepoAdminTarget) => Parameters<typeof withAutostart>[3];
}): Promise<JsonObject> {
  const userRoot = daemonUserRoot(input.env),
    daemonId = daemonIdFromEnv(input.env),
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    target = { userRoot, daemonId, socketPath },
    { kind: _kind, ...params } = input.command.action;
  return withAutostart(
    () => input.request(target, input.command.method, params as JsonObject),
    () => input.launch(target),
    socketPath,
    input.autostartOptions(target),
  );
}

type RepoAdminTarget = { readonly userRoot: string; readonly daemonId: string; readonly socketPath: string };
