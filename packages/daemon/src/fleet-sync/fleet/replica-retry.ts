/** Deterministic failures cannot heal by replaying the same position. Three attempts per progress cut. */
export function isDeterministicReplicaFailure(error: unknown): boolean {
  const observed = error as { readonly code?: unknown; readonly name?: unknown } | null;
  return (
    [
      "edge_upgrade_required",
      "center_upgrade_required",
      "replica_duplicate_connection",
      "invalid_frame",
      "replica_protocol_error",
      "replica_quota_exceeded",
      "replica_apply_failed",
      "ENOSPC",
      "EDQUOT",
    ].includes(String(observed?.code)) ||
    (error instanceof Error && observed?.name === "TaskLifecycleContractError")
  );
}

export function replicaRetryDelay(error: unknown, failures: number, random = Math.random()): number | null {
  if (isDeterministicReplicaFailure(error))
    return failures >= 2 ? null : 5 * 60_000 * 2 ** failures + Math.floor(random * 30_000);
  return Math.floor(random * (Math.min(30_000, 250 * 2 ** Math.min(failures, 7)) + 1));
}
