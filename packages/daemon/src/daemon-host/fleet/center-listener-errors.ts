import { FleetFault } from "./center-types.ts";
import type { ReplicationPeer } from "../../fleet-sync/fleet/protocol.ts";

export function fleetErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export async function sendCenterMovedReplicaReject(input: {
  readonly peer: ReplicationPeer;
  readonly error: unknown;
  readonly centerBuildCommit: string | null;
  readonly taskEventShapeVersion: number;
}): Promise<void> {
  if (!(input.error instanceof FleetFault) || input.error.code !== "CENTER_MOVED") return;
  await input.peer.send({
    type: "replica.reject",
    code: input.error.code,
    message: input.error.message,
    centerBuildCommit: input.centerBuildCommit,
    taskEventShapeVersion: input.taskEventShapeVersion,
  });
}
