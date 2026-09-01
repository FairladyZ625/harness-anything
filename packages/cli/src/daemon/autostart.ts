import path from "node:path";
import type { DaemonAutostartResult, DaemonStartProgress } from "../../../daemon/src/client/daemon-autostart.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
} from "../../../daemon/src/client/local-daemon-target.ts";
import { cliDaemonServeLaunch } from "./client.ts";

export async function ensureCliDaemonRunning(input: {
  readonly invokingRoot: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly launchEntry?: string;
  readonly onProgress?: (progress: DaemonStartProgress) => void;
}): Promise<DaemonAutostartResult> {
  const { ensureLocalDaemonRunning, runtimeDaemonStartRefusal } = await import(
      "../../../daemon/src/client/daemon-autostart.ts"
    ),
    refusal = runtimeDaemonStartRefusal();
  if (refusal) return { ok: false, ...refusal, attempts: 0 };
  const userRoot = path.resolve(input.userRoot ?? daemonUserRoot()),
    daemonId = input.daemonId ?? daemonIdFromEnv();
  return ensureLocalDaemonRunning({
    socketPath: input.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
    invokingRoot: input.invokingRoot,
    launch: () => cliDaemonServeLaunch(userRoot, daemonId, process.execPath, input.launchEntry),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}
