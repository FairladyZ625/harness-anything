import { centerMovedDetails, type CenterMovedDetails } from "@harness-anything/storage";
import type { ReplicationPeer } from "../../fleet-sync/fleet/protocol.ts";

export function fleetErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function centerMovedPayloadFromError(
  error: unknown,
): { readonly message: string; readonly centerMoved?: CenterMovedDetails } | null {
  if (fleetErrorCode(error) !== "CENTER_MOVED") return null;
  const candidate = error as { readonly message?: unknown; readonly centerMoved?: unknown },
    raw = candidate.centerMoved,
    moved =
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as Partial<CenterMovedDetails>).newExternalUrl === "string" &&
      typeof (raw as Partial<CenterMovedDetails>).newLoginUrl === "string" &&
      Number.isSafeInteger((raw as Partial<CenterMovedDetails>).newEpoch) &&
      typeof (raw as Partial<CenterMovedDetails>).spkiSha256 === "string"
        ? centerMovedDetails(raw as CenterMovedDetails)
        : undefined;
  return {
    message:
      typeof candidate.message === "string" && candidate.message.length > 0
        ? candidate.message
        : "The center has moved; repoint this edge before retrying.",
    ...(moved ? { centerMoved: moved } : {}),
  };
}

export async function sendCenterMovedReplicaReject(input: {
  readonly peer: ReplicationPeer;
  readonly error: unknown;
  readonly centerBuildCommit: string | null;
  readonly taskEventShapeVersion: number;
  readonly includeCenterMovedDetails: boolean;
}): Promise<void> {
  const moved = centerMovedPayloadFromError(input.error);
  if (!moved) return;
  await input.peer.send({
    type: "replica.reject",
    code: "CENTER_MOVED",
    message: moved.message,
    centerBuildCommit: input.centerBuildCommit,
    taskEventShapeVersion: input.taskEventShapeVersion,
    ...(input.includeCenterMovedDetails && moved.centerMoved ? { centerMoved: moved.centerMoved } : {}),
  });
}

export async function sendCenterMovedReplicaFailure(input: {
  readonly peer: ReplicationPeer;
  readonly error: unknown;
  readonly includeCenterMovedDetails: boolean;
}): Promise<void> {
  const moved = centerMovedPayloadFromError(input.error);
  if (!moved) return;
  await input.peer.send({
    type: "replica.failure",
    code: "CENTER_MOVED",
    message: moved.message,
    ...(input.includeCenterMovedDetails && moved.centerMoved ? { centerMoved: moved.centerMoved } : {}),
  });
}
