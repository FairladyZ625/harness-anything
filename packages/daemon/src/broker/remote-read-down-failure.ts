import {
  AuthorityReadDownRequestError,
  AuthorityTransportDisconnectedError
} from "../transport/persistent-ssh-authority-client.ts";
import { RemoteReplicaResyncRequiredError } from "./remote-read-down-contract.ts";

export type RemoteReadDownFailureKind = "RESYNC" | "TRANSIENT" | "TERMINAL";

export class RemoteReadDownIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteReadDownIntegrityError";
  }
}

export function classifyRemoteReadDownFailure(error: unknown): RemoteReadDownFailureKind {
  if (error instanceof RemoteReplicaResyncRequiredError) return "RESYNC";
  if (error instanceof AuthorityTransportDisconnectedError) return "TRANSIENT";
  if (error instanceof AuthorityReadDownRequestError) {
    return error.code === "RESYNC_REQUIRED" || error.code === "SNAPSHOT_EXPIRED"
      ? "RESYNC"
      : "TERMINAL";
  }
  return "TERMINAL";
}

export function asRemoteReadDownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
