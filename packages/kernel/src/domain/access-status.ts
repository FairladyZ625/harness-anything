// dec_499E4E98A3D4754132B3BCA1E6: shared vocabulary authority; no transitions or persistence.
export const permissionRequestStateWords = ["pending", "approved", "rejected", "withdrawn"] as const;
export type PermissionRequestState = (typeof permissionRequestStateWords)[number];

export const accessReceiptPhaseWords = ["intent", "settled"] as const;
export type AccessReceiptPhase = (typeof accessReceiptPhaseWords)[number];

export const accessReceiptOutcomeWords = ["applied", "failed", "version_conflict"] as const;
export type AccessReceiptOutcome = (typeof accessReceiptOutcomeWords)[number];

export const edgeJoinStateWords = ["pending", "consumed", "expired", "revoked"] as const;
export type EdgeJoinState = (typeof edgeJoinStateWords)[number];

export const edgeJoinTunnelStateWords = ["connecting", "connected", "reconnecting", "stopped"] as const;
export type EdgeJoinTunnelState = (typeof edgeJoinTunnelStateWords)[number];

export const authorizationNodeStateWords = ["active", "paused", "removed"] as const;
export type AuthorizationNodeState = (typeof authorizationNodeStateWords)[number];

export const edgeJoinSyncStateWords = ["synced", "partial"] as const;
export type EdgeJoinSyncState = (typeof edgeJoinSyncStateWords)[number];

export const edgeJoinRepositoryPhaseWords = ["workspace", "register", "sync", "synced", "failed"] as const;
export type EdgeJoinRepositoryPhase = (typeof edgeJoinRepositoryPhaseWords)[number];

export type LegacyRoleMigrationOutcome = Exclude<AccessReceiptOutcome, "version_conflict">;

export const legacyRoleGrantOutcomeWords = ["written", "already_present", "skipped"] as const;
export type LegacyRoleGrantOutcome = (typeof legacyRoleGrantOutcomeWords)[number];

export const replicaSyncPhaseWords = [
  "preparing_replica",
  "authorizing",
  "waiting_backup",
  "backup_queued",
  "building_backup",
  "waiting_shared_backup",
  "sending_backup",
  "sending_commits",
  "awaiting_ack",
  "waiting_for_commit",
  "waiting_socket_drain",
] as const;
export type ReplicaSyncPhase = (typeof replicaSyncPhaseWords)[number];

export const fleetConflictStateWords = ["staged", "resolved"] as const;
export type FleetConflictState = (typeof fleetConflictStateWords)[number];

export const fleetMirrorApplyOutcomeWords = ["applied", "pull_blocked", "no_view"] as const;
export type FleetMirrorApplyOutcome = (typeof fleetMirrorApplyOutcomeWords)[number];

export const fleetLinkStateWords = ["fresh", "lag", "unsynced"] as const;
export type FleetLinkState = (typeof fleetLinkStateWords)[number];
