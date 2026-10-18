import os from "node:os";
import path from "node:path";
import { daemonIdFromEnv, resolveLocalDaemonEndpoint } from "@harness-anything/daemon/client";

/**
 * Explicit host read surface for dispatched GUI verification. The override is deliberately
 * scoped to GUI and paired with write rejection in local-composition-root; it never changes the
 * daemon's own user root or grants the worker a write-capable client.
 */
export function guiDaemonUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.HARNESS_GUI_READONLY_DAEMON_USER_ROOT ||
      env.HARNESS_DAEMON_USER_ROOT ||
      path.join(env.HOME || os.homedir(), ".harness"),
  );
}

export function guiDaemonReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HARNESS_GUI_READONLY_DAEMON_USER_ROOT?.trim());
}

export function guiGlobalDaemonTarget(env: NodeJS.ProcessEnv = process.env) {
  const userRoot = guiDaemonUserRoot(env);
  const daemonId = daemonIdFromEnv(env);
  return { socketPath: resolveLocalDaemonEndpoint({ userRoot, daemonId, env }), userRoot, daemonId };
}
