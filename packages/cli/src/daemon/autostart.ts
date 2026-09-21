import path from "node:path";
import type { DaemonAutostartResult, DaemonStartProgress } from "@harness-anything/daemon/internal/client/daemon-autostart";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { cliDaemonServeLaunch } from "./client.ts";

export async function ensureCliDaemonRunning(input: {
  readonly invokingRoot: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly launchEntry?: string;
  readonly mode?: "serve" | "--service";
  readonly onProgress?: (progress: DaemonStartProgress) => void;
}): Promise<DaemonAutostartResult> {
  const { ensureLocalDaemonRunning, runtimeDaemonStartRefusal } = await import(
      "@harness-anything/daemon/internal/client/daemon-autostart"
    ),
    refusal = runtimeDaemonStartRefusal();
  if (refusal) return { ok: false, ...refusal, attempts: 0 };
  const userRoot = path.resolve(input.userRoot ?? daemonUserRoot()),
    daemonId = input.daemonId ?? daemonIdFromEnv();
  return ensureLocalDaemonRunning({
    socketPath: input.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
    invokingRoot: input.invokingRoot,
    launch: () => cliDaemonServeLaunch(userRoot, daemonId, process.execPath, input.launchEntry, input.mode),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}
