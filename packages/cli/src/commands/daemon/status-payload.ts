import type { DaemonStatusResultV2 } from "@harness-anything/application";
export type { DaemonConnectionStats, DaemonStatusRuntimeRepo } from "@harness-anything/daemon";
export { daemonStatusPayload } from "@harness-anything/daemon";

/** CLI presentation projection; the daemon owns construction of the service status DTO. */
export function daemonStatusCliProjection(status: DaemonStatusResultV2): Record<string, unknown> {
  return {
    ...status,
    ...status.service,
    version: status.service.build.version,
    protocolVersion: 1,
    rootDir: status.requestedRepo.canonicalRoot,
    repoId: status.requestedRepo.repoId,
    lock: status.requestedRepo.lock,
    lockPath: status.requestedRepo.lock.path,
    lockOwnerToken: status.requestedRepo.lock.ownerToken,
    queueDepth: status.service.queue.depth,
    repos: status.repos.map((repo) => ({
      ...repo,
      lockPath: repo.lock.path,
      lockOwnerToken: repo.lock.ownerToken
    }))
  };
}
