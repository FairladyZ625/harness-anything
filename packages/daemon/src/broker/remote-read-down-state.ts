import {
  RemoteReplicaResyncRequiredError,
  type ActiveSnapshot,
  type RemoteReadDownBackoff
} from "./remote-read-down-contract.ts";

export function createRemoteResyncError(
  active: ActiveSnapshot,
  message: string
): RemoteReplicaResyncRequiredError {
  return new RemoteReplicaResyncRequiredError(
    message,
    active.reservation.cut,
    active.cutChange
  );
}

export function advanceRemoteReadDownBackoff(
  delay: number,
  backoff: RemoteReadDownBackoff
): number {
  return Math.min(
    backoff.maximumMs,
    Math.max(delay + 1, Math.ceil(delay * backoff.multiplier))
  );
}
