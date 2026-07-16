/**
 * Renderer-facing daemon-status/v2 model.
 * Types come from the canonical application contract via the renderer-dto seam.
 * The main process projects lock-owner identity out before IPC; this layer only
 * consumes the renderer-safe shape (lock.path only).
 */

import type {
  DaemonActiveControlStatus,
  DaemonBuildStatus,
  DaemonControlKind,
  DaemonQueueStatus,
  DaemonReconcileErrorStatus,
  DaemonRendererRepoStatus,
  DaemonRendererStatusV2
} from "../../api/renderer-dto.ts";

export const DAEMON_STATUS_SCHEMA = "daemon-status/v2" as const;

export type DaemonRepoState = DaemonRendererRepoStatus["state"];
export type { DaemonControlKind };
export type DaemonControlPhase = DaemonActiveControlStatus["phase"];
export type DaemonQueueLanes = DaemonQueueStatus;
export type DaemonLockInfo = DaemonRendererRepoStatus["lock"];
export type DaemonConnections = DaemonRendererStatusV2["service"]["connections"];
export type DaemonBuildInfo = DaemonBuildStatus;
export type DaemonReconcileError = DaemonReconcileErrorStatus;
export type DaemonActiveControl = DaemonActiveControlStatus;
export type DaemonServiceStatus = DaemonRendererStatusV2["service"];
export type DaemonRepoStatus = DaemonRendererRepoStatus;
export type DaemonStatusModel = DaemonRendererStatusV2;

/** Rows for the per-repo table — always `repos[]` in v2. */
export function daemonRepoRows(status: DaemonStatusModel): ReadonlyArray<DaemonRepoStatus> {
  return status.repos;
}
