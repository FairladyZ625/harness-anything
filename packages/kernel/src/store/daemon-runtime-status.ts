import type { DaemonRepoRuntimeStatus, DaemonRuntimeStatus } from "./daemon-runtime.ts";

export function toDaemonRuntimeStatus(status: DaemonRepoRuntimeStatus): DaemonRuntimeStatus {
  return {
    started: status.started,
    rootDir: status.rootDir,
    ...(status.lockPath ? { lockPath: status.lockPath, lockOwnerToken: status.lockOwnerToken } : {}),
    queue: status.queue,
    projectionGeneration: status.projectionGeneration,
    ...(status.lastRecovery ? { lastRecovery: status.lastRecovery } : {})
  };
}
